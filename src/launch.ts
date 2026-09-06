#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const state = resolve('.localmcp');
await mkdir(state, {recursive:true, mode:0o700});
await chmod(state, 0o700);
let token: string;
try {token = (await readFile(resolve(state,'token'),'utf8')).trim();}
catch (error: any) {
  if (error.code !== 'ENOENT') throw error;
  token = randomBytes(32).toString('hex');
  await writeFile(resolve(state,'token'), token, {mode:0o600, flag:'wx'});
}
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid .localmcp/token; remove it to rotate the credential');
const port = Number(process.env.LOCALMCP_PORT || 8787);
const children: ChildProcess[] = [];
let closing = false;
function stop(code = 0) {
  if (closing) return; closing = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {for (const child of children) child.kill('SIGKILL'); process.exit(code);}, 2000);
}
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
function child(command: string, args: string[], env = process.env) {
  const p = spawn(command,args,{env,stdio:['ignore','pipe','pipe']}); children.push(p);
  p.on('error', e => {console.error(e.message); stop(1);});
  p.on('exit', code => {if (!closing) {console.error(`${command} exited (${code})`); stop(code || 1);}});
  return p;
}
const local = child(process.execPath, [fileURLToPath(new URL('./index.js',import.meta.url)),'http'], {...process.env,LOCALMCP_TOKEN: token});
local.stderr?.pipe(process.stderr);
let ready = false;
for (let i = 0; i < 100 && !closing; i++) {
  try {
    // Authenticate the readiness request: a different process on this port must not be published.
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {method:'GET',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(500)});
    if (response.status === 405) {ready = true; break;}
  } catch {}
  await new Promise(r => setTimeout(r,100));
}
if (!ready || closing) {stop(1);} else {
  await rm(resolve(state,'connection.json'),{force:true});
  // Do not inherit ~/.cloudflared/config.yaml: its ingress rules can override --url.
  const tunnelConfig = resolve(state, 'cloudflared.yaml');
  await writeFile(tunnelConfig, 'protocol: http2\n', {mode: 0o600});
  const tunnel = child(process.env.CLOUDFLARED_COMMAND || 'cloudflared',['tunnel','--config',tunnelConfig,'--no-autoupdate','--url',`http://127.0.0.1:${port}`]);
  let buffer = '', printed = false;
  const timeout = setTimeout(() => {console.error('Cloudflare tunnel did not return a URL within 90 seconds'); stop(1);},90000);
  async function output(chunk: Buffer) {
    process.stderr.write(chunk);
    buffer = (buffer + chunk.toString()).slice(-16384);
    const origin = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (origin && !printed) {
      printed = true; clearTimeout(timeout);
      const url = `${origin}/mcp/${token}`;
      await writeFile(resolve(state,'connection.json'),JSON.stringify({url,authentication:'none',root:process.env.LOCALMCP_ROOT || process.cwd()},null,2),{mode:0o600});
      console.log(`\nChatGPT 插件名称: localmcp\n服务器 URL: ${url}\n身份验证: 无 (None)\n连接信息: ${resolve(state,'connection.json')}\n保持此进程运行，Ctrl+C 同时停止服务与隧道。\n`);
    }
  }
  tunnel.stdout?.on('data', chunk => void output(chunk).catch(e => {console.error(e.message); stop(1);}));
  tunnel.stderr?.on('data', chunk => void output(chunk).catch(e => {console.error(e.message); stop(1);}));
}
