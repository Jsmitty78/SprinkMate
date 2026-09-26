import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { serve } from '@hono/node-server';
import { FieldService } from './service.js';
import { createApp } from './api.js';
import { createPiDriver } from './pi.js';
import { TaskRunner } from './runner.js';

const dataDir=resolve(process.env.FIELD_AGENT_DATA_DIR??fileURLToPath(new URL('../../../.data/',import.meta.url)));
mkdirSync(dataDir,{recursive:true,mode:0o700});chmodSync(dataDir,0o700);
const tokenPath=join(dataDir,'access-token');
let token=process.env.FIELD_AGENT_TOKEN;
if(!token) {
  try{token=readFileSync(tokenPath,'utf8').trim();}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token,{mode:0o600,flag:'wx'});}
}
const service=new FieldService(dataDir);
const runner=process.env.FIELD_AGENT_DISABLE_PI==='1'?undefined:new TaskRunner(service,createPiDriver(service));
const app=createApp(service,{token,runner,webDir:fileURLToPath(new URL('../../web/dist/',import.meta.url))});
const hostname=process.env.FIELD_AGENT_HOST??'127.0.0.1',port=Number(process.env.PORT??4310);
const server=serve({fetch:app.fetch,hostname,port},info=>{
  console.log(`Field Agent: http://${hostname}:${info.port}`);
  console.log(`App token: ${process.env.FIELD_AGENT_TOKEN?'provided through environment':tokenPath}`);
});
runner?.recover();
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;server.close();await runner?.close();service.store.close();process.exit(0);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
