import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, readFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Workspace } from '../src/workspace.js';
import { runCommand } from '../src/command.js';

async function temp(t: any) {const root = await mkdtemp(join(tmpdir(),'localmcp-test-')); t.after(() => rm(root,{recursive:true,force:true})); return root;}
test('file boundary, symlinks, hardlinks and overwrite protection', async t => {
  const root = await temp(t), outside = await temp(t), ws = new Workspace(root);
  await ws.write('a/b.txt','hello',false);
  assert.equal(await ws.read('a/b.txt'),'hello');
  await assert.rejects(ws.write('a/b.txt','bad',false));
  await assert.rejects(ws.read('../outside'));
  await symlink(outside,join(root,'escape'));
  await assert.rejects(ws.write('escape/no.txt','bad',false));
  await writeFile(join(outside,'keep'),'keep');
  await link(join(outside,'keep'),join(root,'hard'));
  await assert.rejects(ws.write('hard','bad',true));
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'keep');
});
test('command results, nonzero exit, bounded output and timeout', async t => {
  const root = await temp(t);
  assert.equal((await runCommand('printf hello',root,1000)).output,'hello');
  assert.equal((await runCommand('exit 7',root,1000)).exitCode,7);
  assert.equal((await runCommand('sleep 5',root,100)).timedOut,true);
  const big = await runCommand('yes x | head -c 300000',root,3000);
  assert.equal(big.truncated,true); assert.ok(big.output.length <= 262144);
});
test('real SDK stdio initialization and create/read/edit/list round trip', async t => {
  const root = await temp(t);
  const client = new Client({name:'test',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js'),'stdio'],env:{LOCALMCP_ROOT:root,LOCALMCP_CONFIG:'/nonexistent/localmcp-test.json'},stderr:'pipe'});
  await client.connect(transport); t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length,17);
  assert.ok(!tools.tools.some(t => t.name === 'run_command'));
  const call = (name: string,args: any) => client.callTool({name,arguments:args});
  assert.equal((await call('write_file',{path:'hello.txt',content:'hello world'})).isError,undefined);
  assert.equal((await call('edit_file',{path:'hello.txt',oldText:'world',newText:'MCP'})).isError,undefined);
  assert.equal(await readFile(join(root,'hello.txt'),'utf8'),'hello MCP');
  assert.equal((await call('edit_file',{path:'hello.txt',oldText:'missing',newText:'bad'})).isError,true);
  assert.equal((await call('read_file',{path:'../no'})).isError,true);
  assert.equal((await call('run_command',{command:'pwd'})).isError,true);
});
test('HTTP URL credential, origin rejection and SDK round trip', async t => {
  const root = await temp(t), token = 'a'.repeat(64), port = 18000 + Math.floor(Math.random()*20000);
  const child = spawn(process.execPath,[resolve('dist/index.js'),'http'],{env:{...process.env,LOCALMCP_CONFIG:'/nonexistent/localmcp-test.json',LOCALMCP_ROOT:root,LOCALMCP_PORT:String(port),LOCALMCP_TOKEN:token},stdio:'ignore'});
  t.after(() => {child.kill('SIGTERM');});
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i=0;i<100;i++) {try {if ((await fetch(base+'/healthz')).ok) {ready=true;break;}} catch {} await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready);
  assert.equal((await fetch(base+'/mcp')).status,404);
  assert.equal((await fetch(base+'/mcp/wrong')).status,404);
  assert.equal((await fetch(`${base}/mcp/${token}`,{headers:{Origin:'https://evil.example'}})).status,403);
  const client = new Client({name:'test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length,17);
  const result = await client.callTool({name:'write_file',arguments:{path:'http.txt',content:'over HTTP'}});
  assert.equal(result.isError,undefined);
  assert.equal(await readFile(join(root,'http.txt'),'utf8'),'over HTTP');
});

test('workspace tree, search, ranged reads, atomic edits and file operations', async t => {
  const root = await temp(t), ws = new Workspace(root);
  await ws.write('src/a.ts','one\ntwo needle\nthree\nfour',false);
  await ws.write('src/b.ts','another needle',false);
  const tree = await ws.tree('.',3,100);
  assert.ok(tree.entries.some(e => e.path === 'src/a.ts'));
  const found = await ws.findFiles('.', '*.ts', 10);
  assert.deepEqual(found.matches.sort(), ['src/a.ts','src/b.ts']);
  const searched = await ws.search('.', 'needle', false, false, 10, 1);
  assert.equal(searched.matches.length, 2);
  assert.equal(searched.matches[0].line, 2);
  const range = await ws.readLines('src/a.ts',2,3);
  assert.equal(range.content,'two needle\nthree');
  assert.equal(range.hasMore,true);
  const hash = (await import('node:crypto')).createHash('sha256').update(await ws.read('src/a.ts')).digest('hex');
  await ws.applyEdits('src/a.ts',[{startLine:2,endLine:2,replacement:'TWO'}],hash);
  assert.equal(await ws.read('src/a.ts'),'one\nTWO\nthree\nfour');
  await assert.rejects(ws.applyEdits('src/a.ts',[{startLine:1,endLine:1,replacement:'bad'}],hash));
  await ws.createDirectory('empty');
  await ws.move('src/b.ts','empty/b.ts',false);
  assert.equal(await ws.read('empty/b.ts'),'another needle');
  await ws.delete('empty/b.ts',false);
  await assert.rejects(ws.read('empty/b.ts'));
});

test('persistent process manager supports stdout, stderr, stdin and stop', async t => {
  const { ProcessManager } = await import('../src/process.js');
  const root = await temp(t), pm = new ProcessManager();
  t.after(() => pm.close());
  const started = pm.start("node -e \"process.stdin.on('data',d=>{console.log('out:'+d.toString().trim());console.error('err');})\"", root);
  pm.write(started.processId, 'hello\n');
  await new Promise(r => setTimeout(r, 250));
  const result = pm.read(started.processId);
  assert.match(result.stdout,/out:hello/);
  assert.match(result.stderr,/err/);
  pm.stop(started.processId);
  assert.ok(pm.list().some(p => p.processId === started.processId));
});



test('skill loader discovers SKILL.md', async t => {
  const root=await temp(t); await (await import('node:fs/promises')).mkdir(join(root,'demo')); await writeFile(join(root,'demo','SKILL.md'),'# Demo\n\nUse demo tools carefully.');
  const {loadSkills}=await import('../src/skills/loader.js'); const skills=await loadSkills(root);
  assert.equal(skills.length,1); assert.equal(skills[0].name,'demo'); assert.match(skills[0].instructions,/Demo/);
});

test('localmcp.json controls core features, skills and MCP enablement', async t => {
  const root=await temp(t); await (await import('node:fs/promises')).mkdir(join(root,'skills','one'),{recursive:true}); await writeFile(join(root,'skills','one','SKILL.md'),'# One\n\nOne skill.');
  const cfgPath=join(root,'localmcp.json'); await writeFile(cfgPath,JSON.stringify({root:'.',features:{files:false,shell:false,processes:false},skills:{dir:'skills',enabled:['one']},mcpServers:{off:{enabled:false,command:'never-run'}}}));
  const old=process.env.LOCALMCP_CONFIG; process.env.LOCALMCP_CONFIG=cfgPath;
  try { const {config}=await import('../src/config.js'); const cfg=await config(); assert.equal(await (await import('node:fs/promises')).realpath(cfg.root),await (await import('node:fs/promises')).realpath(root)); assert.equal(cfg.files,false); assert.equal(cfg.shell,false); assert.deepEqual(cfg.enabledSkills,['one']); assert.deepEqual(cfg.mcpServers,{}); }
  finally { if(old===undefined)delete process.env.LOCALMCP_CONFIG;else process.env.LOCALMCP_CONFIG=old; }
});

test('localmcp.json schema rejects invalid and unknown config', async t => {
  const root=await temp(t),cfgPath=join(root,'bad.json');
  const {config}=await import('../src/config.js'); const old=process.env.LOCALMCP_CONFIG;
  try {
    await writeFile(cfgPath,JSON.stringify({mcpServers:{bad:{enabled:true}}})); process.env.LOCALMCP_CONFIG=cfgPath; await assert.rejects(config(),/command/);
    await writeFile(cfgPath,JSON.stringify({unknown:true})); await assert.rejects(config(),/Unrecognized key|unknown/i);
  } finally {if(old===undefined)delete process.env.LOCALMCP_CONFIG;else process.env.LOCALMCP_CONFIG=old;}
});

test('multiple workspaces select files independently', async t => {
  const one=await temp(t),two=await temp(t),cfgPath=join(one,'multi.json'); await writeFile(join(one,'a.txt'),'one'); await writeFile(join(two,'a.txt'),'two');
  await writeFile(cfgPath,JSON.stringify({workspaces:{one:'.',two},defaultWorkspace:'one',features:{files:true,shell:false}}));
  const old=process.env.LOCALMCP_CONFIG; process.env.LOCALMCP_CONFIG=cfgPath;
  try {const {config}=await import('../src/config.js');const cfg=await config();assert.equal(cfg.defaultWorkspace,'one');assert.equal(Object.keys(cfg.workspaces).length,2);assert.equal(await readFile(join(cfg.workspaces.two,'a.txt'),'utf8'),'two');}
  finally{if(old===undefined)delete process.env.LOCALMCP_CONFIG;else process.env.LOCALMCP_CONFIG=old;}
});
