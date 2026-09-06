import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpServerConfig { command:string; args?:string[]; env?:Record<string,string>; }
interface Loaded { name:string; client:Client; tools:Tool[]; }
export class McpLoader {
  private loaded:Loaded[]=[];
  private pending=new Set<Promise<unknown>>();
  private track<T>(operation:Promise<T>):Promise<T>{this.pending.add(operation);return operation.finally(()=>this.pending.delete(operation));}
  constructor(private servers:Record<string,McpServerConfig>){}
  async start(){
    try {
      for(const [name,cfg] of Object.entries(this.servers)){
        const client=new Client({name:`localmcp-${name}`,version:'0.3.0'});
        const transport=new StdioClientTransport({command:cfg.command,args:cfg.args||[],env:cfg.env,stderr:'inherit'});
        const server={name,client,tools:[] as Tool[]};
        this.loaded.push(server);
        await client.connect(transport);
        await this.refresh(server);
      }
    } catch(error) {await this.close();throw error;}
  }
  private getServer(name:string):Loaded {
    const server=this.loaded.find(server=>server.name===name);
    if(!server)throw new Error(`Unknown MCP server '${name}'`);
    return server;
  }
  private async refresh(server:Loaded):Promise<Tool[]> {
    const tools:Tool[]=[];let cursor:string|undefined;
    do{const page=await server.client.listTools({cursor});tools.push(...page.tools);cursor=page.nextCursor;}while(cursor);
    server.tools=tools;
    return tools;
  }
  listServers(){return this.loaded.map(({name})=>({name}));}
  async listTools(server:string):Promise<Tool[]> {return this.track(this.refresh(this.getServer(server)));}
  async call(serverName:string,toolName:string,args:Record<string,unknown>){
    const server=this.getServer(serverName);
    const tool=server.tools.find(tool=>tool.name===toolName);
    if(!tool)throw new Error(`Unknown MCP tool '${toolName}' on server '${serverName}'; use list_mcp_tools first`);
    // Each tool gets its own schema scope: unrelated servers may reuse the same $id.
    const validation=new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args);
    if(!validation.valid)throw new Error(`Invalid arguments for MCP tool '${toolName}': ${validation.errorMessage}`);
    return this.track(server.client.callTool({name:toolName,arguments:args},undefined,{timeout:60000}));
  }
  async close(){await Promise.allSettled([...this.pending]);await Promise.allSettled(this.loaded.map(server=>server.client.close()));this.loaded=[];}
}
