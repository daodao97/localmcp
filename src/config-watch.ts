import {readFile} from 'node:fs/promises';

// Poll contents rather than a file inode: editors commonly save via rename.
// A single loop coalesces writes and never overlaps reloads.
export function watchConfig(path:string, apply:(content:string)=>Promise<void>, report:(error:unknown)=>void, interval=500){
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  let observed:string|undefined,settled:string|undefined,lastError:string|undefined;
  let running:Promise<void>=Promise.resolve();
  async function scan(){
    try {
      const content=await readFile(path,'utf8');
      lastError=undefined;
      if(stopped)return;
      if(content!==observed){observed=content;return;}
      if(content===settled)return;
      // Remember rejected content too, avoiding repeated errors until the next edit.
      settled=content;
      await apply(content);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(!stopped&&message!==lastError)report(error);
      lastError=message;
    }
  }
  function tick(){running=scan().finally(()=>{if(!stopped)timer=setTimeout(tick,interval);});}
  timer=setTimeout(tick,interval);
  return async()=>{stopped=true;clearTimeout(timer);await running;};
}
