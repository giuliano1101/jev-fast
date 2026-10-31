import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {executeBounded} from '../../src/control/server.js';
import {networkFixture,until} from '../helpers/network-fixture.js';
function launch(mode:string,config:string){const child=spawn(process.execPath,[resolve('dist/src/network/main.js'),mode,'--config',config],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));const closed=new Promise<number|null>((done,fail)=>{child.once('close',done);child.once('error',fail);});return {child,closed,get output(){return output;}};}
async function stop(process:{child:ChildProcess;closed:Promise<number|null>}){if(process.child.exitCode===null)process.child.kill('SIGTERM');const timer=setTimeout(()=>process.child.kill('SIGKILL'),10000);try{await process.closed;}finally{clearTimeout(timer);}}
test('documented private-config server and connector commands run as separate actual processes and terminate without secret output',{timeout:30000},async()=>{
 const f=await networkFixture({connector:false});let server:ReturnType<typeof launch>|undefined,connector:ReturnType<typeof launch>|undefined;
 try{
  const url=new URL(f.net.url),port=Number(url.port);await f.net.close();
  const files={'server.key':f.certs.server.key,'server.pem':f.certs.server.cert,'ca.pem':f.certs.ca,'mcp-token.json':JSON.stringify({token:f.tokens.mcp,expiresAt:f.expiresAt}),'connector-token.json':JSON.stringify({token:f.tokens.connector,expiresAt:f.expiresAt})};
  for(const [name,body]of Object.entries(files))await writeFile(join(f.root,name),body,{mode:0o600});
  const serverProfile=join(f.root,'server.json'),connectorProfile=join(f.root,'connector.json');
  await writeFile(serverProfile,JSON.stringify({host:'127.0.0.1',port,publicHost:url.host,allowedOrigins:[],deviceId:f.fixed.deviceId,agentId:f.fixed.agentId,storeDir:f.fixed.storeDir,tlsKeyFile:join(f.root,'server.key'),tlsCertFile:join(f.root,'server.pem'),mcpTokenFile:join(f.root,'mcp-token.json'),connectorTokenFile:join(f.root,'connector-token.json')}),{mode:0o600});
  await writeFile(connectorProfile,JSON.stringify({url:url.origin,deviceId:f.fixed.deviceId,agentId:f.fixed.agentId,journalDir:join(f.root,'process-journal'),credentialFile:join(f.runtime,'client-a.json'),tokenFile:join(f.root,'connector-token.json'),caFile:join(f.root,'ca.pem'),pollMs:50}),{mode:0o600});
  server=launch('server',serverProfile);
  await until(async()=>{try{return (await f.fetcher(url.origin+'/health')).status===200;}catch{return false;}},Boolean);
  connector=launch('connector',connectorProfile);const client=await f.client();await f.ready(client);
  const opened=await f.request(client,'jev.open_session','process-open',{fixture_id:'standard'});assert.equal(opened.delivery_status,'COMPLETED');assert.equal(opened.reply?.ok,true);const session_id=String((opened.reply!.result as {session_id:string}).session_id);
  const goal=await f.request(client,'jev.run_goal','process-goal',{session_id,goal_id:'process-g',idempotency_key:'process-k',goal:{task:'select',language:'en',seed:181},success:{kind:'task_complete'}});assert.equal(goal.delivery_status,'COMPLETED');assert.equal((goal.reply?.result as {status:string}).status,'SUCCEEDED');assert.equal(f.browser.physical,1);
  await stop(connector);assert.equal(await connector.closed,0);await stop(server);assert.equal(await server.closed,0);
  await assert.rejects(access(join(f.root,'process-journal','owner.lock')));await assert.rejects(access(join(f.fixed.storeDir,'owner.lock')));
  for(const text of [connector.output,server.output]){assert.ok(!text.includes(f.tokens.mcp));assert.ok(!text.includes(f.tokens.connector));}
 }finally{if(connector)await stop(connector);if(server)await stop(server);await f.close();}
});
test('network executable import and help are inert, invalid options reject without exposing paths',{timeout:10000},async()=>{
 const main=resolve('dist/src/network/main.js');
 for(const args of [['--help'],['server','--help'],['connector','--help']]){const result=await executeBounded(process.execPath,[main,...args]);assert.equal(result.code,0);assert.match(result.stdout,/config/);}
 const imported=await executeBounded(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify('file://'+main)})`]);assert.equal(imported.code,0);assert.equal(imported.stdout,'');
 const invalid=await executeBounded(process.execPath,[main,'server','--host','0.0.0.0']);assert.equal(invalid.code,1);assert.equal(invalid.stdout,'');
});
