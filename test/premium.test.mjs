// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Premium } from '../src/premium.mjs';
import { Telegram } from '../src/telegram.mjs';
import { card } from '../src/format.mjs';
import { PremiumUi } from '../src/premium-ui.mjs';
const icons = [{ emoji:'🤖',id:'123' },{ emoji:'⚡️',id:'456' },{emoji:'🏠',id:'789'}];
const state = () => ({ownerId:1,known:true,userPremium:true,icons,catalogAt:1000});
const update = user => ({message:{from:user,chat:{id:1,type:'private'}}});
function fixture(call=async()=>({})) { let time=1000;const saved=[];const tg={call};const profile=new Premium(tg,1,{state:state(),now:()=>time,save:s=>saved.push(structuredClone(s))});return{profile,saved,advance:ms=>{time+=ms;}}; }

test('premium status is derived only from the authenticated private owner, including callbacks', () => {
  const {profile}=fixture();assert.equal(profile.observe(update({id:2,is_premium:true})),false);
  assert.equal(profile.observe({message:{from:{id:1,is_premium:true},chat:{id:1,type:'group'}}}),false);
  profile.observe({...update({id:1}),message:{...update({id:1}).message,forward_origin:{sender_user:{id:2,is_premium:true}}}});
  assert.equal(profile.state.userPremium,false);
  profile.observe({callback_query:{from:{id:1,is_premium:true},message:{chat:{id:1,type:'private'}}}});assert.equal(profile.state.userPremium,true);
});
test('owner changes invalidate cached premium status and malformed icons cannot be restored', () => {
  const p=new Premium({},2,{state:state()});assert.equal(p.state.known,false);assert.deepEqual(p.state.icons,[]);
  const q=new Premium({},1,{state:{...state(),icons:[...icons,{emoji:'not an emoji',id:'999'},{emoji:'🤖',id:'unsafe'}]}});
  assert.deepEqual(q.state.icons,icons);
});
test('catalog refresh is single-flight and uses official sticker metadata without leaking user records', async () => {
  let calls=0,finish;
  const {profile,saved}=fixture(()=>{calls++;return new Promise(r=>{finish=r;});});profile.state.icons=[];
  const a=profile.prepare(),b=profile.prepare();finish([{emoji:'🤖',custom_emoji_id:'123'},{emoji:'Invalid',custom_emoji_id:'456'}]);await Promise.all([a,b]);
  assert.equal(calls,1);assert.deepEqual(profile.state.icons,[icons[0]]);assert.ok(!JSON.stringify(saved).includes('first_name'));
  await profile.prepare();assert.equal(calls,1);
});
test('header decoration preserves UTF-16 entity offsets, buttons and caller data', () => {
  const {profile}=fixture();const value=card('⚡ Test','Code 👋');const params={chat_id:1,text:value.text,entities:value.entities,reply_markup:{inline_keyboard:[[{text:'🏠 Home',callback_data:'u:home',style:'primary'}]],force_reply:true}};
  const before=structuredClone(params),out=profile.decorate('sendMessage',params);
  assert.equal(out.text,'⚡️ Test\n\nCode 👋');assert.ok(out.entities.some(e=>e.type==='custom_emoji'&&e.length===2&&e.custom_emoji_id==='456'));
  assert.equal(out.entities.find(e=>e.type==='bold').length,value.entities[0].length+1);
  assert.deepEqual(out.reply_markup.inline_keyboard[0][0],{text:'Home',callback_data:'u:home',style:'primary',icon_custom_emoji_id:'789'});
  assert.equal(out.reply_markup.force_reply,true);assert.deepEqual(params,before);
});
test('non-premium users, other chats, disabled visuals, code and reply-keyboard labels remain plain', async () => {
  const {profile}=fixture();const params={chat_id:1,text:'🤖 Code',entities:[{type:'pre',offset:0,length:7}],reply_markup:{keyboard:[[{text:'🏠 Home'}]]}};
  assert.equal(profile.decorate('sendMessage',params),params);
  assert.equal(profile.decorate('sendMessage',{...params,chat_id:2}).text,params.text);
  profile.state.userPremium=false;assert.equal(profile.decorate('sendMessage',{chat_id:1,text:'🤖 Test'}).entities,undefined);
  profile.state.userPremium=true;await profile.toggle();assert.equal(profile.state.enabled,false);assert.equal(profile.decorate('sendMessage',{chat_id:1,text:'🤖 Test'}).entities,undefined);
});
test('explicit cosmetic rejection falls back once; subsequent delivery stays plain until refresh', async () => {
  const calls=[];const {profile}=fixture(async(method,params)=>{calls.push(params);if(params.entities?.some(e=>e.type==='custom_emoji'))throw Object.assign(Error('CUSTOM_EMOJI_NOT_ALLOWED'),{errorCode:400});return {message_id:7};});
  const params={chat_id:1,text:'🤖 Test'};assert.equal((await profile.deliver('sendMessage',params)).message_id,7);
  assert.equal(calls.length,2);assert.equal(calls[1],params);assert.equal(profile.state.customAllowed,false);
  await profile.deliver('sendMessage',params);assert.equal(calls.length,3);assert.equal(calls[2],params);
});
test('unknown, server, rate-limit and non-cosmetic errors never repeat a send', async () => {
  for(const error of [Error('Network outcome unknown'),Object.assign(Error('Server error'),{errorCode:500}),Object.assign(Error('Rate limit'),{errorCode:429}),Object.assign(Error('chat not found'),{errorCode:400})]){
    let calls=0;const{profile}=fixture(async()=>{calls++;throw error;});await assert.rejects(profile.deliver('sendMessage',{chat_id:1,text:'🤖 Test'}));assert.equal(calls,1);
  }
});
test('accepted custom entities activate visuals; ignored entities suspend cosmetic attempts', async () => {
  const a=fixture(async(_,p)=>({message_id:1,entities:p.entities})).profile;
  await a.deliver('sendMessage',{chat_id:1,text:'🤖 Test'});assert.equal(a.state.customAllowed,true);
  const b=fixture(async()=>({message_id:1})).profile;
  await b.deliver('sendMessage',{chat_id:1,text:'🤖 Test'});assert.equal(b.state.customAllowed,false);assert.ok(b.state.blockedUntil>1000);
});
test('ignored decorations renew their cooldown after expiry and a subscription change resets permission', async () => {
  const {profile,advance}=fixture(async()=>({message_id:1}));
  await profile.deliver('sendMessage',{chat_id:1,text:'🤖 Test'});const firstDeadline=profile.state.blockedUntil;
  advance(3600001);await profile.deliver('sendMessage',{chat_id:1,text:'🤖 Test'});
  assert.ok(profile.state.blockedUntil>firstDeadline);
  profile.observe(update({id:1}));assert.equal(profile.state.userPremium,false);
  profile.observe(update({id:1,is_premium:true}));assert.equal(profile.state.blockedUntil,0);assert.equal(profile.state.customAllowed,null);
});
test('failed status lookup preserves known Premium metadata and fresh user updates remain authoritative', async () => {
  const {profile}=fixture(async()=>{throw Error('Unavailable');});
  await profile.refresh();assert.equal(profile.state.userPremium,true);
  profile.observe(update({id:1}));await profile.refresh();assert.equal(profile.state.userPremium,false);
});
test('received effects are used only for private premium confirmations and never from forwards', async () => {
  const{profile}=fixture();profile.observe({...update({id:1,is_premium:true}),message:{...update({id:1,is_premium:true}).message,effect_id:'998'}});
  assert.equal(profile.decorate('sendMessage',{chat_id:1,text:'✅ Confirmed'}).message_effect_id,'998');
  assert.equal(profile.decorate('sendMessage',{chat_id:1,text:'🤖 Progress'}).message_effect_id,undefined);
  assert.equal(profile.decorate('editMessageText',{chat_id:1,text:'✅ Done'}).message_effect_id,undefined);
  profile.observe({message:{...update({id:1,is_premium:true}).message,effect_id:'887',forward_origin:{type:'hidden_user'}}});assert.equal(profile.state.effectId,'998');
  profile.observe(update({id:1}));assert.equal(profile.decorate('sendMessage',{chat_id:1,text:'✅ Confirmed'}).message_effect_id,undefined);
});
test('rejected effects fall back without disabling valid custom emoji or using paid broadcast', async () => {
  let calls=0;const{profile}=fixture(async(_,p)=>{calls++;assert.equal(p.allow_paid_broadcast,undefined);if(p.message_effect_id)throw Object.assign(Error('EFFECT_ID_INVALID'),{errorCode:400});return{message_id:1};});
  profile.state.effectId='998';await profile.deliver('sendMessage',{chat_id:1,text:'✅ Confirmed'});assert.equal(calls,2);assert.equal(profile.state.effectId,null);assert.equal(profile.state.customAllowed,null);
});
test('Telegram send and edit share premium rendering while targeting the same pinned message', async () => {
  const calls=[];const tg=new Telegram('fixture',async(_,options)=>{const p=JSON.parse(options.body);calls.push(p);return{json:async()=>({ok:true,result:{message_id:10,entities:p.entities}})};});
  tg.premium=new Premium(tg,1,{state:state(),now:()=>1000});await tg.send(1,card('🤖 Progress','Work'));await tg.edit(1,10,card('🤖 Done','Result'));
  assert.ok(calls.every(c=>c.entities.some(e=>e.type==='custom_emoji')));assert.equal(calls[1].message_id,10);
  assert.ok(calls.every(c=>c.allow_paid_broadcast===undefined));
});
test('premium screen refresh and toggles require no model or account operation', async () => {
  const sent=[],calls=[];const tg={call:async(method)=>{calls.push(method);return{user:{id:1,is_premium:true}};},send:async(_,value,markup)=>{sent.push({value,markup});}};
  const profile=new Premium(tg,1,{state:state(),now:()=>1000});const ui=new PremiumUi({tg,chatId:1,premium:profile});
  await ui.show(true);assert.deepEqual(calls,['getChatMember']);await ui.toggle();assert.equal(profile.state.enabled,false);
  assert.ok(sent.at(-1).markup.inline_keyboard.flat().some(b=>b.callback_data==='u:premium-toggle'));
});
