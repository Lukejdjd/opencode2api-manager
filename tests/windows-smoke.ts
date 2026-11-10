// Actual Windows install/start/stop smoke test, isolated from user data.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if(process.platform!=='win32')throw new Error('This smoke test requires Windows.');
const temp=mkdtempSync(path.join(os.tmpdir(),'oc2-manager-'));const root=path.join(temp,'gateway with spaces');mkdirSync(root);const state=path.join(temp,'state');const provider=path.join(temp,'opencode.jsonc');writeFileSync(provider,'{}');
const env={...process.env,OPENCODE2API_MANAGER_DATA_DIR:state};
const run=(...args:string[])=>execFileSync(process.execPath,['cli/main.js',...args],{env,encoding:'utf8',timeout:180000});
try{
 run('settings',JSON.stringify({root,binary:path.join(root,'opencode2api.exe'),configPath:path.join(root,'config.json'),providerPath:provider,launchLabel:''}));
 console.log(run('install'));const status=JSON.parse(run('status'));if(!status.health?.ready)throw new Error('Installed gateway not ready.');
 console.log(run('connect'));console.log(run('sync'));console.log(run('stop'));console.log(run('start'));console.log(run('stop'));console.log('Windows official binary: checksum, ZIP extraction, setup, start, provider sync, stop/restart passed.');
}finally{try{run('stop');}catch{}rmSync(temp,{recursive:true,force:true});}
