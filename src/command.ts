import { spawn } from 'node:child_process';
export function runCommand(command: string, cwd: string, timeoutMs: number) {
  return new Promise<{exitCode: number | null; signal: string | null; output: string; timedOut: boolean; truncated: boolean}>((resolve, reject) => {
    // Deliberately do not pass the server's credentials to commands.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SHELL', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', env, stdio: ['ignore','pipe','pipe'] });
    let output = Buffer.alloc(0), timedOut = false, truncated = false;
    const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (chunk: Buffer) => {
      const remaining = 256 * 1024 - output.length;
      if (chunk.length > remaining) truncated = true;
      output = Buffer.concat([output, chunk.subarray(0, Math.max(0, remaining))]);
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); stop(); resolve({exitCode, signal, output: output.toString('utf8'), timedOut, truncated}); });
  });
}
