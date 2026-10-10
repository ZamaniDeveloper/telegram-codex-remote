// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { miniappConfig, validateInitData } from '../src/miniapp-auth.mjs';
import { createMiniApp, chatView } from '../src/miniapp.mjs';
import { compactState } from '../src/live-stream.mjs';
import { mainInlineKeyboard } from '../src/ui.mjs';
const token='test-token',ownerId=123,clock=1780000000000;
function signed(user={id:ownerId},date=clock/1000,extras={}) {
  const p=new URLSearchParams({auth_date:String(date),user:JSON.stringify(user),query_id:'fixture',...extras});
  const check=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(check).digest('hex'));return p.toString();
}
test('Telegram Mini App authentication verifies signature, owner, freshness and duplicate fields',()=>{
  assert.equal(validateInitData(signed(),token,ownerId,clock).id,ownerId);
  assert.equal(validateInitData(signed({id:ownerId},clock/1000,{signature:'telegram-ed25519-value'}),token,ownerId,clock).id,ownerId);
  for(const value of ['',signed({id:124}),signed({id:ownerId,is_bot:true}),signed({},clock/1000),signed(undefined,clock/1000-3601),signed(undefined,clock/1000+31),signed()+'&user={}',signed().replace('fixture','tampered')])assert.throws(()=>validateInitData(value,token,ownerId,clock));
  assert.throws(()=>validateInitData(signed(),'other-token',ownerId,clock));assert.throws(()=>validateInitData(signed(),token,0,clock));
});
test('Mini App is opt-in with HTTPS and a loopback reverse-proxy port; menu links appear only when configured',()=>{
  assert.equal(miniappConfig({}),null);assert.equal(miniappConfig({MINIAPP_URL:'https://example.com/telecodex/'}).port,27842);
  for(const url of ['http://example.com/','https://example.com/app','https://a:b@example.com/','https://example.com/?secret=1','https://127.0.0.1/','https://example.com/../app'])assert.throws(()=>miniappConfig({MINIAPP_URL:url}));
  assert.throws(()=>miniappConfig({MINIAPP_URL:'https://example.com/',MINIAPP_PORT:'0'}));
  assert.ok(!mainInlineKeyboard().inline_keyboard.flat().some(b=>b.web_app));
  assert.equal(mainInlineKeyboard('https://example.com/app/').inline_keyboard[0][0].web_app.url,'https://example.com/app/');
});
test('live projection retains file changes without approval and Mini App exposes only bounded text and diff fields',()=>{
  const raw={cwd:'project',latestModel:'model',requests:[{private:'secret'}],turns:[{id:randomUUID(),status:'inProgress',items:[{type:'mcpToolCall',result:'private tool output'},{type:'userMessage',text:'<script>unsafe</script>'},{type:'agentMessage',text:'A'.repeat(50010)},{type:'fileChange',changes:[{path:'app.js',kind:{type:'update'},diff:'-old\n+new',private:'hidden'}]}]}]};
  const state=compactState(raw);assert.ok(state.turns[0].items.some(i=>i.type==='fileChange'));
  const view=chatView({id:randomUUID(),title:'Chat',state,synced:true},{count:()=>2});assert.equal(view.messages[1].text.length,50000);assert.equal(view.messages[1].truncated,true);assert.equal(view.changes[0].diff,'-old\n+new');assert.equal(view.waiting,2);
  assert.ok(!JSON.stringify(view).includes('private'));assert.ok(!JSON.stringify(view).includes('tool output'));
});
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'telecodex-miniapp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const id=randomUUID(),other=randomUUID(),turnId=randomUUID(),calls=[];
  const watched={id,title:'Main chat',synced:true,state:{cwd:'C:/project',turns:[{id:turnId,status:'inProgress',items:[{type:'agentMessage',text:'Hello'}]}]}};
  const entry={id:randomUUID(),threadId:id,title:'Queue',status:'queued',input:[{type:'text',text:'waiting'}],createdAt:clock};
  const bridge={chatId:ownerId,selected:watched,watched:new Map([[id,watched]]),outbox:{entries:[entry],count:()=>1,callback:async data=>{calls.push(['cancel',data]);}},catalog:async(q,limit,offset)=>{calls.push(['catalog',q,limit,offset]);return[{id,title:'Main chat',cwd:'C:/project'},{id:other,title:'Other',cwd:'C:/other'}];},select:async row=>{calls.push(['select',row]);bridge.selected=bridge.watched.get(row.id)||{...row,synced:true,state:{turns:[]}};},sendInput:async(input,thread,key)=>{calls.push(['send',input,thread,key]);return{queued:true,entry:{id:entry.id}};},stopTurn:async(...args)=>{calls.push(['stop',...args]);},steer:async(...args)=>{calls.push(['steer',...args]);}};
  const ui={inbox:{current:null},features:{rpc:async(method,...args)=>{calls.push([method,...args]);return method==='projects'?[{id:other,name:'Project',roots:[{path:'C:/other'}]}]:method==='latestMessage'?{role:'Codex',text:'Last'}:{id:other,title:'Created'};}}};
  const config=miniappConfig({MINIAPP_URL:'https://example.com/telecodex/'}),root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),journal=path.join(dir,'actions');
  function server(){return createMiniApp({config,token,getBridge:()=>bridge,getUi:()=>ui,root,journal,now:()=>clock});}
  const app=server();await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>{app.closeAllConnections();app.close();});
  const base=`http://127.0.0.1:${app.address().port}/telecodex/`;
  async function request(route,body,headers={}){return fetch(base+route,{method:body?'POST':'GET',headers:{'x-telegram-init-data':signed(),...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});}
  return{app,server,request,base,bridge,ui,id,other,turnId,calls,entry,journal};
}
test('real HTTP endpoints keep private data behind Telegram owner authentication and enforce origin/method/path bounds',async t=>{
  const f=await fixture(t);
  const page=await fetch(f.base);assert.equal(page.status,200);assert.match(await page.text(),/telegram-web-app.js/);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  assert.equal((await fetch(f.base+'api/state')).status,401);assert.equal((await f.request('api/state',null,{origin:'https://evil.example'})).status,401);
  assert.equal((await f.request('api/state',null,{'x-telegram-init-data':signed({id:999})})).status,401);
  assert.equal((await f.request('api/state')).status,200);assert.equal((await f.request('api/chats?offset=-1')).status,409);
  assert.equal((await f.request('../.env')).status,404);assert.equal((await f.request('api/accountActivate',{})).status,405);
  const rows=(await(await f.request('api/chats?q=Other&offset=0')).json()).result.rows;assert.equal(rows.length,2);
  assert.equal((await(await f.request('api/projects')).json()).result.rows[0].name,'Project');
  assert.equal((await(await f.request('api/queue')).json()).result.entries[0].preview,'waiting');
  assert.equal((await(await f.request('api/last?id='+f.other)).json()).result.message.text,'Last');assert.equal(f.bridge.selected.id,f.id);
});
test('Mini App actions bind chat and turn, persist intent before dispatch, and deduplicate across server restarts',async t=>{
  const f=await fixture(t),key=randomUUID(),input={key,action:'send',threadId:f.id,text:'One request'};
  assert.equal((await f.request('api/action',input)).status,200);assert.equal((await f.request('api/action',input)).status,200);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
  assert.equal((await f.request('api/action',{...input,text:'Changed'})).status,409);
  const again=f.server();await new Promise(r=>again.listen(0,'127.0.0.1',r));t.after(()=>{again.closeAllConnections();again.close();});
  const replay=await fetch(`http://127.0.0.1:${again.address().port}/telecodex/api/action`,{method:'POST',headers:{'x-telegram-init-data':signed(),'content-type':'application/json'},body:JSON.stringify(input)});assert.equal(replay.status,200);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
  assert.equal((await f.request('api/action',{...input,key:randomUUID(),threadId:f.other})).status,409);
  await f.request('api/action',{key:randomUUID(),action:'stop',threadId:f.id,turnId:f.turnId});assert.deepEqual(f.calls.find(c=>c[0]==='stop').slice(1),[f.id,f.turnId]);
  await f.request('api/action',{key:randomUUID(),action:'cancel',entryId:f.entry.id});assert.ok(f.calls.some(c=>c[0]==='cancel'));
  f.ui.inbox.current={id:'draft'};assert.equal((await f.request('api/action',{...input,key:randomUUID()})).status,409);
  f.bridge.accountSwitching=true;assert.equal((await f.request('api/action',{key:randomUUID(),action:'select',threadId:f.other})).status,409);
});
test('ambiguous model delivery is never replayed and selection ignores client-supplied title and path',async t=>{
  const f=await fixture(t);let dispatched=0;
  f.bridge.sendInput=async()=>{dispatched++;throw Error('Network unknown with PRIVATE_TOKEN');};
  const input={key:randomUUID(),action:'send',threadId:f.id,text:'Once'};
  const first=await f.request('api/action',input);assert.equal(first.status,409);assert.ok(!(await first.text()).includes('PRIVATE_TOKEN'));
  const second=await f.request('api/action',input);assert.equal((await second.json()).error,'Action outcome unknown');assert.equal(dispatched,1);
  const saved=JSON.parse(await readFile(path.join(f.journal,input.key+'.json'),'utf8'));assert.equal(saved.status,'started');assert.equal(saved.text,undefined);
  await f.request('api/action',{key:randomUUID(),action:'select',threadId:f.other,title:'Forged title',cwd:'C:/secret'});
  const selection=f.calls.find(c=>c[0]==='select')[1];assert.equal(selection.title,'Other');assert.equal(selection.cwd,'C:/other');
});
