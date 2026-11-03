import test from 'node:test';
import assert from 'node:assert/strict';
import {executePlan} from './executor-loop.mjs';
const candidate={id:'search',name:'Search',role:'combobox',action:'fill',binding:{role:'combobox',name:'Search'}};
function fixture({changed=false,apiError=false,actionError=false,verify=true,blocked}={}){
 const calls=[];
 const adapter={observe:async()=>({surface:{kind:'chrome',id:'test',url:'https://example.test'},candidates:[candidate],blocked}),guard:async()=>!changed,act:async()=>{calls.push('act');if(actionError)throw Error('unknown after input');},verify:async()=>({ok:verify,evidence:{visible:verify}})};
 const backend={decide:async()=>{calls.push('decide');if(apiError)throw Error('transport');return {route:'jev',status:'ready',selected:candidate,decision_ms:1};},begin:async()=>calls.push('begin'),finish:async(id,r)=>calls.push(r.outcome)};
 return {adapter,backend,calls};
}
const plan={steps:[{id:'one',target:'Search'},{id:'two',target:'Search'}]};
test('whole task executes locally with verification between actions',async()=>{const f=fixture();const r=await executePlan(f.adapter,f.backend,plan);assert.equal(r.status,'verified');assert.deepEqual(f.calls,['decide','begin','act','verified','decide','begin','act','verified']);});
test('changed live target never gets dispatched',async()=>{const f=fixture({changed:true});const r=await executePlan(f.adapter,f.backend,plan);assert.equal(r.reason,'target_changed');assert.deepEqual(f.calls,['decide']);});
test('API transport failure hands off without replay',async()=>{const f=fixture({apiError:true});const r=await executePlan(f.adapter,f.backend,plan);assert.equal(r.reason,'decision_transport_unknown');assert.deepEqual(f.calls,['decide']);});
test('unknown input result is recorded once and halts task',async()=>{const f=fixture({actionError:true});const r=await executePlan(f.adapter,f.backend,plan);assert.equal(r.reason,'unknown');assert.deepEqual(f.calls,['decide','begin','act','unknown']);});
test('failed consequence stops subsequent task steps',async()=>{const f=fixture({verify:false});const r=await executePlan(f.adapter,f.backend,plan);assert.equal(r.reason,'failed');assert.equal(f.calls.filter(x=>x==='act').length,1);});
test('website verification barrier causes no paid call or UI input',async()=>{const f=fixture({blocked:'google_verification_required'});const r=await executePlan(f.adapter,f.backend,plan);assert.equal(r.reason,'google_verification_required');assert.deepEqual(f.calls,[]);});
