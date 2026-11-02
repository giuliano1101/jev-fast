import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,readFileSync,writeFileSync,utimesSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const script=join(process.cwd(),'scripts/usage-router.mjs');
const api=await import(script);
const shadow={enabled:true,mode:'shadow',log_path:null};const active={enabled:true,mode:'active',log_path:null};
const now=Date.parse('2026-11-02T18:00:00Z');
const env={};

test('ask_human: LOGIN_BLOCKER, creator-center login walls, QR and credential steps',()=>{
 assert.equal(api.decide({goal:'打开创作者中心作品管理',task_type:'browser_act',last_error:'LOGIN_BLOCKER'}).action,'ask_human');
 assert.equal(api.decide({goal:'open creator center',task_type:'browser_observe',observation:'抖音创作者中心 扫码登录 手机号登录'}).action,'ask_human');
 assert.equal(api.decide({goal:'continue',task_type:'browser_act',observation:'Please log in to continue'}).action,'ask_human');
 assert.equal(api.decide({goal:'enter the verification code',task_type:'host_act'}).action,'ask_human');
 assert.equal(api.decide({goal:'check settings',task_type:'host_act',last_error:'ACCESSIBILITY_DENIED'}).action,'ask_human');
 assert.equal(api.decide({goal:'read title',task_type:'browser_observe',observation:'首页 登录 关于我们'}).action,'proceed','a plain header login link is not a wall');
});

test('ask_human: send/publish/pay/delete, but not reading already-published lists',()=>{
 for(const goal of ['发布视频到抖音','send the email to Bob','Publish the draft','checkout and pay','删除这条评论','upload the photo','post to X'])assert.equal(api.decide({goal,task_type:'browser_act'}).action,'ask_human',goal);
 assert.equal(api.decide({goal:'筛选已发布作品并按播放排序',task_type:'browser_act'}).action,'proceed');
 assert.equal(api.decide({goal:'list published posts',task_type:'browser_observe'}).action,'proceed');
});

test('ask_human outranks every other rule',()=>{
 assert.equal(api.decide({goal:'发布视频',task_type:'retry',last_error:'HOST_ACTION_UNKNOWN',repeats:9}).action,'ask_human');
 assert.equal(api.decide({goal:'publish',task_type:'research',observes:50},shadow,{artifact_age_s:1}).action,'ask_human');
});

test('stop_retry: UNKNOWN, terminal errors, identical error text, repeat limit',()=>{
 assert.equal(api.decide({goal:'click',task_type:'browser_act',last_error:'execution: unknown'}).action,'stop_retry');
 assert.equal(api.decide({goal:'click',task_type:'host_act',last_error:'HOST_ACTION_UNKNOWN'}).action,'stop_retry');
 assert.equal(api.decide({goal:'click',task_type:'retry',last_error:'CONTINUATION_INVALID'}).action,'stop_retry');
 assert.equal(api.decide({goal:'click search',task_type:'retry',last_error:'Timeout 3000ms waiting for control c12',previous_error:'timeout 5000ms  waiting for control c9'}).action,'stop_retry');
 assert.equal(api.decide({goal:'click',task_type:'retry',last_error:'INVALID_ARGUMENTS',repeats:2}).action,'stop_retry');
 const first=api.decide({goal:'click',task_type:'retry',last_error:'INVALID_ARGUMENTS',repeats:1});
 assert.equal(first.action,'proceed');assert.ok(first.confidence<0.75);
 assert.equal(api.decide({goal:'click',task_type:'retry',last_error:'Timeout',previous_error:'INVALID_ARGUMENTS'}).action,'proceed');
 assert.equal(api.decide({goal:'click',task_type:'retry',last_error:'E1',previous_error:'E2'}).action,'proceed','distinct bare codes are different errors');
 assert.equal(api.decide({goal:'click',task_type:'retry',last_error:'stale_snapshot',previous_error:'STALE_SNAPSHOT'}).action,'stop_retry');
});

test('reuse_cache: fresh artifact or fresh observe; stale or errored does not reuse',()=>{
 assert.equal(api.decide({goal:'shot',task_type:'browser_open',artifact_path:'a.png'},shadow,{artifact_age_s:60}).action,'reuse_cache');
 assert.equal(api.decide({goal:'shot',task_type:'browser_open',artifact_path:'a.png'},shadow,{artifact_age_s:901}).action,'proceed');
 assert.equal(api.decide({goal:'shot',task_type:'browser_open',artifact_path:'a.png',last_error:'BUSY'},shadow,{artifact_age_s:1}).action,'proceed');
 assert.equal(api.decide({goal:'find price',task_type:'browser_observe'},shadow,{observe_age_s:30}).action,'reuse_cache');
 assert.equal(api.decide({goal:'click',task_type:'browser_act'},shadow,{observe_age_s:30}).action,'proceed');
});

