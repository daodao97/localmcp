#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { createServer } from './server.js';
import { McpLoader } from './mcp/loader.js';
import { loadSkills } from './skills/loader.js';
import { ProcessManager } from './process.js';

async function main() {
  const cfg = await config();
  const mode = process.argv[2] || 'stdio';
  if (!['stdio', 'http'].includes(mode)) throw new Error('Usage: localmcp [stdio|http]');
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
    const listener = app.listen(cfg.port, '127.0.0.1', () => console.error(`localmcp listening on http://127.0.0.1:${cfg.port}/mcp`));
    listener.on('error', error => {console.error(error.message); process.exit(1);});
    shutdown.push(() => new Promise<void>(r => listener.close(() => r())));
  }
  const stop = async () => {for (const fn of shutdown) await fn(); await processes.close(); await mcp.close(); process.exit(0);};
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => {console.error(error.message); process.exit(1);});
