import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const schema = {type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const names = async () => process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : ['echo'];
const server = new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async request => {
  const all = await names();
  const offset = Number(request.params?.cursor || 0);
  return {tools:all.slice(offset, offset+1).map(name => ({name,description:'Fixture echo',inputSchema:schema,annotations:{readOnlyHint:true}})),...(offset+1<all.length?{nextCursor:String(offset+1)}:{})};
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  if(request.params.arguments?.text==='slow')await new Promise(resolve=>setTimeout(resolve,2500));
  // Deliberately no input validation here: the bridge must reject invalid arguments.
  return {content:[{type:'text',text:JSON.stringify(request.params.arguments)},{type:'image',mimeType:'image/png',data:'aGVsbG8='}],structuredContent:{tool:request.params.name},isError:request.params.arguments?.text==='fail'};
});
await server.connect(new StdioServerTransport());
