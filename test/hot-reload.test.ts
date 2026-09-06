import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {watchConfig} from '../src/config-watch.js';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await pause(100);}assert.fail('Hot reload did not settle');}

test('config watcher serializes reloads and picks up edits made during a reload',async t=>{
  const root=await mkdtemp(join(tmpdir(),'localmcp-watch-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'config.json');await writeFile(file,'one');
  let unblock!:()=>void,started!:()=>void;
  const blocked=new Promise<void>(r=>{unblock=r;}),entered=new Promise<void>(r=>{started=r;});
  const applied:string[]=[];let active=0,maxActive=0;
  const stop=watchConfig(file,async content=>{active++;maxActive=Math.max(active,maxActive);applied.push(content);if(content==='one'){started();await blocked;}active--;},error=>{throw error;},15);
  t.after(stop);
  await entered;
  await writeFile(file,'two');await writeFile(file,'three');unblock();
  await until(async()=>applied.includes('three'));
  assert.deepEqual(applied,['one','three']);assert.equal(maxActive,1);
  await stop();await writeFile(file,'four');await pause(60);assert.equal(applied.length,2);
});

test('stdio hot reload preserves calls and processes, rejects bad config and survives atomic saves', {timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'localmcp-hot-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'custom.json');
  const settings:any={workspaces:{first:root},defaultWorkspace:'first',features:{shell:true}};
  await writeFile(path,JSON.stringify(settings));
  const client=new Client({name:'hot-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js'),'stdio'],env:{LOCALMCP_CONFIG:path},stderr:'pipe'});
  let logs='';transport.stderr?.on('data',data=>{logs+=data;});
  t.after(()=>client.close());await client.connect(transport);
  const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args}) as Promise<any>;
  const info=async()=>JSON.parse((await call('workspace_info')).content[0].text);
  const top=await client.listTools();
  const processResult=JSON.parse((await call('start_process',{command:'cat'})).content[0].text);
  await writeFile(path,'{bad');
  await until(async()=>logs.includes('hot-reload rejected'));
  assert.equal((await info()).workspace,'first');
  settings.mcpServers={broken:{command:join(root,'nonexistent-command')}};
  await writeFile(path,JSON.stringify(settings));
  await until(async()=>logs.includes('ENOENT'));
  assert.equal((await info()).workspace,'first');
  delete settings.mcpServers;
  // An in-flight command and a persistent process must survive the configuration switch.
  const running=call('run_command',{command:'sleep 2; printf finished',timeoutMs:5000});
  settings.workspaces={first:root,second:root};settings.defaultWorkspace='second';
  const staged=join(root,'staged.json');await writeFile(staged,JSON.stringify(settings));await rename(staged,path);
  await until(async()=>(await info()).workspace==='second');
  assert.equal(JSON.parse((await running).content[0].text).output,'finished');
  const processes=JSON.parse((await call('list_processes')).content[0].text);
  assert.ok(processes.some((p:any)=>p.processId===processResult.processId&&p.running));
  assert.deepEqual(await client.listTools(),top);
  // Deletion does not reset to defaults, and creating the file again is detected.
  await rm(path);await pause(1100);assert.equal((await info()).workspace,'second');
  settings.defaultWorkspace='first';await writeFile(path,JSON.stringify(settings));
  await until(async()=>(await info()).workspace==='first');
  // Retiring an MCP server must drain its already-started tool calls.
  settings.mcpServers={fixture:{command:process.execPath,args:[resolve('test/fixtures/mcp-server.mjs')]}};
  await writeFile(path,JSON.stringify(settings));
  await until(async()=>JSON.parse((await call('list_mcp_servers')).content[0].text).servers.length===1);
  const external=call('call_mcp_tool',{server:'fixture',tool:'echo',arguments:{text:'slow'}});
  await pause(100);
  settings.mcpServers={};await writeFile(path,JSON.stringify(settings));
  await until(async()=>JSON.parse((await call('list_mcp_servers')).content[0].text).servers.length===0);
  assert.equal((await external).isError,false);
  await call('stop_process',{processId:processResult.processId});
});
