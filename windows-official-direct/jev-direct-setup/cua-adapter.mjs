// UI is exclusively through the documented bound CUA tab. No CDP attachment to IAB.
export function cuaAdapter(tab,{surfaceId='2',kind='iab'}={}) {
 let cached, cachedAt=0;
 const locator=b=>b.role?tab.playwright.getByRole(b.role,{name:b.name,exact:true}):tab.playwright.locator(b.selector);
 return {
  async observe(step){
   if(!cached||Date.now()-cachedAt>45000){cached=await tab.playwright.domSnapshot();cachedAt=Date.now();}
   const snapshot=cached;
   const candidates=[];
   for(const [index,spec] of step.controls.entries()){
    if(!spec.role||!spec.name)throw Error('CUA_REQUIRES_OBSERVED_SEMANTIC_LOCATOR');
    const token=spec.role+' '+JSON.stringify(spec.name);
    if(snapshot.split('\n').filter(line=>line.trim().startsWith('- '+token)&&['',':',' ',' ['].some(s=>line.trim().slice(2+token.length).startsWith(s))).length!==1)continue;
    candidates.push({id:spec.id??'target_'+index,name:spec.name,role:spec.role,action:spec.action??step.action,binding:{...spec}});
   }
   return {surface:{kind,id:surfaceId,url:await tab.url()},candidates};
  },
  async guard(c,o){return await tab.url()===o.surface.url&&(c.action==='download'||await locator(c.binding).isVisible());},
  async act(c,step){const l=locator(c.binding);
   if(c.action==='click')await l.click({timeoutMs:8000});
   else if(c.action==='fill'){await l.fill(step.text,{timeoutMs:8000});if(step.submit)await l.press('Enter',{timeoutMs:8000});}
   else if(c.action==='download'){const path=await l.downloadMedia({timeoutMs:30000});return {path};}
   else throw Error('UNSUPPORTED_CUA_ACTION');
  },
  async verify(step,c,artifact){
   if(artifact?.path)return {ok:true,evidence:{download_path:artifact.path}};
   cached=await tab.playwright.domSnapshot();cachedAt=Date.now();
   if(step.verify?.snapshotIncludes)return {ok:cached.includes(step.verify.snapshotIncludes),evidence:{expected_visible:step.verify.snapshotIncludes,present:cached.includes(step.verify.snapshotIncludes)}};
   if(step.verify?.urlIncludes){const url=await tab.url();return {ok:url.includes(step.verify.urlIncludes),evidence:{url}};}
   return {ok:false,evidence:{error:'Independent verifier required'}};
  }
 };
}
