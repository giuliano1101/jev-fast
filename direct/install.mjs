import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const begin='<!-- jev-official-direct:begin -->',end='<!-- jev-official-direct:end -->';
function plain(path,directory=false){
  if(!existsSync(path))return;
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile()))throw Error('UNSAFE_INSTALL_TARGET');
}
function files(directory,prefix=''){
  return readdirSync(directory,{withFileTypes:true}).flatMap(e=>{
    if(e.isSymbolicLink())throw Error('UNSAFE_SKILL_SOURCE');
    const rel=join(prefix,e.name);return e.isDirectory()?files(join(directory,e.name),rel):[rel];
  });
}
function atomic(path,content){
  plain(path);const temp=path+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temp,content,{mode:0o600,flag:'wx'});renameSync(temp,path);}finally{rmSync(temp,{force:true});}
}

/** Install local Codex policy/skill only. No GUI, credentials, network or model calls. */
export function installCodexDefaults({root=sourceRoot,codexHome=process.env.CODEX_HOME||join(homedir(),'.codex'),nodePath=process.execPath}={}){
  root=resolve(root);codexHome=resolve(codexHome);nodePath=resolve(nodePath);
  if([root,codexHome,nodePath].some(value=>/[\r\n`]/.test(value)))throw Error('UNSUPPORTED_INSTALL_PATH');
  if(!existsSync(join(root,'direct/index.mjs')))throw Error('JEV_MODULE_NOT_FOUND');
  plain(codexHome,true);mkdirSync(codexHome,{recursive:true,mode:0o700});
  const source=join(root,'skills/jev-direct'),target=join(codexHome,'skills/jev-direct'),agents=join(codexHome,'AGENTS.md');
  plain(join(codexHome,'skills'),true);plain(target,true);plain(agents);
  const replacements={JEV_ROOT:root,JEV_NODE:nodePath,JEV_CODEX_HOME:codexHome,JEV_MODULE_JSON:JSON.stringify(join(root,'direct/index.mjs'))};
  const render=text=>{
    let result=text.replace(/\{\{(JEV_[A-Z_]+)\}\}/g,(_match,name)=>{if(!(name in replacements))throw Error('UNKNOWN_SKILL_TOKEN');return replacements[name];});
    if(/\{\{JEV_/.test(result))throw Error('UNRESOLVED_SKILL_TOKEN');return result;
  };
  const staged=files(source).map(rel=>({rel,content:render(readFileSync(join(source,rel),'utf8'))}));
  const prior=existsSync(agents)?readFileSync(agents,'utf8'):'';
  const starts=prior.split(begin).length-1,ends=prior.split(end).length-1;
  if(starts!==ends||starts>1||(starts===1&&prior.indexOf(begin)>prior.indexOf(end)))throw Error('POLICY_BLOCK_INVALID');
  const template=render(readFileSync(join(root,'direct/codex-policy.md'),'utf8')).trim();
  const block=begin+'\n'+template+'\n'+end;
  const policy=starts?prior.slice(0,prior.indexOf(begin))+block+prior.slice(prior.indexOf(end)+end.length):(prior+(prior&&!prior.endsWith('\n')?'\n':'')+'\n'+block+'\n');
  const backup=join(codexHome,'skill-backups','jev-direct-'+Date.now()+'-'+randomUUID());
  mkdirSync(backup,{recursive:true,mode:0o700});
  if(existsSync(agents))copyFileSync(agents,join(backup,'AGENTS.md'));
  mkdirSync(target,{recursive:true,mode:0o700});
  for(const {rel,content} of staged){
    const destination=join(target,rel),parent=join(target,rel,'..');plain(parent,true);mkdirSync(parent,{recursive:true,mode:0o700});plain(destination);
    if(existsSync(destination)){const saved=join(backup,'skill',rel);mkdirSync(join(saved,'..'),{recursive:true,mode:0o700});copyFileSync(destination,saved);}
    atomic(destination,content);
  }
  atomic(agents,policy);
  return {root,skill:join(target,'SKILL.md'),globalPolicy:agents,backup,nodePath,keyFile:join(root,'.runtime/direct/api-key'),paidCalls:0,
    note:'Reload/new Codex chat to discover policy; provide API Key privately on this machine and verify actual OS permissions.'};
}
