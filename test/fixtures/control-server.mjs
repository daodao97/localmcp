import {mkdir} from 'node:fs/promises';
import {stateDir,logFile,serveControl} from '../../dist/lifecycle.js';
await mkdir(stateDir,{recursive:true});
let reloads=0;
const close=await serveControl(
  ()=>({status:'running',pid:process.pid,url:null,config:`reloads:${reloads}`,log:logFile,ready:true}),
  ()=>{void close().then(()=>process.exit(0));},
  async()=>{reloads++;}
);
process.send?.('ready');
