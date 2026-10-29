import test from 'node:test';
import assert from 'node:assert/strict';
import {toolDefinitions,parseTool} from '../../src/service/contracts.js';

test('facade publishes exactly six strict JSON schemas derived from core',()=>{
 assert.deepEqual(toolDefinitions.map(t=>t.name),['jev.open_session','jev.observe','jev.run_goal','jev.cancel','jev.status','jev.close_session']);
 for(const t of toolDefinitions)assert.equal(t.inputSchema.additionalProperties,false);
 assert.deepEqual(parseTool('jev.open_session',{fixture_id:'standard'}),{fixture_id:'standard'});
});
test('facade refuses self-reported identity, executable inputs, malformed arguments and unknown methods',()=>{
 for(const args of [{fixture_id:'standard',client_id:'b'},{fixture_id:'standard',url:'https://evil.invalid'},{fixture_id:'standard',selector:'body'},{fixture_id:'standard',shell:'echo'},{fixture_id:'standard',javascript:'1'},null,[]])assert.throws(()=>parseTool('jev.open_session',args),/INVALID_ARGUMENTS/);
 assert.throws(()=>parseTool('jev.execute',{script:'1'}),/UNKNOWN_METHOD/);
 assert.throws(()=>parseTool('jev.status',{session_id:'s',action_id:'a',goal_id:'g'}),/INVALID_ARGUMENTS/);
 assert.throws(()=>parseTool('jev.run_goal',{session_id:'s',goal_id:'g',idempotency_key:'k',goal:{task:'form',language:'en',seed:1},success:{kind:'javascript'},max_steps:100}),/INVALID_ARGUMENTS/);
});

test('runtime cleanup attempts every resource and preserves the first failure',async()=>{
 const {cleanupAll}=await import('../../src/service/cleanup.js');const released:string[]=[];
 await assert.rejects(cleanupAll([async()=>{released.push('engine');throw new Error('first failure');},async()=>{released.push('browser');throw new Error('second failure');},async()=>{released.push('fixture');}]),/first failure/);
 assert.deepEqual(released,['engine','browser','fixture']);
});
