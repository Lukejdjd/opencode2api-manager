import http from 'node:http';
import { createServiceHost } from '@openchamber/sdk';
import * as m from './manager';
const token=process.env.OPENCHAMBER_SERVICE_TOKEN;
const port=Number(process.env.OPENCHAMBER_SERVICE_PORT);
if(!token||!Number.isInteger(port)||port<1||port>65535)throw new Error('Service port/token missing. Start through OpenChamber.');
const host=process.env.OPENCHAMBER_HOST_CALLBACK_URL?createServiceHost({env:process.env}):null;
let job:any=null;let healthCache:any=null;let cacheAt=0;
async function info(force=false){if(force||Date.now()-cacheAt>10000){healthCache=await m.snapshot(force);cacheAt=Date.now();}return {...healthCache,job};}
const operations:Record<string,(data:any)=>Promise<any>>={install:()=>m.install(),update:()=>m.update(),start:()=>m.serviceControl('start'),stop:()=>m.serviceControl('stop'),restart:()=>m.serviceControl('restart'),warp:d=>m.setWarp(d),sync:()=>m.syncModels(),connect:d=>m.connectProvider(d.legacy===true)};
async function run(op:string,data:any){if(!operations[op])throw new Error('Unknown operation.');if(job?.status==='running')throw new Error('An operation is already running.');job={operation:op,status:'running',startedAt:Date.now()};
 void m.exclusive(()=>operations[op]!(data)).then(result=>{job={...job,status:'ok',result};},error=>{job={...job,status:'error',message:error instanceof Error?error.message:'Operation failed.'};}).finally(async()=>{cacheAt=0;try{await host?.emit('manager-changed',{});}catch{}});return {accepted:true,job};}
async function route(method:string,path:string,body:any){
 if(method==='GET'&&path==='/health')return {ok:true};
 if(method==='GET'&&path==='/snapshot')return info();
 if(method==='GET'&&path==='/logs')return m.logs();
 if(method==='POST'&&path==='/check')return info(true);
 if(method==='POST'&&path==='/settings'){const result=await m.exclusive(()=>m.saveSettings(body));cacheAt=0;return result;}
 if(method==='POST'&&path==='/local-key')return m.readLocalKey();
 if(method==='POST'&&path==='/action')return run(body.action,body);
 if(method==='POST'&&path==='/schedule'){void (async()=>{await m.release();const s=await m.settings();if(s.autoSync&&!job?.status?.includes('running'))await m.exclusive(()=>m.syncModels());cacheAt=0;})().catch(()=>{});return {ok:true};}
 if(path==='/status'&&method==='POST'){if(body.id==='check'){await m.release(true);cacheAt=0;return {ok:true};}throw new Error('Unknown status action.');}
 if(path==='/status'&&method==='GET'){const x=await info();return {rows:[
 {kind:'line',id:'gateway',label:'Gateway',dot:x.health?.ready?'success':'warning',value:x.health?.version??(x.installed?'Stopped':'Not installed')},
 {kind:'line',id:'version',label:'Updates',value:x.release.error?'Check unavailable':x.updateAvailable?`${x.release.tag} available`:x.release.tag?`Latest ${x.release.tag}`:'Not checked',valueTone:x.updateAvailable?'warning':'muted',actions:[{kind:'button',id:'check',label:'Check',variant:'outline'}]},
 {kind:'line',id:'warp',label:'WARP',value:x.health?.warp?`${x.health.warp.active??0} active · ${x.health.warp.standby??0} standby · ${x.health.warp.cooling??0} cooling`:x.warp?.enabled?'Starting':'Off'},
 {kind:'line',id:'models',label:'Models',value:`${x.health?.models?.exposed??'—'} · sync ${x.settings.autoSync?'on':'off'}`},
 ...(job?.status==='running'?[{kind:'note',id:'job',text:`${job.operation} in progress…`,tone:'info'}]:[])
 ]};}
 return null;
}
http.createServer((req,res)=>{
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
 let raw='';let tooLarge=false;req.on('data',chunk=>{raw+=chunk;if(raw.length>65536){tooLarge=true;req.destroy();}});
 req.on('end',()=>{if(tooLarge)return;let body:any={};try{if(raw)body=JSON.parse(raw);}catch{res.writeHead(400).end('{"message":"Invalid JSON"}');return;}
 route(req.method??'GET',new URL(req.url??'/','http://localhost').pathname,body).then(answer=>{res.writeHead(answer===null?404:200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(answer??{}));},error=>{res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({message:error instanceof Error?error.message:'Request failed.'}));});});
}).listen(port,'127.0.0.1');
