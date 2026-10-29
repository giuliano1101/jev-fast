import {createServer,type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {chromium,type Browser,type Page,type ElementHandle} from 'playwright';

export interface ChallengeSpec {family:'locate'|'form';difficulty:'easy'|'medium'|'hard';seed:number;mode:string;run:string;}
export interface ChallengeOracle extends ChallengeSpec {page_start_at:number;ready_at:number|null;completed_at:number|null;elapsed_ms:number|null;page_elapsed_ms:number;success:boolean;wrong_actions:number;actions:number;complete_count:number;recovered:boolean;interactions:Array<{kind:string;at_ms:number}>;final_state:Record<string,unknown>;}
export interface ChallengeCandidate {id:string;description:string;operation:'click'|'fill'|'select'|'scroll'|'wait';value?:string;}
export interface ChallengeObservation {instruction:string;summary:string;revision:number;candidates:ChallengeCandidate[];}
const modes=new Set(['baseline','jev','cua','test','calibration','smoke']);
function validateSpec(spec:ChallengeSpec){
 if(!['locate','form'].includes(spec.family)||!['easy','medium','hard'].includes(spec.difficulty)||!Number.isSafeInteger(spec.seed)||spec.seed<1||spec.seed>1000000||!modes.has(spec.mode)||!/^[a-zA-Z0-9_-]{1,100}$/.test(spec.run))throw new Error('Invalid challenge specification');
}
export function challengeUrl(origin:string,spec:ChallengeSpec):string{
 validateSpec(spec);const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw new Error('Challenge requires a loopback origin');
 const target=new URL('/challenge',url);for(const [key,value] of Object.entries(spec))target.searchParams.set(key,String(value));return target.href;
}
function parseSpec(url:URL):ChallengeSpec{
 const fields=['family','difficulty','seed','mode','run'];if([...url.searchParams.keys()].some(k=>!fields.includes(k))||fields.some(k=>url.searchParams.getAll(k).length!==1))throw new Error('Invalid query');
 const spec={family:url.searchParams.get('family'),difficulty:url.searchParams.get('difficulty'),seed:Number(url.searchParams.get('seed')),mode:url.searchParams.get('mode'),run:url.searchParams.get('run')} as ChallengeSpec;validateSpec(spec);return spec;
}
export class ChallengeServer{
 private constructor(private server:Server,readonly origin:string,private scores:Map<string,ChallengeOracle>){}
 static async start():Promise<ChallengeServer>{
  const html=await readFile(new URL('../../../fixtures/challenge.html',import.meta.url),'utf8').catch(()=>readFile(new URL('../../fixtures/challenge.html',import.meta.url),'utf8'));
  const scores=new Map<string,ChallengeOracle>();const runs=new Map<string,ChallengeSpec>();
  const server=createServer(async(req,res)=>{
   const host=`127.0.0.1:${(server.address() as {port:number}).port}`;if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==`http://${host}`)){res.writeHead(403).end();return;}
   const url=new URL(req.url??'/',`http://${host}`);
   if(req.method==='POST'&&url.pathname==='/events'){
    let size=0;const chunks:Buffer[]=[];try{for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413).end();return;}chunks.push(Buffer.from(chunk));}
     const score=JSON.parse(Buffer.concat(chunks).toString()) as ChallengeOracle;const spec=runs.get(score.run);
     if(!spec||Object.entries(spec).some(([key,value])=>score[key as keyof ChallengeSpec]!==value)||typeof score.success!=='boolean'||!Number.isInteger(score.actions)||score.actions<0||!Number.isInteger(score.wrong_actions)||score.wrong_actions<0||![0,1].includes(score.complete_count)||!Array.isArray(score.interactions)||score.interactions.length>256){res.writeHead(400).end();return;}
     const previous=scores.get(score.run);if(!previous||score.actions>=previous.actions&&(!previous.success||score.success))scores.set(score.run,score);
     res.writeHead(204).end();
    }catch{if(!res.headersSent)res.writeHead(400).end();}return;
   }
   if(req.method!=='GET'){res.writeHead(405).end();return;}
   if(url.pathname!=='/challenge'){res.writeHead(404).end();return;}
   try{const spec=parseSpec(url);if(runs.size>=1000&&!runs.has(spec.run)){res.writeHead(429).end();return;}runs.set(spec.run,spec);}catch{res.writeHead(400).end();return;}
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"});res.end(html);
  });await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return new ChallengeServer(server,`http://127.0.0.1:${(server.address() as {port:number}).port}`,scores);
 }
 results():ChallengeOracle[]{return structuredClone([...this.scores.values()]);}
 async close():Promise<void>{await new Promise<void>((resolve,reject)=>{this.server.close(error=>error?reject(error):resolve());this.server.closeIdleConnections();});}
}
export async function launchChallengeBrowser():Promise<Browser>{
 const cached=homedir()+'/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
 const executablePath=process.env.JEV_CHROMIUM_PATH??(existsSync(chromium.executablePath())?undefined:existsSync(cached)?cached:undefined);
 return chromium.launch({headless:true,executablePath});
}
interface Binding{candidate:ChallengeCandidate;node:ElementHandle<HTMLElement>|null;ref:string;signature:string;}
interface BoundObservation {revision:number;url:string;bindings:Map<string,Binding>;}
const observations=new WeakMap<Page,BoundObservation>();
export async function observeChallenge(page:Page):Promise<ChallengeObservation>{
 for(const binding of observations.get(page)?.bindings.values()??[])await binding.node?.dispose();
 const data=await page.evaluate(()=>{
  const root=document.querySelector<HTMLElement>('main');if(!root)throw new Error('Not a challenge page');
  const instruction=document.querySelector<HTMLElement>('#instruction')?.innerText??'';
  const controls=Array.from(document.querySelectorAll<HTMLElement>('[data-ref]')).filter(el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&!(el as HTMLInputElement).disabled).map(el=>{
   const rect=el.getBoundingClientRect();const visible=rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth;
   const label=el instanceof HTMLInputElement||el instanceof HTMLSelectElement?Array.from(el.labels??[]).map(l=>l.innerText).join(' '):el.innerText;
   const context=el.closest('article')?.innerText??'';
   return {ref:el.dataset.ref!,tag:el.tagName,type:(el as HTMLInputElement).type,label,context,visible,value:(el as HTMLInputElement).value,checked:(el as HTMLInputElement).checked,options:el instanceof HTMLSelectElement?Array.from(el.options).filter(o=>!o.disabled&&o.value).map(o=>({value:o.value,label:o.label})):[]};
  });
  const fieldState=controls.filter(control=>control.tag==='INPUT'||control.tag==='SELECT').map(control=>`${control.label}: ${control.type==='checkbox'||control.type==='radio'?(control.checked?'checked':'unchecked'):(control.value||'(empty)')}`).join('\n');
  const summary=[fieldState?`Current visible fields:\n${fieldState}`:'',root.innerText].filter(Boolean).join('\n').slice(0,4000);
  return {instruction,summary,revision:Number(root.dataset.revision??0),controls};
 });
 const candidates:ChallengeCandidate[]=[];const bindings=new Map<string,Binding>();
 async function add(ref:string,operation:ChallengeCandidate['operation'],description:string,value?:string){
  if(candidates.length>=64)return;const id=`${ref}_${operation}${value===undefined?'':'_'+Buffer.from(value).toString('hex')}`;
  const candidate:ChallengeCandidate={id,operation,description:description.replace(/\s+/g,' ').slice(0,160),...(value===undefined?{}:{value})};
  const node=ref==='wait'?null:await page.locator(`[data-ref="${ref}"]`).elementHandle() as ElementHandle<HTMLElement>|null;
  const signature=node?await node.evaluate(el=>JSON.stringify({html:el.outerHTML,value:(el as HTMLInputElement).value,checked:(el as HTMLInputElement).checked,context:el.closest('article')?.innerText})):'';
  candidates.push(candidate);bindings.set(id,{candidate:Object.freeze(structuredClone(candidate)),node,ref,signature});
 }
 for(const control of data.controls){
  const state=control.tag==='INPUT'?control.type==='checkbox'?` [${control.checked?'checked':'unchecked'}]`:` [current value: ${control.value||'(empty)'}]`:control.tag==='SELECT'?` [current selection: ${control.value||'(none)'}]`:'';
  const description=[control.label+state,control.context].filter(Boolean).join(' — ');
  if(!control.visible){await add(control.ref,'scroll',`Scroll to ${description}`);continue;}
  if(control.tag==='SELECT'){for(const option of control.options)if(option.value!==control.value)await add(control.ref,'select',`Choose ${option.label} in ${description}`,option.value);}
  else if(control.tag==='INPUT'&&control.type!=='checkbox'&&control.type!=='radio'){
   const value=/\bSample-\d+\b/.exec(data.instruction)?.[0];if(value&&control.value!==value)await add(control.ref,'fill',`Fill ${description} with ${value}`,value);
  }else await add(control.ref,'click',`Click ${description}`);
 }
 if(/loading|please wait/i.test(data.summary)&&candidates.length===0)await add('wait','wait','Wait briefly for visible controls to load');
 observations.set(page,{revision:data.revision,url:page.url(),bindings});return {instruction:data.instruction,summary:data.summary,revision:data.revision,candidates};
}
/** Only observational reads may be abandoned; physical browser inputs are always awaited. */
async function boundedRead<T>(read:Promise<T>,cutoff:number):Promise<T>{
 if(!Number.isFinite(cutoff))return read;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{const error=new Error('Challenge read deadline exceeded');error.name='TimeoutError';reject(error);},Math.max(0,cutoff-Date.now()));});
 try{return await Promise.race([read,expired]);}finally{if(timer!==undefined)clearTimeout(timer);}
}
export async function executeChallenge(page:Page,candidate:ChallengeCandidate,revision:number,limits?:{expiresAt:number;deadline:number}):Promise<'executed'|'stale'>{
 if(limits&&(!Number.isFinite(limits.expiresAt)||!Number.isFinite(limits.deadline)))return 'stale';
 const cutoff=limits?Math.min(limits.expiresAt,limits.deadline):Infinity;
 const remaining=()=>cutoff-Date.now();
 let dispatched=false;
 try{
 if(remaining()<=0)return 'stale';
 const observed=observations.get(page);const binding=observed?.bindings.get(candidate.id);
 if(!observed||observed.revision!==revision||observed.url!==page.url()||!binding||JSON.stringify(candidate)!==JSON.stringify(binding.candidate))return 'stale';
 const action=binding.candidate;
 const currentRevision=await boundedRead(page.locator('main').getAttribute('data-revision',{timeout:Math.max(1,Math.min(800,remaining()))}),cutoff);
 if(remaining()<=0||currentRevision!==String(revision))return 'stale';
 if(action.operation==='wait'){
  const waitMs=Math.min(300,remaining());if(waitMs<=0)return 'stale';
  await page.waitForTimeout(waitMs);return remaining()<=0?'stale':'executed';
 }
 const node=binding.node;if(!node)return 'stale';
 const visible=await boundedRead(node.isVisible(),cutoff);if(remaining()<=0||!visible)return 'stale';
 const enabled=await boundedRead(node.isEnabled(),cutoff);if(remaining()<=0||!enabled)return 'stale';
 const valid=await boundedRead(node.evaluate((el,expected)=>el.isConnected&&el.dataset.ref===expected.ref&&document.querySelector('main')?.getAttribute('data-revision')===String(expected.revision)&&Array.from(document.querySelectorAll('[data-ref]')).filter(n=>(n as HTMLElement).dataset.ref===expected.ref&&n.getClientRects().length>0).length===1&&JSON.stringify({html:el.outerHTML,value:(el as HTMLInputElement).value,checked:(el as HTMLInputElement).checked,context:el.closest('article')?.innerText})===expected.signature,{ref:binding.ref,revision,signature:binding.signature}),cutoff);
 if(remaining()<=0||!valid)return 'stale';
 const timeout=Math.min(800,remaining());if(timeout<=0)return 'stale';
 // Await the physical call itself: a caller-side timeout cannot cancel a pending browser input.
 // Once dispatch starts, errors remain unknown outcomes and must never be retried as stale.
 dispatched=true;
 switch(action.operation){case 'click':await node.click({timeout});break;case 'fill':await node.fill(action.value!,{timeout});break;case 'select':await node.selectOption(action.value!,{timeout});break;case 'scroll':await node.scrollIntoViewIfNeeded({timeout});break;}return 'executed';
 }catch(error){if(!dispatched&&(remaining()<=0||error instanceof Error&&error.name==='TimeoutError'))return 'stale';throw error;}
}
/** Evaluation only: never include this result in provider prompts or observations. */
export async function readOracle(page:Page):Promise<ChallengeOracle>{return page.evaluate(()=>{const win=window as unknown as {challengeOracle:()=>ChallengeOracle};return win.challengeOracle();});}
