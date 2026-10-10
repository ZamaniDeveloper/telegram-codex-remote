// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {turnsOf, lastTurn} from '../src/state.mjs';
import {compactState} from '../src/live-stream.mjs';
import {Outbox, isBusy} from '../src/outbox.mjs';
import {Bridge} from '../src/bridge.mjs';
import {RemoteDesktop} from '../src/remote-desktop.mjs';

const orphan=()=>({turnId:null,status:'inProgress',items:[],params:{},turnStartedAtMs:1});
test('idle orphan after a terminal turn does not hide completion; active and ambiguous starts stay blocked',()=>{
 const done={turnId:randomUUID(),status:'completed',items:[]};
 const raw={threadRuntimeStatus:{type:'idle'},turns:[done,orphan()]};
 assert.equal(lastTurn(raw),done); assert.equal(isBusy({state:raw}),false);
 assert.equal(raw.turns.length,2); // Never mutate the desktop patch mirror.
 assert.deepEqual(compactState(raw).turns,[{turnId:done.turnId,status:'completed',items:[]}]);
 const canonical={threadRuntimeStatus:{type:'idle'},turnHistory:{kind:'canonical',history:{islands:[{entries:[{value:'done'},{value:'pending'}]}],entitiesByKey:{done,pending:orphan()}}}};
 assert.equal(lastTurn(canonical),done); assert.equal(turnsOf(canonical).length,1);
 for(const runtime of [{type:'active'},undefined,{type:'unknown'}]) assert.equal(isBusy({state:{...raw,threadRuntimeStatus:runtime}}),true);
 for(const pending of [{...orphan(),turnId:randomUUID()},{...orphan(),items:[{type:'userMessage'}]}]) assert.equal(isBusy({state:{...raw,turns:[done,pending]}}),true);
 assert.equal(isBusy({state:{...raw,turns:[orphan()]}}),true);
 assert.equal(isBusy({state:{...raw,turns:[{...done,status:'inProgress'},orphan()]}}),true);
});

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'telecodex-reconnect-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ipc=new EventEmitter(), calls=[], follows=[];
 ipc.connect=async()=>{};ipc.owner=async()=> 'desktop';ipc.close=()=>{};
 ipc.request=async(method,params)=>{calls.push({method,params});return {};};
 const tg={send:async()=>({message_id:1})}, bridge=new Bridge(tg,1,ipc);
 bridge.outbox=new Outbox(path.join(root,'outbox.json'));
 const w={id:randomUUID(),title:'Test',owner:'desktop',synced:true,initialized:true,revision:1,state:{threadRuntimeStatus:{type:'active'},turns:[{turnId:randomUUID(),status:'inProgress',items:[]}]},seenTurns:new Set(),messages:new Map(),sentRequests:new Set()};
 bridge.watched.set(w.id,w);bridge.selected=w;
 ipc.follow=async(id,owner,following=true)=>{follows.push({id,owner,following});};
 return {ipc,bridge,w,calls,follows};
}

test('a fresh snapshot releases the DMC-shaped queue once, without replaying its already completed request',async t=>{
 const f=await fixture(t), first=f.bridge.outbox.enqueue(f.w,[{type:'text',text:'Already accepted'}],randomUUID());
 first.status='awaiting';first.turnId=randomUUID();f.bridge.outbox.save();
 const next=f.bridge.outbox.enqueue(f.w,[{type:'text',text:'Next request'}],randomUUID());
 await f.bridge.outbox.flush(f.bridge);assert.equal(f.calls.length,0);
 const completed={turnId:first.turnId,status:'completed',items:[{type:'userMessage',clientId:first.clientId}]};
 f.ipc.follow=async(id,owner,following=true)=>{
  f.follows.push({id,owner,following});
  if(following) f.ipc.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:owner,params:{hostId:'local',conversationId:id,change:{type:'snapshot',revision:2,conversationState:{threadRuntimeStatus:{type:'idle'},turns:[completed,orphan()]}}}});
 };
 f.w.lastSnapshotAt=Date.now()-31000;
 await f.bridge.reconnect();assert.deepEqual(f.follows.map(x=>x.following),[false,true]);
 assert.equal(f.w.synced,true);assert.equal(lastTurn(f.w.state).status,'completed');
 await f.bridge.outbox.flush(f.bridge);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].params.turnStart.request.clientUserMessageId,next.clientId);
 assert.equal(f.bridge.outbox.entries.length,1);assert.equal(next.status,'awaiting');
 await f.bridge.reconnect();await f.bridge.outbox.flush(f.bridge);
 assert.equal(f.calls.length,1);assert.equal(f.follows.length,2);
 f.ipc.emit('disconnected');assert.equal(f.w.synced,false);
 await f.bridge.reconnect();assert.deepEqual(f.follows.map(x=>x.following),[false,true,false,true]);
 await f.bridge.outbox.flush(f.bridge);assert.equal(f.calls.length,1); // Old completion does not prove next request finished.
});

test('failed or missing resnapshots never release a queue from stale idle state',async t=>{
 const f=await fixture(t);
 f.w.state={threadRuntimeStatus:{type:'idle'},turns:[{turnId:randomUUID(),status:'completed',items:[]}]};
 f.bridge.outbox.enqueue(f.w,[{type:'text',text:'Wait for fresh state'}],randomUUID());
 await f.bridge.reconnect();assert.equal(f.w.synced,false);
 await f.bridge.outbox.flush(f.bridge);assert.equal(f.calls.length,0);
 await f.bridge.reconnect();assert.equal(f.follows.length,2); // Throttle repeat reads when no snapshot arrives.
 f.w.lastResyncAttempt=0;f.ipc.follow=async()=>{throw Error('Offline');};
 await f.bridge.reconnect();assert.equal(f.w.owner,null);assert.equal(f.w.synced,false);
 await f.bridge.outbox.flush(f.bridge);assert.equal(f.calls.length,0);
});

test('a silent event connection expires, reconnects and reads again without replaying control RPCs',async t=>{
 let connections=0, controls=0;const responses=new Set();
 const server=http.createServer((req,res)=>{
  if(req.url==='/events') {connections++;responses.add(res);res.on('close',()=>responses.delete(res));res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');}
  else {controls++;res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const remote=new RemoteDesktop(`http://127.0.0.1:${server.address().port}`,'test-secret-'.repeat(5),{eventTimeoutMs:100});
 t.after(async()=>{remote.close();for(const res of responses)res.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const dropped=once(remote,'disconnected');await remote.connect();await dropped;
 assert.equal(remote.connected,false);await remote.connect();assert.equal(connections,2);assert.equal(controls,0);
});

test('event heartbeats keep an otherwise quiet connection healthy',async t=>{
 const server=http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');
  let beats=0;const interval=setInterval(()=>{res.write(': heartbeat\n\n');if(++beats===5) res.write('data: {"type":"broadcast","message":{"method":"healthy"}}\n\n');},150);
  res.on('close',()=>clearInterval(interval));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const remote=new RemoteDesktop(`http://127.0.0.1:${server.address().port}`,'test-secret-'.repeat(5),{eventTimeoutMs:500});
 t.after(async()=>{remote.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 let drops=0;remote.on('disconnected',()=>drops++);
 const message=once(remote,'broadcast');await remote.connect();assert.equal((await message)[0].method,'healthy');
 assert.equal(remote.connected,true);assert.equal(drops,0);
});
