import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdir, open, readFile, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlEndpoint } from './control-endpoint.js';

export const stateDir = resolve(homedir(), '.localmcp');
export const logFile = resolve(stateDir, 'agent.log');
const endpoint = controlEndpoint(stateDir);
const lockFile = resolve(stateDir, 'control.lock');
export interface Status { status: 'running' | 'stopped'; pid: number | null; url: string | null; config: string; log: string; ready: boolean }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export function request(command = 'status'): Promise<Status> {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection(endpoint.address);
    let data = '';
    const timer = setTimeout(() => socket.destroy(new Error('LocalMCP control request timed out')), 20000);
    socket.on('connect', () => socket.end(command + '\n'));
    socket.on('data', chunk => {data += chunk; if (data.length > 65536) socket.destroy(new Error('Invalid control response'));});
    socket.on('error', reject);
    socket.on('close', () => clearTimeout(timer));
    socket.on('end', () => {try {if(!data)throw Object.assign(new Error('LocalMCP control connection closed'),{code:'ECONNRESET'});const response = JSON.parse(data); if (response.error) reject(new Error(response.error)); else resolveStatus(response);} catch (error) {reject(error);}});
  });
}

export async function status(): Promise<Status> {
  try {return await request();} catch (error: any) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) throw error;
    return {status: 'stopped', pid: null, url: null, config: resolve(process.env.LOCALMCP_CONFIG || resolve(stateDir, 'localmcp.json')), log: logFile, ready: false};
  }
}

export function printStatus(value: Status) {
  console.log(`Status: ${value.status}\nPID: ${value.pid ?? '-'}\nMCP URL: ${value.url ?? '-'}\nConfig: ${value.config}\nLog: ${value.log}`);
}

// Serialize lifecycle commands, including concurrent startup from different terminals.
async function locked<T>(action: () => Promise<T>): Promise<T> {
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  const deadline = Date.now() + 90000;
  while (true) {
    try {
      const file = await open(lockFile, 'wx', 0o600);
      try {await file.writeFile(String(process.pid));} finally {await file.close();}
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let pid = 0;
      try {pid = Number(await readFile(lockFile, 'utf8'));} catch (e: any) {if (e.code !== 'ENOENT') throw e;}
      if (Number.isInteger(pid) && pid > 0) {
        try {process.kill(pid, 0);} catch (e: any) {if (e.code === 'ESRCH') {await rm(lockFile, {force: true}); continue;}}
      }
      if (Date.now() > deadline) throw new Error(`Another LocalMCP command is still running (${lockFile})`);
      await pause(100);
    }
  }
  try {return await action();} finally {await rm(lockFile, {force: true});}
}

export async function control(command: 'start' | 'stop' | 'reload', initialize: () => Promise<void> = async () => {}) {
  return locked(async () => {
    let current = await status();
    if (command === 'reload') {
      if (current.status === 'stopped') throw new Error('LocalMCP is stopped; run localmcp to start it');
      current = await request('reload');
      console.log('LocalMCP configuration reloaded.');
    } else if (command === 'stop') {
      if (current.status === 'running') {
        await request('stop');
        for (let i = 0; i < 100; i++) {
          current = await status();
          if (current.status === 'stopped') break;
          await pause(100);
        }
        if (current.status !== 'stopped') throw new Error(`LocalMCP did not stop; see ${logFile}`);
      }
    } else {
      let child: ReturnType<typeof spawn> | undefined;
      if (current.status === 'stopped') {
        await initialize();
        if(endpoint.socketFile)await rm(endpoint.socketFile, {force: true});
        const log = await open(logFile, 'a', 0o600);
        try {
          child = spawn(process.execPath, [fileURLToPath(new URL('./agent.js', import.meta.url))], {
            detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
          });
          await new Promise<void>((ready, reject) => {child!.once('spawn', ready); child!.once('error', reject);});
          child.unref();
        } finally {await log.close();}
      }
      const deadline = Date.now() + 60000;
      while (!current.ready) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`LocalMCP startup failed; see ${logFile}`);
        if (Date.now() > deadline) {
          child?.kill('SIGTERM');
          throw new Error(`LocalMCP startup timed out; see ${logFile}`);
        }
        await pause(100);
        current = await status();
      }
    }
    printStatus(current);
  });
}

export async function serveControl(getStatus: () => Status, stop: () => void, reload: () => Promise<void>) {
  const server = createServer({allowHalfOpen: true}, socket => {
    let data = '';
    socket.setTimeout(20000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {data += chunk; if (data.length > 100) socket.destroy();});
    socket.on('end', () => {
      void (async () => {
        const command = data.trim();
        if (command === 'reload') await reload();
        else if (!['status', 'stop'].includes(command)) throw new Error('Unknown control command');
        if (command === 'stop') socket.once('close', stop);
        socket.end(JSON.stringify(getStatus()));
      })().catch(error => socket.end(JSON.stringify({error: error.message})));
    });
  });
  await new Promise<void>((ready, reject) => {server.once('error', reject); server.listen(endpoint.address, ready);});
  if(endpoint.socketFile)await chmod(endpoint.socketFile, 0o600);
  return async () => {
    await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
    if(endpoint.socketFile)await rm(endpoint.socketFile, {force: true});
  };
}
