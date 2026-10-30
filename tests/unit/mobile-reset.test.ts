import test from 'node:test';
import assert from 'node:assert/strict';
import {resetMobileHome} from '../../bench/mobile/reset.js';
import type {ExecutionJournal} from '../../bench/hybrid/execution-journal.js';
function journal(pending=false){return {getPending:async()=>pending?{}:undefined,begin:async()=>{},acknowledge:async()=>{},reconcile:async()=>{}} as ExecutionJournal;}
const response=(nodes:unknown[])=>({status:'succeeded' as const,operationId:1,hostLocalResult:{content:[{type:'text',text:'Found these elements on screen: '+JSON.stringify(nodes)}]}});
const node=(ref:string,text:string,identifier?:string)=>({ref,type:'android.widget.TextView',text,identifier,coordinates:{x:0,y:200,width:100,height:50}});
test('reset refuses any device calls while a durable action is unresolved',async()=>{let calls=0;const result=await resetMobileHome({call:async()=>{calls++;return response([]);}},journal(true));assert.equal(result.status,'UNKNOWN');assert.equal(calls,0);});
test('reset stops on an unknown permission screen without clicking',async()=>{const names:string[]=[];const result=await resetMobileHome({call:async name=>{names.push(name);return response([node('@e1','允许')]);}},journal());assert.equal(result.status,'FAILED');assert.deepEqual(names,['mobile_launch_app','mobile_list_elements_on_screen']);});
test('reset verifies home and never touches a settings switch',async()=>{const names:string[]=[];const result=await resetMobileHome({call:async name=>{names.push(name);return response([node('@e1','蓝牙','android:id/title'),node('@e2','连接与共享','android:id/title'),node('@e3','搜索设置项','com.android.settings:id/animated_hint')]);}},journal());assert.equal(result.status,'SUCCEEDED');assert.deepEqual(names,['mobile_launch_app','mobile_list_elements_on_screen']);});
