import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
export function playwrightAdapter(page,{surfaceId='jev-chrome',artifactDir,kind='chrome'}={}) {
 const locator=b=>b.role?page.getByRole(b.role,{name:b.name,exact:true}):page.locator(b.selector);
 return {
  async observe(step) {
   if(new URL(page.url()).pathname.startsWith('/sorry/'))return {blocked:'google_verification_required'};
   const candidates=[];
   for(const [index,spec] of step.controls.entries()) {
    const l=locator(spec);if(await l.count()!==1||!await l.isVisible())continue;
    candidates.push({id:spec.id??'target_'+index,name:spec.name??await l.getAttribute('alt')??spec.selector,role:spec.role??'img',action:spec.action??step.action,binding:{...spec}});
   }
   return {surface:{kind,id:surfaceId,url:page.url()},candidates};
  },
  async guard(c,o){return page.url()===o.surface.url&&await locator(c.binding).count()===1&&await locator(c.binding).isVisible();},
  async act(c,step) {
   const l=locator(c.binding);
   if(c.action==='click')await l.click({timeout:8000});
   else if(c.action==='fill'){await l.fill(step.text,{timeout:8000});if(step.submit)await l.press('Enter',{timeout:8000});}
   else if(c.action==='download') {
    const src=await l.getAttribute('src');if(!src)throw Error('NO_IMAGE_SOURCE');
    let bytes,type;
    if(src.startsWith('data:image/')) {type=src.slice(5,src.indexOf(';'));bytes=Buffer.from(src.split(',')[1],'base64');}
    else {const response=await page.request.get(new URL(src,page.url()).href,{timeout:20000});if(!response.ok())throw Error('DOWNLOAD_HTTP_'+response.status());bytes=await response.body();type=response.headers()['content-type'];}
    if(!type?.startsWith('image/')||bytes.length<300)throw Error('INVALID_IMAGE');
    await mkdir(artifactDir,{recursive:true});const path=join(artifactDir,step.id+(type.includes('png')?'.png':'.jpg'));await writeFile(path,bytes);return {path,bytes:bytes.length,type,source:src.startsWith('data:')?'observed inline image':src};
   } else throw Error('UNSUPPORTED_ACTION');
  },
  async verify(step,c,artifact) {
   if(new URL(page.url()).pathname.startsWith('/sorry/'))return {ok:false,evidence:{blocker:'google_verification_required',url_path:'/sorry/'}};
   if(artifact)return {ok:artifact.bytes>300,evidence:{saved:artifact.path,bytes:artifact.bytes}};
   if(step.verify?.urlIncludes){await page.waitForURL(u=>u.pathname==='/search'&&u.href.includes(step.verify.urlIncludes),{timeout:12000});return {ok:true,evidence:{url:page.url()}};}
   if(step.verify?.visible){const l=locator(step.verify.visible);await l.waitFor({state:'visible',timeout:12000});return {ok:true,evidence:{visible:step.verify.visible}};}
   return {ok:false,evidence:{error:'No independent verifier in task contract'}};
  }
 };
}
