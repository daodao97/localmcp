import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface ManagedProcess {
  id: string;
  child: ChildProcess;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  startedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const MAX_BUFFER = 1024 * 1024;

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  start(command: string, cwd: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH','HOME','USER','TMPDIR','LANG','SHELL','SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(command, {cwd, shell: true, detached: process.platform !== 'win32', env, stdio: ['pipe','pipe','pipe']});
    const proc: ManagedProcess = {id: randomUUID(), child, command, cwd, stdout: '', stderr: '', stdoutOffset: 0, stderrOffset: 0, startedAt: new Date().toISOString(), exitCode: null, signal: null};
    const collect = (stream: 'stdout'|'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      proc[stream] += text;
      if (Buffer.byteLength(proc[stream]) > MAX_BUFFER) {
        const excess = Buffer.byteLength(proc[stream]) - MAX_BUFFER;
        proc[stream] = Buffer.from(proc[stream]).subarray(excess).toString('utf8');
        if (stream === 'stdout') proc.stdoutOffset += excess; else proc.stderrOffset += excess;
      }
    };
    child.stdout?.on('data', c => collect('stdout', c));
    child.stderr?.on('data', c => collect('stderr', c));
    child.on('close', (code, signal) => {proc.exitCode = code; proc.signal = signal;});
    this.processes.set(proc.id, proc);
    return {processId: proc.id, pid: child.pid, running: true, startedAt: proc.startedAt};
  }

  read(id: string, stdoutCursor = 0, stderrCursor = 0) {
    const proc = this.mustGet(id);
    const readOne = (text: string, base: number, cursor: number) => {
      const effective = Math.max(cursor, base);
      const data = Buffer.from(text);
      const local = Math.min(Math.max(0, effective - base), data.length);
      return {text: data.subarray(local).toString('utf8'), nextCursor: base + data.length, truncatedBeforeCursor: cursor < base};
    };
    const out = readOne(proc.stdout, proc.stdoutOffset, stdoutCursor);
    const err = readOne(proc.stderr, proc.stderrOffset, stderrCursor);
    return {processId: id, stdout: out.text, stderr: err.text, nextStdoutCursor: out.nextCursor, nextStderrCursor: err.nextCursor, stdoutTruncated: out.truncatedBeforeCursor, stderrTruncated: err.truncatedBeforeCursor, running: proc.exitCode === null && proc.signal === null, exitCode: proc.exitCode, signal: proc.signal};
  }

  write(id: string, input: string) {
    const proc = this.mustGet(id);
    if (!proc.child.stdin || proc.child.stdin.destroyed) throw new Error('Process stdin is not available');
    proc.child.stdin.write(input);
    return {processId: id, bytes: Buffer.byteLength(input)};
  }

  stop(id: string) {
    const proc = this.mustGet(id);
    if (proc.exitCode !== null || proc.signal !== null) return {processId: id, running: false, exitCode: proc.exitCode, signal: proc.signal};
    try { if (process.platform !== 'win32' && proc.child.pid) process.kill(-proc.child.pid, 'SIGTERM'); else proc.child.kill('SIGTERM'); } catch {}
    return {processId: id, stopping: true};
  }

  list() {
    return [...this.processes.values()].map(proc => ({processId: proc.id, pid: proc.child.pid, command: proc.command, cwd: proc.cwd, startedAt: proc.startedAt, running: proc.exitCode === null && proc.signal === null, exitCode: proc.exitCode, signal: proc.signal}));
  }

  async close() {
    for (const proc of this.processes.values()) {
      if (proc.exitCode === null && proc.signal === null) {
        try { if (process.platform !== 'win32' && proc.child.pid) process.kill(-proc.child.pid, 'SIGKILL'); else proc.child.kill('SIGKILL'); } catch {}
      }
    }
  }

  private mustGet(id: string) {
    const proc = this.processes.get(id);
    if (!proc) throw new Error('Unknown processId');
    return proc;
  }
}
