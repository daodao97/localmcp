import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
const stateDir=resolve(homedir(),'.localmcp');
const workerFile=resolve(stateDir,'worker.json');
const secretsFile=resolve(stateDir,'worker-secrets.json');
await mkdir(stateDir,{recursive:true,mode:0o700});
await chmod(stateDir,0o700);
let settings;
try {settings=JSON.parse(await readFile(workerFile,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;settings={workerUrl:'https://REPLACE-WITH-YOUR-WORKER.workers.dev',agentToken:randomBytes(32).toString('hex'),mcpToken:randomBytes(32).toString('hex')};}
if(process.argv[2])settings.workerUrl=new URL(process.argv[2]).origin;
for(const key of ['agentToken','mcpToken'])if(!/^[a-f0-9]{64}$/.test(settings[key]))throw new Error(`Invalid ${key}`);
delete settings.deviceId;
await writeFile(workerFile,JSON.stringify(settings,null,2),{mode:0o600});
await chmod(workerFile,0o600);
const hash=value=>createHash('sha256').update(value).digest('hex');
await writeFile(secretsFile,JSON.stringify({MCP_TOKEN_HASH:hash(settings.mcpToken),AGENT_TOKEN_HASH:hash(settings.agentToken)}),{mode:0o600});
console.log(`Worker settings saved to ${workerFile}; only token hashes are uploaded to the Worker.`);
