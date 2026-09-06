#!/usr/bin/env node
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stateDir, logFile, serveControl } from './lifecycle.js';
import { config } from './config.js';
import WebSocket from 'ws';
import { Assembly, frames, parseFrame, MAX_BYTES } from './relay-protocol.js';

interface Settings { workerUrl: string; agentToken: string; mcpToken: string; deviceId?: string }
const DEFAULT_PUBLIC_WORKER_URL='https://localmcp-relay.daodao973597.workers.dev';

await mkdir(stateDir,{recursive:true,mode:0o700});
const pidFile=resolve(stateDir,'agent.pid');
let closing = false, ready = false, mcpUrl: string | null = null;
let local: ChildProcess | undefined, socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
let reloading: Promise<void> | undefined;
const closeControl = await serveControl(() => ({status: 'running', pid: process.pid, url: mcpUrl,
  config: resolve(process.env.LOCALMCP_CONFIG || resolve(stateDir, 'localmcp.json')), log: logFile, ready}),
  () => stop(), () => reloading ??= reloadLocal().finally(() => {reloading = undefined;}));
await writeFile(pidFile,String(process.pid),{mode:0o600});
process.once('SIGINT',()=>stop()); process.once('SIGTERM',()=>stop());
process.on('SIGHUP',()=>{if(!reloading) reloading=reloadLocal().catch(error=>console.error(error.message)).finally(()=>{reloading=undefined;});});
process.on('uncaughtException', error=>{console.error(error);stop(1);});
process.on('unhandledRejection', error=>{console.error(error);stop(1);});
const workerFile=resolve(stateDir,'worker.json');
let settings:Settings;
try{settings=JSON.parse(await readFile(workerFile,'utf8'));}
catch(error:any){
  if(error.code!=='ENOENT')throw error;
  const workerUrl=process.env.LOCALMCP_WORKER_URL||DEFAULT_PUBLIC_WORKER_URL;
  const response=await fetch(new URL('/register',workerUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Public Worker registration failed (${response.status}). Set LOCALMCP_WORKER_URL to a self-hosted Worker if needed.`);
  const registered=await response.json() as Settings;
  settings={workerUrl:registered.workerUrl,agentToken:registered.agentToken,mcpToken:registered.mcpToken,deviceId:registered.deviceId};
  await writeFile(workerFile,JSON.stringify(settings,null,2),{mode:0o600});
  console.error(`Registered LocalMCP device ${settings.deviceId}.`);
}
const origin = new URL(process.env.LOCALMCP_WORKER_URL || settings.workerUrl);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) throw new Error('Worker URL must use HTTPS');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Worker URL must be an origin');
const localToken = randomBytes(32).toString('hex');
async function findFreePort(){
  if(process.env.LOCALMCP_AGENT_PORT)return Number(process.env.LOCALMCP_AGENT_PORT);
  return await new Promise<number>((resolvePort,reject)=>{
    const server=createNetServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(!address||typeof address==='string'){server.close();reject(new Error('Unable to allocate local port'));return;}
      const selected=address.port;
      server.close(error=>error?reject(error):resolvePort(selected));
    });
  });
}
const port = await findFreePort();

function spawnLocal(){return spawn(process.execPath,[fileURLToPath(new URL('./index.js',import.meta.url)),'http'],{env:{...process.env,LOCALMCP_PORT:String(port),LOCALMCP_TOKEN:localToken,LOCALMCP_INTERNAL:'1'},stdio:['ignore','ignore','inherit']});}
function watchLocal(child:ChildProcess){child.on('error',error=>{console.error(error.message);stop(1);});child.on('exit',code=>{if(!closing&&!reloading&&child===local){console.error(`Local server exited (${code})`);stop(1);}});}
local=spawnLocal();watchLocal(local);
function stop(code=0) {
  if (closing) return; closing=true; ready=false; clearTimeout(reconnect); socket?.terminate(); local?.kill('SIGTERM');
  setTimeout(async () => {
    local?.kill('SIGKILL');
    await unlink(pidFile).catch(()=>{});
    await closeControl();
    process.exit(code);
  },1500);
}
async function reloadLocal() {
  if (closing || !local) throw new Error('LocalMCP is not ready');
  // Validate before interrupting the working server.
  await config();
  const previous = local;
  await new Promise<void>(done => {
    const timer = setTimeout(() => previous.kill('SIGKILL'), 5000);
    previous.once('exit', () => {clearTimeout(timer);done();});
    previous.kill('SIGTERM');
  });
  if (closing) throw new Error('LocalMCP is stopping');
  local=spawnLocal();watchLocal(local);
  const deadline=Date.now()+10000;
  while(Date.now()<deadline&&!closing) {
    if (local.exitCode !== null || local.signalCode !== null) break;
    try {const r=await fetch(`http://127.0.0.1:${port}/mcp`,{headers:{Authorization:`Bearer ${localToken}`},signal:AbortSignal.timeout(500)});if(r.status===405){console.error('LocalMCP configuration reloaded.');return;}} catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  stop(1);
  throw new Error('Reload failed; see ' + logFile);
}
let localReady=false;
for (let i=0;i<100 && !closing;i++) {
  try {const r=await fetch(`http://127.0.0.1:${port}/mcp`,{headers:{Authorization:`Bearer ${localToken}`},signal:AbortSignal.timeout(500)});if(r.status===405){localReady=true;break;}} catch {}
  await new Promise(r=>setTimeout(r,100));
}
if (!localReady || closing) {stop(1);} else {
  let attempt=0, busy=false;
  const mcpPath=settings.deviceId?`/mcp/${settings.deviceId}/${settings.mcpToken}`:`/mcp/${settings.mcpToken}`;
  mcpUrl=new URL(mcpPath,origin).href;
  await writeFile(resolve(stateDir,'connection.json'),JSON.stringify({url:mcpUrl,authentication:'none',transport:'worker-websocket',deviceId:settings.deviceId,root:process.env.LOCALMCP_ROOT||process.cwd()},null,2),{mode:0o600});
  const wsUrl=new URL(settings.deviceId?`/agent/${settings.deviceId}`:'/agent',origin);wsUrl.protocol=origin.protocol==='https:'?'wss:':'ws:';
  function connect() {
    if (closing) return;
    const ws=new WebSocket(wsUrl,{headers:{Authorization:`Bearer ${settings.agentToken}`},handshakeTimeout:15000,maxPayload:160000});socket=ws;
    let assembly: Assembly | undefined, requestId: string | undefined, pong=Date.now();
    const heartbeat=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN)return;if(Date.now()-pong>65000){ws.terminate();return;}ws.send('ping');},25000);
    ws.on('open',()=>{ready=true;attempt=0; console.log(`LocalMCP is running\n\nMCP URL:\n${mcpUrl}\n\nAuthentication: None\nConfig: ~/.localmcp/localmcp.json\n\nUse localmcp stop to stop.`);});
    const respond=(id:string,value:unknown)=>{if(ws.readyState===WebSocket.OPEN)for(const frame of frames(id,value))ws.send(frame);};
    ws.on('message', async raw=>{
      const message=raw.toString();if(message==='pong'){pong=Date.now();return;}
      try {
        const f=parseFrame(message);
        if(!assembly){if(busy){respond(f.id,{status:429,body:JSON.stringify({error:'Local execution still in progress; do not retry automatically.'})});return;}assembly=new Assembly();requestId=f.id;}
        if(requestId!==f.id)throw new Error('Overlapping requests');
        const complete=assembly.push(f);if(!complete)return;
        assembly=undefined;requestId=undefined;
        const data=complete.value as {body:string;protocolVersion?:string};
        if(!data||typeof data.body!=='string'||Buffer.byteLength(data.body)>2*1024*1024)throw new Error('Invalid request body');
        JSON.parse(data.body);busy=true;
        try {
          const headers:Record<string,string>={'Content-Type':'application/json','Accept':'application/json, text/event-stream',Authorization:`Bearer ${localToken}`};
          if(data.protocolVersion)headers['MCP-Protocol-Version']=data.protocolVersion;
          const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers,body:data.body,signal:AbortSignal.timeout(125000)});
          // Bound response allocation, including computer-use image results.
          const reader=r.body?.getReader();let body='',bytes=0;const decoder=new TextDecoder();
          if(reader)try {while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>MAX_BYTES-1024){await reader.cancel();throw new Error('Tool response exceeds relay limit');}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}finally{reader.releaseLock();}
          respond(f.id,{status:r.status,body});
        } catch {respond(f.id,{status:502,body:JSON.stringify({error:'Local call failed or timed out. Outcome may be unknown; do not automatically retry.'})});}
        finally {busy=false;}
      } catch {ws.close(1008,'Invalid relay request');}
    });
    ws.on('error',error=>console.error(`Worker connection error: ${error.message}`));
    ws.on('close',()=>{ready=false;clearInterval(heartbeat);if(!closing){const delay=Math.min(30000,1000*2**Math.min(attempt++,5))+Math.random()*1000;console.error(`Worker disconnected; reconnecting in ${Math.ceil(delay/1000)}s. Requests are not replayed.`);reconnect=setTimeout(connect,delay);}});
  }
  connect();
}
