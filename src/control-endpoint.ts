import {createHash} from 'node:crypto';
import {resolve,win32} from 'node:path';

export function controlEndpoint(directory:string,platform:NodeJS.Platform=process.platform):{address:string;socketFile?:string}{
  if(platform==='win32'){
    // Named pipes have a flat namespace. Normalize aliases and keep the name
    // short and deterministic so CLI and Agent agree for each user directory.
    const key=win32.resolve(directory).toLowerCase();
    const id=createHash('sha256').update(key).digest('hex').slice(0,32);
    return {address:`\\\\.\\pipe\\localmcp-${id}`};
  }
  const socketFile=resolve(directory,'agent.sock');
  return {address:socketFile,socketFile};
}
