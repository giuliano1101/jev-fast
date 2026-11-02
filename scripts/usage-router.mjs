#!/usr/bin/env node
// Jev usage router: an agent-side pre-flight / retry gate for the jev-fast MCP flow.
// Zero dependencies so other AIs can run it with plain `node` (no npm ci, no build) or import route().
// It never calls Jev or any network service, and it does not replace the signed jev.choose_action.
import {existsSync} from 'node:fs';
import {appendFile,mkdir,readFile,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const ACTIONS=['proceed','reuse_cache','stop_retry','research_capped','ask_human'];
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const inCheckout=existsSync(resolve(repoRoot,'package.json'))&&existsSync(resolve(repoRoot,'config'));
export const DEFAULT_CONFIG_PATH=resolve(repoRoot,'config/usage-router.json');
export const DEFAULT_CONFIG=Object.freeze({enabled:true,mode:'shadow',max_repeats:2,research_cap:3,cache_max_age_s:900,log_path:'artifacts/usage-router/decisions.jsonl'});

const STRING_FIELDS={goal:2000,task_type:100,last_error:1000,previous_error:1000,notes:2000,observation:4000,artifact_path:1000,observed_at:64};
const COUNT_FIELDS=['repeats','observes'];

// Pages often carry a header "登录" link, so observation text only trips on explicit walls.
const LOGIN_WALL=/扫码登录|二维码登录|请先?登录|登录后(?:查看|继续|使用)|登录以继续|未登录|账号登录|验证码登录|人机验证|安全验证|滑块|log\s*in\s+to\s+(?:continue|view)|sign\s*in\s+to\s+(?:continue|view)|please\s+(?:log|sign)\s*in|scan\s+(?:the\s+)?qr|captcha|verify\s+you\s+are\s+human/i;
const HUMAN_STEP=/\b(log\s*in|login|sign\s*in|sign\s*up|password|passcode|2fa|mfa|otp|one[-\s]?time\s+code|captcha|qr\s*code|verification\s+code)\b|登录|登陆|注册账号|密码|验证码|二维码|扫码/i;
const HUMAN_ERROR=/LOGIN_BLOCKER|LOGIN_WALL|LOGIN_REQUIRED|AUTH_REQUIRED|CAPTCHA|QR_REQUIRED|PERMISSION_REQUIRED|ACCESSIBILITY_DENIED|SCREEN_CAPTURE_DENIED/i;
const IRREVERSIBLE=/\b(send|reply\s+to|publish|post\s+(?:to|on|a|the)|tweet|retweet|upload|pay|payment|purchase|buy|checkout|place\s+(?:an\s+)?order|transfer|donate|subscribe|delete|erase|uninstall|wipe|unfollow)\b|发送|(?<!已|未|待)发布|发帖|发表|发消息|发评论|回复评论|上传|支付|付款|购买|下单|转账|打赏|订阅|删除|清空|卸载|禁发/i;
const UNKNOWN_ERROR=/(^|[^A-Z])(UNKNOWN|DECISION_UNKNOWN|HOST_ACTION_UNKNOWN)([^A-Z]|$)|execution\s*:\s*unknown/i;
const TERMINAL_ERROR=/CONTINUATION_INVALID|ADMISSION_REQUIRED|REQUEST_NOT_FOUND|IDEMPOTENCY_CONFLICT|SERVICE_PROFILE_MISMATCH|NETWORK_NOT_READY/i;
const TRANSIENT_ERROR=/BUSY|STALE_SNAPSHOT|navigation_pending|ETIMEDOUT|ECONNRESET|\b429\b/i;
const RESEARCH_TASK=/^(research|search|observe|browser_observe|host_observe|read|fetch|explore|investigate|subagent|extra_research)$/i;
const BYPASS=/bypass\s+(jev|usage)\s+router/i;

export class UsageRouterInputError extends Error{}

export function normalizeState(input){
 if(typeof input!=='object'||input===null||Array.isArray(input))throw new UsageRouterInputError('state must be a JSON object');
 const state={};
 for(const [key,value] of Object.entries(input)){
  if(value===undefined||value===null||value==='')continue;
  if(key in STRING_FIELDS){if(typeof value!=='string'||value.length>STRING_FIELDS[key])throw new UsageRouterInputError(`${key} must be a string of at most ${STRING_FIELDS[key]} characters`);state[key]=value;}
  else if(COUNT_FIELDS.includes(key)){const n=typeof value==='string'?Number(value):value;if(!Number.isInteger(n)||n<0)throw new UsageRouterInputError(`${key} must be a non-negative integer`);state[key]=n;}
  else throw new UsageRouterInputError(`unknown field ${key}; never pass continuation_token or credentials`);
 }
 if(!state.goal||!state.task_type)throw new UsageRouterInputError('goal and task_type are required');
 return {repeats:0,observes:0,...state};
}

export function normalizeConfig(input={}){
 const config={...DEFAULT_CONFIG,...input};
 if(typeof config.enabled!=='boolean')throw new UsageRouterInputError('config.enabled must be boolean');
 if(!['shadow','active'].includes(config.mode))throw new UsageRouterInputError('config.mode must be shadow or active');
 for(const key of ['max_repeats','research_cap','cache_max_age_s'])if(!Number.isInteger(config[key])||config[key]<1)throw new UsageRouterInputError(`config.${key} must be a positive integer`);
 if(config.log_path!==null&&typeof config.log_path!=='string')throw new UsageRouterInputError('config.log_path must be a path or null');
 return config;
}

// Bare codes (E1, HOST_429) compare exactly; free text ignores ids, counts and durations.
const errorKey=value=>{const t=value.trim();return /^[A-Z0-9_.:-]+$/i.test(t)?t.toUpperCase():t.toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}|\d+/g,'#').replace(/\s+/g,' ');};
const sameError=(a,b)=>!!a&&!!b&&errorKey(a)===errorKey(b);

