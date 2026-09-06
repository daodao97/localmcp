#!/usr/bin/env node
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { Assembly, frames, parseFrame, MAX_BYTES } from './relay-protocol.js';

interface Settings { workerUrl: string; agentToken: string; mcpToken: string }
const stateDir=resolve(homedir(),'.localmcp');
await mkdir(stateDir,{recursive:true,mode:0o700});
const pidFile=resolve(stateDir,'agent.pid');
await writeFile(pidFile,String(process.pid),{mode:0o600});
const settings: Settings = JSON.parse(await readFile(resolve(stateDir,'worker.json'),'utf8'));
const origin = new URL(process.env.LOCALMCP_WORKER_URL || settings.workerUrl);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) throw new Error('Worker URL must use HTTPS');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Worker URL must be an origin');
const localToken = randomBytes(32).toString('hex');
const port = Number(process.env.LOCALMCP_AGENT_PORT || 8788);
let local: ChildProcess;
function spawnLocal(){return spawn(process.execPath,[fileURLToPath(new URL('./index.js',import.meta.url)),'http'],{env:{...process.env,LOCALMCP_PORT:String(port),LOCALMCP_TOKEN:localToken},stdio:['ignore','ignore','inherit']});}
function watchLocal(child:ChildProcess){child.on('error',error=>{console.error(error.message);stop(1);});child.on('exit',code=>{if(!closing&&child===local){console.error(`Local server exited (${code})`);stop(1);}});}
local=spawnLocal();watchLocal(local);
let closing=false, socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
function stop(code=0) {
  if (closing) return; closing=true; clearTimeout(reconnect); socket?.terminate(); local.kill('SIGTERM');
  unlink(pidFile).catch(()=>{});
  setTimeout(() => {local.kill('SIGKILL'); process.exit(code);},1500);
}
process.once('SIGINT',()=>stop()); process.once('SIGTERM',()=>stop());
process.on('SIGHUP',()=>{console.error('Reloading LocalMCP configuration...');const previous=local;previous.once('exit',()=>{if(closing)return;local=spawnLocal();watchLocal(local);});previous.kill('SIGTERM');});
let ready=false;
for (let i=0;i<100 && !closing;i++) {
  try {const r=await fetch(`http://127.0.0.1:${port}/mcp`,{headers:{Authorization:`Bearer ${localToken}`},signal:AbortSignal.timeout(500)});if(r.status===405){ready=true;break;}} catch {}
  await new Promise(r=>setTimeout(r,100));
}
if (!ready) {stop(1);} else {
  let attempt=0, busy=false;
  const mcpUrl=new URL(`/mcp/${settings.mcpToken}`,origin).href;
  await writeFile(resolve(stateDir,'connection.json'),JSON.stringify({url:mcpUrl,authentication:'none',transport:'worker-websocket',root:process.env.LOCALMCP_ROOT||process.cwd()},null,2),{mode:0o600});
  const wsUrl=new URL('/agent',origin);wsUrl.protocol=origin.protocol==='https:'?'wss:':'ws:';
  function connect() {
    if (closing) return;
    const ws=new WebSocket(wsUrl,{headers:{Authorization:`Bearer ${settings.agentToken}`},handshakeTimeout:15000,maxPayload:160000});socket=ws;
    let assembly: Assembly | undefined, requestId: string | undefined, pong=Date.now();
    const heartbeat=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN)return;if(Date.now()-pong>65000){ws.terminate();return;}ws.send('ping');},25000);
    ws.on('open',()=>{attempt=0; console.error('Worker connected.'); console.log(`ChatGPT 服务器 URL: ${mcpUrl}\n身份验证: 无 (None)`);});
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
    ws.on('close',()=>{clearInterval(heartbeat);if(!closing){const delay=Math.min(30000,1000*2**Math.min(attempt++,5))+Math.random()*1000;console.error(`Worker disconnected; reconnecting in ${Math.ceil(delay/1000)}s. Requests are not replayed.`);reconnect=setTimeout(connect,delay);}});
  }
  connect();
}
