#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { createServer } from './server.js';
import { McpLoader } from './mcp/loader.js';
import { loadSkills } from './skills/loader.js';
import { ProcessManager } from './process.js';

async function ensureInitialized(force = false) {
  const {copyFile, access, cp, mkdir} = await import('node:fs/promises');
  const {dirname, resolve} = await import('node:path');
  const {homedir} = await import('node:os');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configDir = resolve(homedir(), '.localmcp');
  const target = resolve(configDir, 'localmcp.json');
  const skillsTarget = resolve(configDir, 'skills');
  await mkdir(configDir,{recursive:true,mode:0o700});
  let created = false;
  try {await access(target);} catch (error:any) {if(error.code!=='ENOENT')throw error;await copyFile(resolve(packageRoot,'localmcp.example.json'),target);created=true;}
  try {await access(skillsTarget);} catch (error:any) {if(error.code!=='ENOENT')throw error;await cp(resolve(packageRoot,'skills'),skillsTarget,{recursive:true});created=true;}
  if (created || force) console.log(created ? `Initialized ${configDir}` : `Already initialized: ${configDir}`);
}

async function main() {
  let mode = process.argv[2] || 'start';
  if (mode === 'init') {await ensureInitialized(true); return;}
  if (['start', 'stop', 'reload', 'status'].includes(mode)) {
    const {control, status, printStatus} = await import('./lifecycle.js');
    if (mode === 'status') printStatus(await status());
    else await control(mode as 'start' | 'stop' | 'reload', ensureInitialized);
    return;
  }
  if (mode === 'agent') {await ensureInitialized(); await import('./agent.js'); return;}
  const cfg = await config();
  if (!['stdio', 'http'].includes(mode)) throw new Error('Usage: localmcp [start|status|stop|reload|init|agent|stdio|http]');
  if (mode === 'http' && (!cfg.token || cfg.token.length < 32)) throw new Error('HTTP requires LOCALMCP_TOKEN with at least 32 characters');
  const mcp = new McpLoader(cfg.mcpServers);
  await mcp.start();
  const skills = await loadSkills(cfg.skillsDir,cfg.enabledSkills);
  const processes = new ProcessManager();
  const shutdown: Array<() => Promise<unknown>> = [];
  if (mode === 'stdio') {
    const server = await createServer(cfg, mcp, skills, processes);
    await server.connect(new StdioServerTransport());
    shutdown.push(() => server.close());
  } else {
    const app = express();
    app.disable('x-powered-by');
    app.get('/healthz', (_req, res) => {res.json({ok:true});});
    app.use((req,res,next) => {
      // This endpoint is server-to-server; reject browser-originated requests.
      if (req.headers.origin) {res.sendStatus(403); return;}
      const pathToken = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(req.path)?.[1];
      const supplied = Buffer.from(pathToken ? `Bearer ${pathToken}` : req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${cfg.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {res.sendStatus(404); return;}
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    app.use(express.json({limit: '2mb'}));
    // Stateless transport: each request owns its SDK transport and protocol server.
    // Share a process-wide gate so separate requests cannot overlap local actions.
    let gate = Promise.resolve();
    app.post(['/mcp', '/mcp/:token'], async (req,res) => {
      const previous = gate; let release!: () => void;
      gate = new Promise<void>(r => {release = r;}); await previous;
      let server: Awaited<ReturnType<typeof createServer>> | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      try {
        server = await createServer(cfg, mcp, skills, processes);
        transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({error: 'MCP request failed'});
      } finally {await transport?.close(); await server?.close(); release();}
    });
    app.all(['/mcp', '/mcp/:token'], (_req,res) => {res.setHeader('Allow','POST'); res.sendStatus(405);});
    const listener = app.listen(cfg.port, '127.0.0.1', () => {if(process.env.LOCALMCP_INTERNAL!=='1')console.error(`localmcp listening on http://127.0.0.1:${cfg.port}/mcp`);});
    listener.on('error', error => {console.error(error.message); process.exit(1);});
    shutdown.push(() => new Promise<void>(r => listener.close(() => r())));
  }
  const stop = async () => {for (const fn of shutdown) await fn(); await processes.close(); await mcp.close(); process.exit(0);};
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => {console.error(error.message); process.exit(1);});
