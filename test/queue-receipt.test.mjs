// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Outbox,acceptedTurnId} from '../src/outbox.mjs';
import {compactState} from '../src/live-stream.mjs';
import {maintainBridge} from '../src/maintenance.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'telecodex-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const outbox=new Outbox(path.join(root,'outbox.json')),sent=[],calls=[];
 const w={id:randomUUID(),title:'Example',owner:'owner',synced:true,state:{threadRuntimeStatus:{type:'idle'},turns:[]}};
 const bridge={watched:new Map([[w.id,w]]),outbox,chatId:1,ipc:{request:async(...args)=>{calls.push(args);return {};}},tg:{send:async(chat,text,markup)=>{sent.push({text,markup});return {message_id:sent.length};}},refreshQueued:async()=>{}};
 const enqueue=()=>outbox.enqueue(w,[{type:'text',text:'Request'}],randomUUID());
 return {root,outbox,bridge,w,sent,calls,enqueue};
}
test('acceptance receipt persists the exact turn and reconciles an empty interrupted turn after restart',async t=>{
 const f=await fixture(t),entry=f.enqueue(),id=randomUUID();
 f.bridge.ipc.request=async(...args)=>{f.calls.push(args);return {resultType:'success',result:{result:{turn:{id,status:'inProgress'}}}};};
 await f.outbox.flush(f.bridge);assert.equal(entry.turnId,id);assert.equal(entry.status,'awaiting');
 const restored=new Outbox(f.outbox.file);f.bridge.outbox=restored;
 const next=restored.enqueue(f.w,[{type:'text',text:'Next'}],randomUUID());
 f.w.state.turns=[{turnId:id,status:'interrupted',items:[]}];
 await restored.flush(f.bridge);assert.equal(f.calls.length,2);assert.equal(restored.entries[0],next);
 await restored.flush(f.bridge);assert.equal(f.calls.length,2); // Receipt alone is not proof of completion.
});
test('only supported successful response envelopes provide a turn identity',()=>{
 const id=randomUUID();for(const r of [{result:{result:{turn:{id}}}},{result:{turn:{id}}},{turn:{id}}])assert.equal(acceptedTurnId(r),id);
 for(const r of [{resultType:'error',result:{turn:{id}}},{result:{turn:{id:'not-an-id'}}},{turnId:id},{},null])assert.equal(acceptedTurnId(r),null);
});
test('request identity survives compact projection, matches itemless completion and proves uncertain delivery without replay',async t=>{
 const f=await fixture(t),entry=f.enqueue(),next=f.enqueue();entry.status='uncertain';f.outbox.save();
 const id=randomUUID();f.w.state=compactState({threadRuntimeStatus:{type:'idle'},turns:[{turnId:id,status:'completed',items:[],params:{clientUserMessageId:entry.clientId,authorization:'SECRET',input:[{text:'PRIVATE'}]}}]});
 assert.equal(f.w.state.turns[0].clientUserMessageId,entry.clientId);assert.ok(!JSON.stringify(f.w.state).includes('SECRET'));assert.ok(!JSON.stringify(f.w.state).includes('PRIVATE'));
 await f.outbox.flush(f.bridge);assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].turnStart.request.clientUserMessageId,next.clientId);
});
test('conflicting identities and unidentified historic turns cannot clear an accepted request',async t=>{
 const f=await fixture(t),entry=f.enqueue();entry.status='awaiting';entry.turnId=randomUUID();
 f.w.state.turns=[{turnId:entry.turnId,status:'completed',clientUserMessageId:randomUUID(),items:[]}];
 await f.outbox.flush(f.bridge);assert.equal(f.outbox.entries.length,1);assert.equal(f.calls.length,0);
 delete entry.turnId;f.w.state.turns=[{turnId:randomUUID(),status:'completed',items:[]}];
 await f.outbox.flush(f.bridge);assert.equal(f.outbox.entries.length,1);assert.equal(f.calls.length,0);
});
test('legacy completion confirmation requires fresh idle state, a bound expiring token and two explicit clicks',async t=>{
 const f=await fixture(t),entry=f.enqueue(),next=f.enqueue();entry.status='awaiting';f.outbox.save();
 let reads=0;f.bridge.refreshQueued=async id=>{assert.equal(id,f.w.id);reads++;};
 await f.outbox.callback(`o:${entry.id}:review`,f.bridge);assert.equal(f.calls.length,0);assert.equal(reads,1);
 const token=f.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
 f.w.state.threadRuntimeStatus={type:'active'};
 await assert.rejects(f.outbox.callback(token,f.bridge));assert.equal(f.outbox.entries.length,2);
 f.w.state.threadRuntimeStatus={type:'idle'};
 await f.outbox.callback(`o:${entry.id}:review`,f.bridge);
 const newToken=f.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
 await f.outbox.callback(newToken,f.bridge);assert.equal(f.calls.length,1);assert.equal(f.outbox.entries[0],next);
 await assert.rejects(f.outbox.callback(newToken,f.bridge));assert.equal(f.calls.length,1);
});
test('expired confirmations, account switches and absent owner state never dispatch',async t=>{
 const f=await fixture(t),entry=f.enqueue();entry.status='awaiting';
 await f.outbox.callback(`o:${entry.id}:review`,f.bridge);
 const [token,review]=[...f.outbox.reviews][0];review.expires=Date.now()-1;
 await assert.rejects(f.outbox.callback(`o:confirm:${token}`,f.bridge));
 f.bridge.accountSwitching=true;await assert.rejects(f.outbox.callback(`o:${entry.id}:review`,f.bridge));
 f.bridge.accountSwitching=false;f.w.owner=null;await assert.rejects(f.outbox.callback(`o:${entry.id}:review`,f.bridge));assert.equal(f.calls.length,0);
});
test('Telegram delivery failures do not starve connection refresh or queue maintenance',async()=>{
 const steps=[];
 const action=name=>async()=>{steps.push(name);if(['inbox','live'].includes(name))throw Error('Telegram unavailable');};
 await maintainBridge({inbox:{flush:action('inbox')},bridge:{reconnect:action('reconnect'),outbox:{follow:action('follow'),flush:action('queue')},flush:action('live')},restore:action('restore'),ui:{accounts:{poll:action('accounts')}}});
 assert.deepEqual(steps,['inbox','reconnect','restore','live','follow','queue','accounts']);
});
