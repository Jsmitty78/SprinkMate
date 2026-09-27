import { JevSourceSearch } from './sources/semantic.js';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { workflowLlmFromEnv, JevHttpClient } from '@sprink/workflow';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { serve } from '@hono/node-server';
import { FieldService } from './service.js';
import { createApp } from './api.js';
import { WorkPackageStore } from './work-packages/store.js';
import { createIntegratedServices } from './integration/runtime.js';

const dataDir=resolve(process.env.SPRINK_DATA_DIR??fileURLToPath(new URL('../../../.data/',import.meta.url)));
mkdirSync(dataDir,{recursive:true,mode:0o700});chmodSync(dataDir,0o700);
const tokenPath=join(dataDir,'access-token');
let token=process.env.SPRINK_TOKEN;
if(!token) {
  try{token=readFileSync(tokenPath,'utf8').trim();}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token,{mode:0o600,flag:'wx'});}
}
// Project-local credentials override inherited keys without logging either value.
let localEnv: NodeJS.ProcessEnv = {};
try { localEnv = parseEnv(readFileSync(fileURLToPath(new URL('../../../.env.local', import.meta.url)), 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const llm = workflowLlmFromEnv(process.env, localEnv);
const jevKey = localEnv.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY;
const sourceSearch = new JevSourceSearch(jevKey);
const service=new FieldService(dataDir);
const integrated=createIntegratedServices(new WorkPackageStore(service.store.db),dataDir,{llm,sourceSearch, ...(jevKey ? {choice: new JevHttpClient(jevKey)} : {})});
const app=createApp(service,{token,sourceSearch,workPackages:integrated.packages,workPackageExports:integrated.exports,workPackageDetails:integrated.details,webDir:fileURLToPath(new URL('../../web/dist/',import.meta.url))});
const hostname=process.env.SPRINK_HOST??'127.0.0.1',port=Number(process.env.PORT??4310);
const server=serve({fetch:app.fetch,hostname,port},info=>{
  console.log(`Sprink: http://${hostname}:${info.port}`);
  console.log(`App token: ${process.env.SPRINK_TOKEN?'provided through environment':tokenPath}`);
});
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;server.close();integrated.packages.close();service.store.close();process.exit(0);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