test('research_capped after N observes on research-type steps only',()=>{
 assert.equal(api.decide({goal:'find price',task_type:'browser_observe',observes:3}).action,'research_capped');
 assert.equal(api.decide({goal:'find price',task_type:'research',observes:2}).action,'proceed');
 assert.equal(api.decide({goal:'find price',task_type:'research',observes:5},{...shadow,research_cap:6}).action,'proceed');
 assert.equal(api.decide({goal:'click',task_type:'browser_act',observes:10}).action,'proceed');
});

test('proceed is the default with a confidence in 0..1',()=>{
 const d=api.decide({goal:'Open https://example.com',task_type:'browser_open'});
 assert.equal(d.action,'proceed');assert.ok(d.confidence>0&&d.confidence<=1);
 for(const a of api.ACTIONS)assert.ok(['proceed','reuse_cache','stop_retry','research_capped','ask_human'].includes(a));
});

test('input validation rejects unknown fields so tokens are never logged',()=>{
 assert.throws(()=>api.decide({goal:'g',task_type:'t',continuation_token:'secret'}),/unknown field continuation_token/);
 assert.throws(()=>api.decide({task_type:'t'}),/required/);
 assert.throws(()=>api.decide({goal:'g',task_type:'t',repeats:-1}),/non-negative/);
 assert.throws(()=>api.normalizeConfig({mode:'enforce'}),/shadow or active/);
});

test('shadow logs but keeps effective_action proceed; active enforces; kill switches disable',async()=>{
 const state={goal:'发布视频',task_type:'host_act'};
 const s=await api.route(state,shadow,{now,env});assert.equal(s.action,'ask_human');assert.equal(s.effective_action,'proceed');assert.equal(s.enforced,false);
 const a=await api.route(state,active,{now,env});assert.equal(a.effective_action,'ask_human');assert.equal(a.enforced,true);
 const off=await api.route(state,{...active,enabled:false},{now,env});assert.equal(off.effective_action,'proceed');assert.equal(off.enabled,false);
 const envOff=await api.route(state,active,{now,env:{JEV_USAGE_ROUTER:'off'}});assert.equal(envOff.effective_action,'proceed');assert.equal(envOff.enabled,false);
 for(const notes of ['bypass jev router','please BYPASS usage router now']){const b=await api.route({...state,notes},active,{now,env});assert.equal(b.bypassed,true);assert.equal(b.effective_action,'proceed');}
});

test('route resolves artifact freshness from disk and appends JSONL only when enabled',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jev-usage-router-'));
 try{
  const artifact=join(root,'shot.png');writeFileSync(artifact,'x');utimesSync(artifact,new Date(now-60_000),new Date(now-60_000));
  const log=join(root,'logs','decisions.jsonl');
  const r=await api.route({goal:'shot',task_type:'browser_open',artifact_path:artifact},{...active,log_path:log},{now,env});
  assert.equal(r.effective_action,'reuse_cache');assert.equal(r.logged,true);
  await api.route({goal:'g',task_type:'browser_open',artifact_path:join(root,'missing.png')},{...shadow,log_path:log},{now,env});
  const lines=readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(lines.length,2);assert.equal(lines[0].ts,'2026-11-02T18:00:00.000Z');assert.equal(lines[0].mode,'active');assert.equal(lines[1].action,'proceed');assert.equal(lines[1].mode,'shadow');
  assert.deepEqual(Object.keys(lines[0]).sort(),['action','bypassed','confidence','effective_action','enabled','enforced','input','mode','reason','ts']);
  writeFileSync(join(root,'blocker'),'');
  const broken=await api.route({goal:'g',task_type:'t'},{...shadow,log_path:join(root,'blocker','x.jsonl')},{now,env});
  assert.equal(broken.logged,false);assert.match(broken.log_error,/ENOTDIR|EEXIST/);assert.equal(broken.effective_action,'proceed');
  const offLog=join(root,'off.jsonl');await api.route({goal:'g',task_type:'t'},{...shadow,enabled:false,log_path:offLog},{now,env});assert.equal(existsSync(offLog),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('CLI prints branchable JSON and exits 2 on bad input',()=>{
 const root=mkdtempSync(join(tmpdir(),'jev-usage-router-cli-'));
 try{
  const config=join(root,'c.json');writeFileSync(config,JSON.stringify({enabled:true,mode:'active',log_path:null}));
  const out=JSON.parse(execFileSync(process.execPath,[script,'--config',config,'--task-type','browser_act','--goal','open creator center','--last-error','LOGIN_BLOCKER'],{encoding:'utf8',env:{...process.env,JEV_USAGE_ROUTER:''}}));
  assert.equal(out.effective_action,'ask_human');
  const shipped=JSON.parse(readFileSync(join(process.cwd(),'config/usage-router.json'),'utf8'));assert.equal(shipped.enabled,true);assert.equal(shipped.mode,'shadow');
  assert.throws(()=>execFileSync(process.execPath,[script,'--config',config,'--state','{"goal":"g","task_type":"t","continuation_token":"x"}'],{encoding:'utf8',stdio:'pipe'}),(e:{status:number})=>e.status===2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
