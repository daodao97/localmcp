import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpServerConfig { command:string; args?:string[]; env?:Record<string,string>; }
interface Loaded { name:string; client:Client; tools:Tool[]; }
export class McpLoader {
  private loaded:Loaded[]=[];
  constructor(private servers:Record<string,McpServerConfig>){}
  async start(){
    for(const [name,cfg] of Object.entries(this.servers)){
      const client=new Client({name:`localmcp-${name}`,version:'0.3.0'});
      const transport=new StdioClientTransport({command:cfg.command,args:cfg.args||[],env:cfg.env,stderr:'inherit'});
      await client.connect(transport);
      const tools:Tool[]=[];let cursor:string|undefined;
      do{const page=await client.listTools({cursor});tools.push(...page.tools);cursor=page.nextCursor;}while(cursor);
      this.loaded.push({name,client,tools});
    }
  }
  listTools():Tool[]{return this.loaded.flatMap(server=>server.tools.map(tool=>({...tool,name:`${server.name}_${tool.name}`,description:`MCP ${server.name}: ${tool.description||tool.name}`})));}
  async call(fullName:string,args:Record<string,unknown>){
    for(const server of this.loaded){const prefix=`${server.name}_`;if(fullName.startsWith(prefix)&&server.tools.some(t=>t.name===fullName.slice(prefix.length)))return server.client.callTool({name:fullName.slice(prefix.length),arguments:args},undefined,{timeout:60000});}
    throw new Error(`Unknown MCP tool '${fullName}'`);
  }
  async close(){for(const server of this.loaded)await server.client.close();this.loaded=[];}
}
