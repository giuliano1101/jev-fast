import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,lstatSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installCodexDefaults} from '../install.mjs';

test('portable Codex install renders paths, preserves unrelated policy and credentials, and updates one managed block',()=>{
  const temp=mkdtempSync(join(tmpdir(),'jev-install-'));
  const root=join(temp,"Jev's 本机"),codexHome=join(temp,'Codex 空间');
  try{
    mkdirSync(join(root,'direct'),{recursive:true});writeFileSync(join(root,'direct/index.mjs'),'export {};');
    cpSync(new URL('../../skills/',import.meta.url),join(root,'skills'),{recursive:true});
    cpSync(new URL('../codex-policy.md',import.meta.url),join(root,'direct/codex-policy.md'));
    mkdirSync(codexHome);writeFileSync(join(codexHome,'AGENTS.md'),'# My unrelated rule\nPreserve project settings.\n');
    mkdirSync(join(root,'.runtime/direct'),{recursive:true,mode:0o700});
    const key=join(root,'.runtime/direct/api-key');writeFileSync(key,'offline-secret',{mode:0o600});
    const first=installCodexDefaults({root,codexHome});
    assert.equal(first.paidCalls,0);assert.equal(readFileSync(key,'utf8'),'offline-secret');
    const skill=readFileSync(first.skill,'utf8');assert.ok(skill.includes(root));assert.doesNotMatch(skill,/\{\{JEV_/);
    const api=readFileSync(join(codexHome,'skills/jev-direct/references/api.md'),'utf8');
    assert.ok(api.includes('from '+JSON.stringify(join(root,'direct/index.mjs'))));
    const original=readFileSync(first.globalPolicy,'utf8');assert.ok(original.startsWith('# My unrelated rule'));
    const second=installCodexDefaults({root,codexHome});
    assert.equal(readFileSync(second.globalPolicy,'utf8'),original);
    assert.equal((original.match(/<!-- jev-official-direct:begin -->/g)||[]).length,1);
    assert.equal(readFileSync(join(second.backup,'AGENTS.md'),'utf8'),original);
    if(process.platform!=='win32')assert.equal(lstatSync(first.skill).mode&0o777,0o600);
    // A malformed managed section is rejected before the global file changes.
    writeFileSync(first.globalPolicy,original+'\n<!-- jev-official-direct:begin -->');
    assert.throws(()=>installCodexDefaults({root,codexHome}),/POLICY_BLOCK_INVALID/);
    assert.equal(readFileSync(key,'utf8'),'offline-secret');
  }finally{rmSync(temp,{recursive:true,force:true});}
});

test('Codex policy symlink is never followed or overwritten',()=>{
  if(process.platform==='win32')return;
  const temp=mkdtempSync(join(tmpdir(),'jev-install-link-'));
  try{
    const target=join(temp,'keep.md');writeFileSync(target,'keep');symlinkSync(target,join(temp,'AGENTS.md'));
    assert.throws(()=>installCodexDefaults({codexHome:temp}),/UNSAFE_INSTALL_TARGET/);
    assert.equal(readFileSync(target,'utf8'),'keep');
  }finally{rmSync(temp,{recursive:true,force:true});}
});
