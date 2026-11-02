import {Fault} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import type {Executor,Observation} from './router.js';
import type {JsonObject} from './network-client.js';

export interface PanelProfile {id:string;url:string;statusPath:string;actions:Record<string,{method:'POST';path:string;body:JsonObject}>}
export function jsonPointer(value:unknown,pointer:string):unknown{
 if(pointer==='')return value;if(!pointer.startsWith('/'))throw new Fault('INVALID_JSON_POINTER');
 let current=value;for(const part of pointer.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~'))){if(!current||typeof current!=='object')return;current=(current as JsonObject)[part];}return current;
}
export class LocalPanel {
 constructor(readonly profile:PanelProfile){
  const u=new URL(profile.url);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/')throw new Fault('PANEL_MUST_BE_LOCAL');
  for(const path of [profile.statusPath,...Object.values(profile.actions).map(a=>a.path)])if(!path.startsWith('/')||path.startsWith('//')||path.includes('..')||path.includes('#'))throw new Fault('INVALID_PANEL_PATH');
 }
 private async call(path:string,body?:JsonObject){
  const response=await fetch(new URL(path,this.profile.url),{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Fault('PANEL_HTTP_FAILURE');return await response.json() as JsonObject;
 }
 async observe():Promise<Observation>{const state=await this.call(this.profile.statusPath);return {snapshot_id:canonicalDigest(state),state};}
 executor():Executor{return {
  name:'local-panel',resource:'local-panel-'+this.profile.id,observe:async()=>await this.observe(),
  validate:async(_target,snapshot,action)=>{if(!this.profile.actions[String(action.action_id)]||Object.keys(action).some(k=>k!=='action_id'))throw new Fault('PANEL_ACTION_NOT_CONFIGURED');if((await this.observe()).snapshot_id!==snapshot)throw new Fault('STALE_SNAPSHOT');},
  execute:async(_target,action)=>{const configured=this.profile.actions[String(action.action_id)]!;return await this.call(configured.path,configured.body);},
  verify:async(_target,expected,result)=>{
   const after=await this.observe();const checks:boolean[]=[];
   if(typeof expected.statePointer==='string'&&'equals'in expected)checks.push(canonicalDigest(jsonPointer(after.state,expected.statePointer)??null)===canonicalDigest(expected.equals));
   if(typeof expected.receiptPointer==='string'&&'receiptEquals'in expected)checks.push(canonicalDigest(jsonPointer(result,expected.receiptPointer)??null)===canonicalDigest(expected.receiptEquals));
   return {met:checks.length>0&&checks.every(Boolean),state:after,note:'Panel state and receipt only; no claim of cloud video/audio or RTC verification.'};
  }
 };}
}
