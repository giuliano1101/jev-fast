import test from 'node:test';
import assert from 'node:assert/strict';
import type {Page} from 'playwright';

// Dynamic loading lets the initial red test report the missing capability clearly.
const modulePath = '../../bench/live/challenge.js';
const challenge = await import(modulePath).catch(() => null);
test('challenge fixture exports its public browser contract', () => {
 assert.ok(challenge, 'Challenge implementation must exist');
 for (const key of ['ChallengeServer','challengeUrl','launchChallengeBrowser','observeChallenge','executeChallenge','readOracle']) assert.ok(challenge[key], key);
});

async function solve(page:Page,family:string,difficulty:string,seed:number){
 if(family==='locate'){
  if(difficulty==='hard') await page.waitForTimeout(350);
  if(difficulty==='easy') await page.getByRole('button',{name:`Open Sample-${seed}`,exact:true}).click();
  else {
   const card=page.locator('article').filter({has:page.getByText(`Name: Sample-${seed}`,{exact:true})}).filter({hasText:'Status: Ready'}).filter({hasText:'Owner: Morgan'});
   await card.getByRole('button',{name:'Open',exact:true}).click();
   if(difficulty==='hard') await page.getByRole('button',{name:'Mark reviewed',exact:true}).click();
  }
 }else{
  await page.getByLabel('Sample name',{exact:true}).fill(`Sample-${seed}`);
  if(difficulty==='easy') await page.getByRole('button',{name:'Save',exact:true}).click();
  else{
   const instruction=await page.locator('#instruction').innerText();
   const category=/category (alpha|beta|gamma)/.exec(instruction)?.[1]; assert.ok(category);
   await page.getByLabel('Category',{exact:true}).selectOption(category);
   await page.getByRole('button',{name:'Next',exact:true}).click();
   if(difficulty==='hard') await page.getByLabel('I checked the sample details',{exact:true}).check();
   await page.getByRole('button',{name:'Confirm save',exact:true}).click();
  }
 }
}

test('all challenge variants and seeds complete through visible labels with a single terminal completion',{timeout:90000},async()=>{
 assert.ok(challenge); const server=await challenge.ChallengeServer.start(); const browser=await challenge.launchChallengeBrowser();
 try{for(const family of ['locate','form'])for(const difficulty of ['easy','medium','hard'])for(const seed of [1,2,3,4,5,101]){
  const page=await browser.newPage({viewport:{width:900,height:600}});
  await page.goto(challenge.challengeUrl(server.origin,{family,difficulty,seed,mode:'test',run:`${family}-${difficulty}-${seed}`}));
  await solve(page,family,difficulty,seed);
  const oracle=await challenge.readOracle(page);
  assert.equal(oracle.success,true,`${family}/${difficulty}/${seed}`); assert.equal(oracle.complete_count,1); assert.equal(oracle.wrong_actions,0);
  assert.ok(oracle.completed_at>=oracle.ready_at); assert.ok(oracle.elapsed_ms>=0);
  assert.equal((await challenge.readOracle(page)).complete_count,1);
  await page.close();
 }assert.equal(server.results().length,36);}finally{await browser.close();await server.close();}
});

test('wrong choices are recoverable, observations do not leak oracle, rerenders reject stale inputs',{timeout:20000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();const browser=await challenge.launchChallengeBrowser();const page=await browser.newPage();
 try{
  await page.goto(challenge.challengeUrl(server.origin,{family:'locate',difficulty:'easy',seed:2,mode:'test',run:'wrong'}));
  await page.getByRole('button',{name:'Open Sample-12',exact:true}).click();
  let oracle=await challenge.readOracle(page); assert.equal(oracle.success,false);assert.equal(oracle.wrong_actions,1);
  await solve(page,'locate','easy',2);oracle=await challenge.readOracle(page);assert.equal(oracle.recovered,true);assert.equal(oracle.complete_count,1);
  await page.goto(challenge.challengeUrl(server.origin,{family:'locate',difficulty:'hard',seed:3,mode:'test',run:'stale'}));
  const first=await challenge.observeChallenge(page);assert.ok(first.candidates.length>2);
  assert.doesNotMatch(JSON.stringify(first),/challengeOracle|correctTarget|data-correct|wrong_actions|complete_count/);
  assert.ok(first.candidates.every((c:{description:string})=>c.description.length<=160));
  await page.waitForTimeout(350);
  assert.equal(await challenge.executeChallenge(page,first.candidates[0],first.revision),'stale');
  assert.equal((await challenge.readOracle(page)).actions,0);
  const fresh=await challenge.observeChallenge(page);assert.ok(fresh.revision>first.revision);
  assert.doesNotMatch(await page.locator('main').innerHTML(),/data-correct|data-answer|correctTarget/);
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'hard',seed:5,mode:'test',run:'delay'}));
  const waiting=await challenge.observeChallenge(page);assert.ok(waiting.candidates.some((c:{operation:string})=>c.operation==='wait'));
  assert.ok(!waiting.candidates.some((c:{operation:string})=>c.operation==='fill'));
  await page.waitForTimeout(950);
  assert.equal(await challenge.executeChallenge(page,waiting.candidates[0],waiting.revision),'stale');
  const ready=await challenge.observeChallenge(page);const fill=ready.candidates.find((c:{operation:string})=>c.operation==='fill');assert.equal(fill.value,'Sample-5');
  assert.equal(await challenge.executeChallenge(page,fill,ready.revision),'executed');
  const next=await challenge.observeChallenge(page);assert.ok(next.candidates.some((c:{operation:string;value:string})=>c.operation==='select'&&c.value==='alpha'));
 }finally{await browser.close();await server.close();}
});