/**
 * Pure rubric. `facts.artifact_age_s` / `facts.observe_age_s` are seconds since the artifact/observe, when known.
 * ask_human is checked first so no later rule can mask a human gate.
 */
export function decide(rawState,rawConfig=DEFAULT_CONFIG,facts={}){
 const state=normalizeState(rawState),config=normalizeConfig(rawConfig);
 const intent=[state.goal,state.task_type,state.notes??''].join('\n'),error=state.last_error??'';
 if(HUMAN_ERROR.test(error)||LOGIN_WALL.test(state.observation??'')||LOGIN_WALL.test(error))return {action:'ask_human',confidence:0.95,reason:'login wall / QR / captcha / OS permission blocks the step; a human must clear it'};
 if(HUMAN_STEP.test(intent))return {action:'ask_human',confidence:0.9,reason:'step involves login, password, QR or verification code; a human must do it'};
 if(IRREVERSIBLE.test(intent))return {action:'ask_human',confidence:0.9,reason:'step may send, publish, upload, pay or delete; needs explicit human approval'};
 if(UNKNOWN_ERROR.test(error))return {action:'stop_retry',confidence:0.95,reason:'UNKNOWN outcome: stop, keep request_id/idempotency_key, query original status; never replay with a new key'};
 if(TERMINAL_ERROR.test(error))return {action:'stop_retry',confidence:0.85,reason:'error is not fixed by repeating the same call; report it'};
 if(sameError(error,state.previous_error))return {action:'stop_retry',confidence:0.9,reason:'same error text repeated; abandon this approach and report'};
 if(error&&state.repeats>=config.max_repeats)return {action:'stop_retry',confidence:0.85,reason:`same approach already failed ${state.repeats} time(s) (max_repeats ${config.max_repeats})`};
 if(!error&&facts.artifact_age_s!==undefined&&facts.artifact_age_s<=config.cache_max_age_s)return {action:'reuse_cache',confidence:0.85,reason:`artifact ${state.artifact_path} is ${Math.round(facts.artifact_age_s)}s old; reuse it instead of re-running`};
 if(!error&&RESEARCH_TASK.test(state.task_type)&&facts.observe_age_s!==undefined&&facts.observe_age_s<=config.cache_max_age_s)return {action:'reuse_cache',confidence:0.75,reason:`last observe is ${Math.round(facts.observe_age_s)}s old and nothing changed; reuse it`};
 if(RESEARCH_TASK.test(state.task_type)&&state.observes>=config.research_cap)return {action:'research_capped',confidence:0.8,reason:`${state.observes} observes/sources already (research_cap ${config.research_cap}); write up what you have`};
 if(TRANSIENT_ERROR.test(error))return {action:'proceed',confidence:0.6,reason:'transient error; take a fresh observe before acting again'};
 if(error)return {action:'proceed',confidence:0.55,reason:`retry allowed (${state.repeats+1}/${config.max_repeats}); change something first`};
 return {action:'proceed',confidence:0.75};
}

