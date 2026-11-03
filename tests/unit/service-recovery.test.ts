import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,lstat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const recoveryPath='../../src/service/recovery.js';
test('lock recovery removes only proven-dead private owner markers and preserves audit database',async()=>{
 const {removeDeadMarker}=await import(recoveryPath);const root=await mkdtemp(join(tmpdir(),'jev-dead-'));await chmod(root,0o700);
 try{
  await writeFile(join(root,'owner.lock'),JSON.stringify({pid:999999999}),{mode:0o600});await writeFile(join(root,'network.sqlite'),'KEEP',{mode:0o600});
  assert.equal(await removeDeadMarker(root,'owner.lock'),true);assert.equal(await readFile(join(root,'network.sqlite'),'utf8'),'KEEP');assert.equal(await removeDeadMarker(root,'owner.lock'),false);
  await assert.rejects(removeDeadMarker(root,'network.sqlite'),/UNSAFE_RECOVERY_PATH/);
  await writeFile(join(root,'owner.lock'),JSON.stringify({pid:process.pid}),{mode:0o600});await assert.rejects(removeDeadMarker(root,'owner.lock'),/RECOVERY_OWNER_ALIVE/);await rm(join(root,'owner.lock'));
  await symlink(join(root,'network.sqlite'),join(root,'owner.lock'));await assert.rejects(removeDeadMarker(root,'owner.lock'),/UNSAFE_RECOVERY_PATH/);assert.equal((await lstat(join(root,'owner.lock'))).isSymbolicLink(),true);
 }finally{await rm(root,{recursive:true,force:true});}
});