test('server validates challenge queries and rejects nonlocal origins and unbounded events',{timeout:10000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();try{
  assert.throws(()=>challenge.challengeUrl('https://example.com',{family:'form',difficulty:'easy',seed:1,mode:'test',run:'x'}));
  assert.equal((await fetch(server.origin+'/challenge?family=evil')).status,400);
  assert.equal((await fetch(server.origin+'/events',{method:'POST',body:'x'.repeat(20000)})).status,413);
  assert.deepEqual(server.results(),[]);
 }finally{await server.close();}
});

test('bound actions reject changed values and never classify a post-input error as safe stale',{timeout:15000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();const browser=await challenge.launchChallengeBrowser();const page=await browser.newPage();
 try{
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'easy',seed:1,mode:'test',run:'signature'}));
  const snapshot=await challenge.observeChallenge(page);const fill=snapshot.candidates.find((c:{operation:string})=>c.operation==='fill');
  await page.getByLabel('Sample name',{exact:true}).evaluate((el:HTMLInputElement)=>{el.value='changed without event';});
  assert.equal(await challenge.executeChallenge(page,fill,snapshot.revision),'stale');
  await page.goto(challenge.challengeUrl(server.origin,{family:'locate',difficulty:'easy',seed:1,mode:'test',run:'lost-ack'}));
  const observed=await challenge.observeChallenge(page);const target=observed.candidates.find((c:{description:string})=>c.description.startsWith('Click Open Sample-1 — Name: Sample-1')&&!c.description.includes('copy')&&!c.description.includes('Sample-11'));
  assert.ok(target);
  const handle=await page.getByRole('button',{name:'Open Sample-1',exact:true}).elementHandle();assert.ok(handle);
  const prototype=Object.getPrototypeOf(handle);const original=prototype.click;
  prototype.click=async function(...args:unknown[]){await original.apply(this,args);await this.evaluate((el:HTMLElement)=>el.remove());throw new Error('lost acknowledgement after input');};
  try{await assert.rejects(()=>challenge.executeChallenge(page,target,observed.revision),/lost acknowledgement/);assert.equal((await challenge.readOracle(page)).success,true);}finally{prototype.click=original;}
 }finally{await browser.close();await server.close();}
});

test('mutating a returned candidate cannot alter its private authorized action',{timeout:10000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();const browser=await challenge.launchChallengeBrowser();const page=await browser.newPage();
 try{
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'easy',seed:1,mode:'test',run:'mutated-candidate'}));
  const observed=await challenge.observeChallenge(page);const candidate=observed.candidates.find((c:{operation:string})=>c.operation==='fill');assert.ok(candidate);
  candidate.value='Unauthorized replacement';
  assert.equal(await challenge.executeChallenge(page,candidate,observed.revision),'stale');
  assert.equal(await page.getByLabel('Sample name',{exact:true}).inputValue(),'');
  assert.equal((await challenge.readOracle(page)).actions,0);
 }finally{await browser.close();await server.close();}
});