async function ageSeconds(path,now){try{const info=await stat(path);return info.isFile()||info.isDirectory()?Math.max(0,(now-info.mtimeMs)/1000):undefined;}catch{return undefined;}}

export async function loadConfig(path=process.env.JEV_USAGE_ROUTER_CONFIG??DEFAULT_CONFIG_PATH){
 let raw;
 try{raw=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return normalizeConfig();throw error;}
 return normalizeConfig(JSON.parse(raw));
}

/**
 * Decide, resolve the caller-visible `effective_action`, and append to the JSONL log when enabled.
 * Shadow and bypass always yield effective_action "proceed"; only enabled+active+not bypassed enforces.
 */
export async function route(rawState,rawConfig=DEFAULT_CONFIG,{now=Date.now(),env=process.env,cwd=process.cwd()}={}){
 const state=normalizeState(rawState),config=normalizeConfig(rawConfig);
 const killed=/^(off|0|false|disabled)$/i.test(env.JEV_USAGE_ROUTER??'');
 const enabled=config.enabled&&!killed;
 const facts={};
 if(state.artifact_path)facts.artifact_age_s=await ageSeconds(resolve(cwd,state.artifact_path),now);
 if(state.observed_at){const at=Date.parse(state.observed_at);if(Number.isFinite(at))facts.observe_age_s=Math.max(0,(now-at)/1000);}
 const decision=decide(state,config,facts);
 const bypassed=BYPASS.test(state.notes??'');
 const enforced=enabled&&config.mode==='active'&&!bypassed;
 const result={...decision,effective_action:enforced?decision.action:'proceed',enforced,enabled,mode:config.mode,bypassed,logged:false};
 if(enabled&&config.log_path){
  // A log failure must not turn a gate into a crash; it is surfaced as log_error instead.
  const logPath=resolve(inCheckout?repoRoot:cwd,config.log_path);
  const {logged:_logged,...logged}=result;
  try{
   await mkdir(dirname(logPath),{recursive:true});
   await appendFile(logPath,JSON.stringify({ts:new Date(now).toISOString(),input:state,...logged})+'\n',{flag:'a',mode:0o600});
   result.logged=true;
  }catch(error){result.log_error=`${error.code??'LOG_FAILED'} ${logPath}`;}
 }
 return result;
}

const HELP=`usage: node scripts/usage-router.mjs --task-type TYPE --goal TEXT [options]
       node scripts/usage-router.mjs --state '{"goal":"...","task_type":"browser_open",...}'

  --task-type        browser_open | browser_act | host_act | retry | browser_observe | research ...
  --goal             what this step is for
  --last-error       error code/text of the previous attempt (e.g. LOGIN_BLOCKER, STALE_SNAPSHOT)
  --previous-error   error text of the attempt before that (identical text => stop_retry)
  --repeats N        times this same approach already failed
  --observes N       observes/sources already gathered for this question
  --artifact-path P  existing result/screenshot/report path; fresh file => reuse_cache
  --observed-at ISO  time of the last observe; fresh + research task => reuse_cache
  --observation T    short page text/title of the latest observe (login-wall detection)
  --notes T          free text; "bypass jev router" / "bypass usage router" disables enforcement
  --config FILE      default config/usage-router.json (or $JEV_USAGE_ROUTER_CONFIG)

Prints one JSON object; branch on effective_action. JEV_USAGE_ROUTER=off disables the router.`;

async function main(argv){
 const {values}=parseArgs({args:argv,options:{state:{type:'string'},config:{type:'string'},help:{type:'boolean',short:'h'},'task-type':{type:'string'},goal:{type:'string'},'last-error':{type:'string'},'previous-error':{type:'string'},repeats:{type:'string'},observes:{type:'string'},'artifact-path':{type:'string'},'observed-at':{type:'string'},observation:{type:'string'},notes:{type:'string'}},strict:true});
 if(values.help){process.stdout.write(HELP+'\n');return;}
 const state=values.state?JSON.parse(values.state):{};
 for(const [flag,value] of Object.entries(values))if(!['state','config','help'].includes(flag)&&value!==undefined)state[flag.replaceAll('-','_')]=value;
 const result=await route(state,await loadConfig(values.config));
 process.stdout.write(JSON.stringify(result)+'\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).catch(error=>{process.stdout.write(JSON.stringify({error:error.message,effective_action:null})+'\n');process.exitCode=2;});
}
