import { Assembly, frames, parseFrame } from '../src/relay-protocol';
interface Env { RELAY: DurableObjectNamespace; MCP_TOKEN_HASH: string; AGENT_TOKEN_HASH: string }
const json = (data: unknown, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
async function authorized(token: string, expected?: string) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || token.length > 256) return false;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2,'0')).join('');
  let diff = 0; for (let i=0;i<64;i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
async function bodyText(request: Request, limit: number) {
  const reader = request.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {const {value, done} = await reader.read(); if (done) break; size += value.length; if (size > limit) {await reader.cancel(); throw new Error('Request too large');} chunks.push(value);}
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(size); let offset=0;
  for (const chunk of chunks) {bytes.set(chunk,offset); offset+=chunk.length;}
  return new TextDecoder().decode(bytes);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ok:true,service:'localmcp-relay'});
    if (request.headers.has('Origin')) return json({error:'Origin not allowed'},403);
    const bearer = request.headers.get('Authorization')?.replace(/^Bearer /,'') || '';
    if (url.pathname === '/agent') {
      if (!await authorized(bearer, env.AGENT_TOKEN_HASH)) return new Response(null,{status:404});
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error:'WebSocket required'},426);
      return env.RELAY.get(env.RELAY.idFromName('local')).fetch(request);
    }
    const match = /^\/mcp(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
    if (!match || !await authorized(match[1] || bearer,env.MCP_TOKEN_HASH)) return new Response(null,{status:404});
    if (request.method !== 'POST') return new Response(null,{status:405,headers:{Allow:'POST'}});
    if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) return json({error:'JSON required'},415);
    let body: string;
    try {body = await bodyText(request,2*1024*1024); JSON.parse(body);} catch {return json({error:'Invalid JSON or body exceeds 2 MiB'},400);}
    // Forward only MCP headers, never the public credential or caller-supplied destinations.
    const headers = new Headers({'Content-Type':'application/json','Accept':'application/json, text/event-stream'});
    const version = request.headers.get('MCP-Protocol-Version'); if (version) headers.set('MCP-Protocol-Version',version);
    return env.RELAY.get(env.RELAY.idFromName('local')).fetch(new Request('https://relay.internal/mcp',{method:'POST',headers,body}));
  }
};
interface Pending { socket: WebSocket; assembly: Assembly; resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout> }
export class McpRelay {
  private pending = new Map<string,Pending>();
  constructor(private ctx: DurableObjectState) {
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/agent') {
      // One owner connection. A second agent cannot silently take over a live session.
      if (this.ctx.getWebSockets('agent').length) return json({error:'An agent is already connected'},409);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1],['agent']);
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    const socket = this.ctx.getWebSockets('agent')[0];
    if (!socket) return json({error:'Local agent offline. Start localmcp start.'},503);
    // Reject overlapping requests rather than queue side effects beyond an HTTP deadline.
    if (this.pending.size) return json({error:'Local agent busy. Do not automatically retry write operations.'},429);
    const id = crypto.randomUUID();
    const body = await request.text();
    if (this.pending.size) return json({error:'Local agent busy.'},429);
    return new Promise<Response>(resolve => {
      const timer = setTimeout(() => this.finish(id,json({error:'Local execution timed out; outcome may be unknown. Do not automatically retry.'},504)),130000);
      this.pending.set(id,{socket,assembly:new Assembly(),resolve,timer});
      try {for (const frame of frames(id,{body,protocolVersion:request.headers.get('MCP-Protocol-Version')})) socket.send(frame);}
      catch {this.finish(id,json({error:'Agent connection lost; outcome may be unknown.'},502));}
    });
  }
  private finish(id: string,response: Response) {
    const pending=this.pending.get(id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(response);
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') throw new Error('Text frames required');
      const frame=parseFrame(message), pending=this.pending.get(frame.id);
      if (!pending || pending.socket !== socket) return;
      const complete=pending.assembly.push(frame); if (!complete) return;
      const data=complete.value as {status:number;body:string};
      if (!data || !Number.isInteger(data.status) || data.status < 200 || data.status > 599 || typeof data.body !== 'string') throw new Error('Invalid agent response');
      if (![202,204,205,304].includes(data.status)) JSON.parse(data.body);
      this.finish(frame.id,new Response([204,205,304].includes(data.status) ? null : data.body,{status:data.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}));
    } catch {socket.close(1008,'Invalid relay response'); this.failSocket(socket);}
  }
  private failSocket(socket: WebSocket) {
    for (const [id,pending] of this.pending) if (pending.socket===socket) this.finish(id,json({error:'Local agent disconnected; execution outcome may be unknown. Do not automatically retry.'},502));
  }
  webSocketClose(socket: WebSocket) {this.failSocket(socket); try {socket.close(1000,'Closed');} catch {}}
  webSocketError(socket: WebSocket) {this.failSocket(socket); try {socket.close(1011,'Connection failed');} catch {}}
}