test('expiry crossing during preflight rejects input and action waits use the remaining deadline',{timeout:10000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();const browser=await challenge.launchChallengeBrowser();const page=await browser.newPage();
 try{
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'easy',seed:1,mode:'test',run:'deadline'}));
  const observed=await challenge.observeChallenge(page);const candidate=observed.candidates.find((c:{operation:string})=>c.operation==='fill');assert.ok(candidate);
  const handle=await page.getByLabel('Sample name',{exact:true}).elementHandle();assert.ok(handle);
  const prototype=Object.getPrototypeOf(handle);const original=prototype.isVisible;
  prototype.isVisible=async function(){await new Promise(resolve=>setTimeout(resolve,100));return original.call(this);};
  try{
   const deadline=Date.now()+40;
   assert.equal(await challenge.executeChallenge(page,candidate,observed.revision,{expiresAt:deadline+1000,deadline}),'stale');
   assert.equal((await challenge.readOracle(page)).actions,0);
   assert.equal(await page.getByLabel('Sample name',{exact:true}).inputValue(),'');
  }finally{prototype.isVisible=original;}
  await page.evaluate(()=>document.querySelector('main')?.remove());
  const missingDeadline=Date.now()+40;
  assert.equal(await challenge.executeChallenge(page,candidate,observed.revision,{expiresAt:missingDeadline,deadline:missingDeadline+1000}),'stale');
  assert.equal((await challenge.readOracle(page)).actions,0);
  // An overlay leaves the target visible/enabled but prevents a real click from becoming actionable.
  await page.goto(challenge.challengeUrl(server.origin,{family:'locate',difficulty:'easy',seed:1,mode:'test',run:'deadline-action'}));
  await page.evaluate(()=>{const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.1)';document.body.append(overlay);});
  const blocked=await challenge.observeChallenge(page);const start=Date.now();
  await assert.rejects(()=>challenge.executeChallenge(page,blocked.candidates[0],blocked.revision,{expiresAt:start+500,deadline:start+120}),/Timeout/);
  const elapsed=Date.now()-start;assert.ok(elapsed<450,`action exceeded deadline bound: ${elapsed}ms`);
  await page.waitForTimeout(180);assert.equal((await challenge.readOracle(page)).actions,0);
 }finally{await browser.close();await server.close();}
});

test('a hung preflight read settles stale by its deadline without input',{timeout:10000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();const browser=await challenge.launchChallengeBrowser();const page=await browser.newPage();
 try{
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'easy',seed:1,mode:'test',run:'hung-read'}));
  const observed=await challenge.observeChallenge(page);const candidate=observed.candidates.find((c:{operation:string})=>c.operation==='fill');assert.ok(candidate);
  const handle=await page.getByLabel('Sample name',{exact:true}).elementHandle();assert.ok(handle);
  const prototype=Object.getPrototypeOf(handle);const original=prototype.isVisible;
  prototype.isVisible=()=>new Promise(()=>{});
  try{
   const deadline=Date.now()+50;
   const outcome=await Promise.race([challenge.executeChallenge(page,candidate,observed.revision,{expiresAt:deadline+1000,deadline}),new Promise(resolve=>setTimeout(()=>resolve('did-not-settle'),350))]);
   assert.equal(outcome,'stale');assert.equal((await challenge.readOracle(page)).actions,0);
  }finally{prototype.isVisible=original;}
 }finally{await browser.close();await server.close();}
});

test('observations prune only current-value no-ops and preserve visible field state and alternatives',{timeout:10000},async()=>{
 assert.ok(challenge);const server=await challenge.ChallengeServer.start();const browser=await challenge.launchChallengeBrowser();const page=await browser.newPage();
 try{
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'easy',seed:1,mode:'test',run:'no-op-easy'}));
  let observed=await challenge.observeChallenge(page);const fill=observed.candidates.find((c:{operation:string})=>c.operation==='fill');assert.ok(fill);
  assert.equal(await challenge.executeChallenge(page,fill,observed.revision),'executed');
  observed=await challenge.observeChallenge(page);
  assert.ok(!observed.candidates.some((c:{operation:string})=>c.operation==='fill'));
  assert.match(observed.summary,/Sample name.*Sample-1/);
  assert.ok(observed.candidates.some((c:{description:string})=>c.description.includes('Save')));
  assert.ok(observed.candidates.some((c:{description:string})=>c.description.includes('Discard sample')));
  await page.goto(challenge.challengeUrl(server.origin,{family:'form',difficulty:'medium',seed:2,mode:'test',run:'no-op-select'}));
  observed=await challenge.observeChallenge(page);const select=observed.candidates.find((c:{operation:string;value:string})=>c.operation==='select'&&c.value==='alpha');assert.ok(select);
  assert.equal(await challenge.executeChallenge(page,select,observed.revision),'executed');
  observed=await challenge.observeChallenge(page);
  assert.deepEqual(observed.candidates.filter((c:{operation:string})=>c.operation==='select').map((c:{value:string})=>c.value).sort(),['beta','gamma']);
  assert.match(observed.summary,/Category.*alpha/);
  assert.ok(observed.candidates.some((c:{description:string})=>c.description.includes('Next')));
  assert.ok(observed.candidates.some((c:{description:string})=>c.description.includes('Discard sample')));
  assert.ok(observed.summary.length<=4000);
 }finally{await browser.close();await server.close();}
});
