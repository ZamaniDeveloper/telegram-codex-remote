// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateInitData } from './miniapp-auth.mjs';
import { lastTurn, turnId, turnsOf } from './state.mjs';
import { messageFromItem } from './latest-message.mjs';
import { isBusy } from './outbox.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (s, n = 50000) => typeof s === 'string' ? s.slice(0,n) : '';
const rowView = r => ({ id:r.id, title:clip(r.title || r.name || r.id,200), cwd:clip(r.cwd,1000) });
export function chatView(w, outbox, details = true) {
  const turn = lastTurn(w.state);
  const messages = details ? turnsOf(w.state).slice(-12).flatMap(t => (t.items || []).map(messageFromItem).filter(Boolean)).slice(-40).map(m => ({role:m.role,text:clip(m.text),truncated:m.text.length>50000})) : [];
  const changes = details ? (turn?.items || []).filter(i => i.type === 'fileChange').flatMap(i => (i.changes || []).map(c => ({path:clip(c.path,1000),kind:clip(typeof c.kind === 'string' ? c.kind : c.kind?.type,40),diff:clip(c.diff),truncated:(c.diff?.length || 0)>50000}))).slice(0,50) : [];
  return { ...rowView(w), cwd:clip(w.state?.cwd,1000), model:clip(w.state?.latestModel,150), synced:Boolean(w.synced), busy:isBusy(w), turnId:turnId(turn) || null, status:turn?.status || 'idle', waiting:outbox?.count(w.id) || 0, messages, changes };
}
export function createMiniApp({ config, token, getBridge, getUi, root, journal, now = Date.now }) {
  const actions = new Map(); let mutation = false, rateAt = now(), requests = 0;
  const json = (res,status,data) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
  async function body(req) {
    let text = ''; for await (const part of req) { text += part; if (Buffer.byteLength(text)>65536) throw Error('Invalid request'); }
    const value=JSON.parse(text); if(!value || Array.isArray(value) || typeof value!=='object') throw Error('Invalid request');return value;
  }
  async function catalog(bridge,search='',offset=0) { return bridge.catalog(search,21,offset); }
  async function find(bridge,id) {
    if(!ID.test(id || '')) throw Error('Invalid request');
    const watched=bridge.watched.get(id); if(watched) return rowView(watched);
    // Resolve identity against the real catalog; client-provided titles/paths are never trusted.
    for(let offset=0;offset<10000;offset+=100){const rows=await bridge.catalog('',100,offset);const row=rows.find(r=>r.id===id);if(row)return rowView(row);if(rows.length<100)break;}
    throw Error('Conversation unavailable');
  }
  async function read(route, url, bridge) {
    if(route==='state') {
      const focus=url.searchParams.get('id') || bridge.selected?.id;
      if(focus && !ID.test(focus))throw Error('Invalid request');
      return { selectedId:bridge.selected?.id || null, connected:Boolean(bridge.selected?.synced), switching:Boolean(bridge.accountSwitching), waiting:bridge.outbox?.count() || 0, chats:[...bridge.watched.values()].map(w=>chatView(w,bridge.outbox,w.id===focus)) };
    }
    if(route==='chats') { const search=clip(url.searchParams.get('q'),200),offset=Number(url.searchParams.get('offset') || 0);if(!Number.isInteger(offset)||offset<0||offset>10000)throw Error('Invalid request');const rows=await catalog(bridge,search,offset);return{rows:rows.slice(0,20).map(rowView),more:rows.length>20,offset}; }
    if(route==='projects') { const rows=await getUi().features.rpc('projects');return{rows:rows.map(p=>({id:p.id,name:clip(p.name,200),roots:(p.roots || []).map(r=>({path:clip(r.path,1000)}))}))}; }
    if(route==='queue') return { waiting:bridge.outbox?.count() || 0, entries:(bridge.outbox?.entries || []).map(e=>({id:e.id,threadId:e.threadId,title:clip(e.title,200),status:e.status,createdAt:e.createdAt,preview:clip(e.input.filter(i=>i.type==='text').map(i=>i.text).join('\n'),2000)})) };
    if(route==='last') { const row=await find(bridge,url.searchParams.get('id'));const last=await getUi().features.rpc('latestMessage',row.id);return{row,message:last?{role:last.role,text:clip(last.text),truncated:last.text.length>50000}:null}; }
    throw Error('Not found');
  }
  async function perform(value,bridge) {
    const ui=getUi();
    if(bridge.accountSwitching) throw Error('Account switching');
    if(value.action==='select') { const row=await find(bridge,value.threadId);await bridge.select(row,{notify:false});if(bridge.selected?.id!==row.id)throw Error('Selection changed');return {selectedId:row.id}; }
    if(value.action==='cancel') { if(!ID.test(value.entryId || ''))throw Error('Invalid request');await bridge.outbox.callback(`o:${value.entryId}:cancel`,bridge);return{removed:true}; }
    if(value.action==='create') { if(!ID.test(value.projectId || '') || typeof value.name!=='string' || !value.name.trim() || value.name.length>120 || ui.inbox.current)throw Error('Invalid request');return ui.features.rpc('createChat',{kind:'chat',key:value.key,name:value.name.trim(),projectId:value.projectId}); }
    if(!ID.test(value.threadId || '') || bridge.selected?.id!==value.threadId)throw Error('Selection changed');
    if(value.action==='send') { if(typeof value.text!=='string'||!value.text.trim()||value.text.length>30000||ui.inbox.current)throw Error('Invalid request');const result=await bridge.sendInput([{type:'text',text:value.text}],value.threadId,value.key);return{queued:result.queued,entryId:result.entry?.id}; }
    if(value.action==='stop') { if(!ID.test(value.turnId || ''))throw Error('Invalid request');await bridge.stopTurn(value.threadId,value.turnId);return{sent:true}; }
    if(value.action==='steer') { if(!ID.test(value.turnId || '') || typeof value.text!=='string'||!value.text.trim()||value.text.length>30000)throw Error('Invalid request');await bridge.steer(value.text,value.threadId,value.turnId);return{sent:true}; }
    throw Error('Invalid request');
  }
  async function mutate(value,bridge) {
    if(!ID.test(value.key || '') || !['select','cancel','create','send','stop','steer'].includes(value.action))throw Error('Invalid request');
    const digest=createHash('sha256').update(JSON.stringify(value)).digest('hex'),file=path.join(journal,value.key+'.json');
    let previous=actions.get(value.key);
    if(!previous){try{previous=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Action unavailable');}}
    if(previous){if(previous.digest!==digest)throw Error('Action conflict');if(previous.status==='complete')return previous.result;throw Error('Action outcome unknown');}
    if(mutation)throw Error('Action in progress');mutation=true;
    try{
      await mkdir(journal,{recursive:true,mode:0o700});
      const record={digest,status:'started'};
      await writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});actions.set(value.key,record);
      const result=await perform(value,bridge);
      record.status='complete';record.result=result;await writeFile(file,JSON.stringify(record),{mode:0o600});
      if(actions.size>500)actions.delete(actions.keys().next().value);
      return result;
    }finally{mutation=false;}
  }
  const files={'':'index.html','app.mjs':'app.mjs','app.css':'app.css','text.mjs':'text.mjs','logo.jpg':'../assets/telecodex-logo.jpg'};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-robots-tag','noindex, nofollow');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'");
    let url;try{url=new URL(req.url,'https://localhost');}catch{return json(res,400,{error:'Invalid request'});}
    if(!url.pathname.startsWith(config.base))return json(res,404,{error:'Not found'});
    const route=url.pathname.slice(config.base.length);
    if(req.method==='GET' && Object.hasOwn(files,route)){
      try{const content=await readFile(path.join(root,'web',files[route]));res.setHeader('content-type',route.endsWith('.mjs')?'text/javascript; charset=utf-8':route.endsWith('.css')?'text/css; charset=utf-8':route.endsWith('.jpg')?'image/jpeg':'text/html; charset=utf-8');return res.end(content);}catch{return json(res,404,{error:'Not found'});}
    }
    if(!route.startsWith('api/'))return json(res,404,{error:'Not found'});
    const bridge=getBridge();if(!bridge)return json(res,503,{error:'Not ready'});
    try{if(req.headers.origin && req.headers.origin!==config.origin)throw Error('Unauthorized');validateInitData(req.headers['x-telegram-init-data'],token,bridge.chatId,now());}catch{return json(res,401,{error:'Unauthorized'});}
    if(now()-rateAt>60000){rateAt=now();requests=0;}if(++requests>600)return json(res,429,{error:'Rate limited'});
    try{
      if(req.method==='GET')return json(res,200,{result:await read(route.slice(4),url,bridge)});
      if(req.method==='POST' && route==='api/action' && req.headers['content-type']?.split(';')[0]==='application/json')return json(res,200,{result:await mutate(await body(req),bridge)});
      return json(res,405,{error:'Method not allowed'});
    }catch(error){const allowed=['Invalid request','Not found','Conversation unavailable','Selection changed','Action conflict','Action outcome unknown','Action in progress','Account switching'];return json(res,409,{error:allowed.includes(error?.message)?error.message:'Action unavailable'});}
  });
  server.requestTimeout=200000;server.headersTimeout=10000;
  return server;
}
