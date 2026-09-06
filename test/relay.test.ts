import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Assembly,frames,parseFrame} from '../src/relay-protocol.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

test('relay framing preserves large Unicode/image payloads and rejects invalid sequences',()=>{
  const value={text:'中文😀'.repeat(30000),content:[{type:'image',mimeType:'image/png',data:'a'.repeat(300000)}]};
  const assembly=new Assembly();let result:any;
  for(const raw of frames('request-1',value))result=assembly.push(parseFrame(raw));
  assert.deepEqual(result.value,value);
  assert.throws(()=>parseFrame('{"id":"x","index":0,"total":99999,"data":""}'));
  assert.throws(()=>new Assembly().push({id:'x',index:1,total:2,data:''}));
});
test('Worker + Durable Object + local agent: authenticated MCP, chunking and reconnect', {timeout:90000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'localmcp-relay-'));
  const children:ChildProcess[]=[];
  t.after(async()=>{for(const c of children)c.kill('SIGTERM');await new Promise(r=>setTimeout(r,2000));for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');await rm(root,{recursive:true,force:true});});
  const port=20000+Math.floor(Math.random()*15000),origin=`http://127.0.0.1:${port}`;
  const agentToken='b'.repeat(64),mcpToken='c'.repeat(64),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const worker=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--config',resolve('worker/wrangler.jsonc'),'--local','--port',String(port),'--inspector-port','0','--persist-to',join(root,'state'),'--var',`AGENT_TOKEN_HASH:${hash(agentToken)}`,'--var',`MCP_TOKEN_HASH:${hash(mcpToken)}`],{stdio:['ignore','pipe','pipe']});children.push(worker);
  let logs='';worker.stdout?.on('data',c=>{logs+=c;});worker.stderr?.on('data',c=>{logs+=c;});
  let ready=false;
  for(let i=0;i<200;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,logs);
  const url=`${origin}/mcp/${mcpToken}`;
  const post=()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal((await post()).status,503);
  assert.equal((await fetch(origin+'/mcp/bad',{method:'POST'})).status,404);
  assert.equal((await fetch(url,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(origin+'/agent',{headers:{Authorization:`Bearer ${mcpToken}`}})).status,404);
  await mkdir(join(root,'.localmcp'));
  await writeFile(join(root,'.localmcp/worker.json'),JSON.stringify({workerUrl:origin,agentToken,mcpToken}));
  async function startAgent(){
    const agent=spawn(process.execPath,[resolve('dist/agent.js')],{cwd:root,env:{...process.env,HOME:root,LOCALMCP_ROOT:root,LOCALMCP_AGENT_PORT:String(port+1),LOCALMCP_SHELL:'0'},stdio:['ignore','pipe','pipe']});children.push(agent);
    let output='';agent.stdout?.on('data',c=>{output+=c;});agent.stderr?.on('data',c=>{output+=c;});
    for(let i=0;i<100;i++){if(output.includes('Worker connected.'))return agent;await new Promise(r=>setTimeout(r,100));}assert.fail(output);
  }
  const agent=await startAgent();
  const client=new Client({name:'worker-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const tools=await client.listTools();assert.equal(tools.tools.length,17);
  const content='中文😀'.repeat(25000);
  assert.equal((await client.callTool({name:'write_file',arguments:{path:'relay.txt',content}})).isError,undefined);
  const result:any=await client.callTool({name:'read_file',arguments:{path:'relay.txt'}});
  assert.equal(JSON.parse(result.content[0].text).content,content);
  // A second agent must not take over the owner connection.
  const duplicate=new WebSocket(origin.replace('http:','ws:')+'/agent',{headers:{Authorization:`Bearer ${agentToken}`}});
  const status=await new Promise<number>((resolve,reject)=>{duplicate.on('unexpected-response',(_req,res)=>{res.resume();duplicate.terminate();resolve(res.statusCode!);});duplicate.on('error',()=>{});duplicate.on('open',()=>{duplicate.close();reject(new Error('Duplicate accepted'));});});
  assert.equal(status,409);
  await client.close();agent.kill('SIGTERM');await new Promise(r=>setTimeout(r,2200));
  assert.equal((await post()).status,503);
  await startAgent();
  const second=new Client({name:'reconnect-test',version:'1'});await second.connect(new StreamableHTTPClientTransport(new URL(url)));
  assert.equal((await second.listTools()).tools.length,17);await second.close();
});
