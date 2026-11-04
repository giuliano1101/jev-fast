import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const surfaceMethods=new Set(['navigate','back','forward','newTab','switchTab','scroll']);
const validUrl=value=>typeof value==='string'&&(/^(https?:\/\/)/.test(value)||['about:blank','chrome://downloads/'].includes(value));
const semanticLocation=url=>{const u=new URL(url);return {origin:u.origin,path:u.pathname,query:[...u.searchParams],hash:u.hash};};

export function browserCandidate(state, {id, description, method, label, role, target={}, params = {}}) {
  if(surfaceMethods.has(method)){
    const point=method==='scroll'?state.regions.find(r=>r.id===(params.region??'main')):undefined;
    return {id,description,method,input:{...params,...(point?{point}:{}),observation_id:state.observation_id}};
  }
  if (!['click','fill','select','press'].includes(method)) throw Error('UNSUPPORTED_BROWSER_ACTION');
  const filters={...target,...(label!==undefined?{label}:{}),...(role?{role}:{})};
  if(!Object.keys(filters).length||Object.keys(filters).some(k=>!['label','role','name','dom_id','type','value','href'].includes(k)))throw Error('INVALID_BROWSER_TARGET');
  const matches=state.elements.filter(node=>node.enabled&&Object.entries(filters).every(([key,value])=>node[key]===value));
  if(matches.length!==1) throw Error('TARGET_NOT_UNIQUE');
  return {id,description,method,input:{...params,observation_id:state.observation_id,element_id:matches[0].element_id}};
}
/** Semantic model state: no cookies, DOM source, query URLs, screenshots or hidden controls. */
export function browserProjection(state) {
  return {title:state.title,text:state.text,elements:state.elements.map(({element_id:_id,...element})=>element)};
}
export class BrowserAdapter {
  kind='browser'; id=randomUUID();
  static async launch({url='about:blank',channel='chrome',headless=true,executablePath}={}) {
    const {chromium}=await import('playwright');
    const browser=await chromium.launch({headless,...(executablePath?{executablePath}:{channel})});
    try {
      const context=await browser.newContext({viewport:{width:1280,height:800}});
      const page=await context.newPage();
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
      return new BrowserAdapter(browser,context,page);
    }catch(error){await browser.close();throw error;}
  }
  constructor(browser,context,page){
    this.browser=browser;this.context=context;this.page=page;this.pageIds=new WeakMap();this.downloads=[];this.diagnostics=[];
    context.pages().forEach(p=>this.#attach(p));context.on('page',p=>this.#attach(p));
  }
  #attach(page){
    if(this.pageIds.has(page))return;
    this.pageIds.set(page,randomUUID());
    page.on('download',download=>{if(this.downloadDirectory)this.#saveDownload(download);});
  }
  enableDownloads(directory){mkdirSync(directory,{recursive:true,mode:0o700});this.downloadDirectory=directory;}
  async #saveDownload(download){
    const row={id:'D'+(this.downloads.length+1),start:new Date().toISOString(),url:download.url(),filename:basename(download.suggestedFilename()).replace(/[\x00-\x1f/\\]/g,'_'),status:'STARTED'};
    this.downloads.push(row);
    try{
      row.path=join(this.downloadDirectory,row.id+'-'+row.filename);
      await download.saveAs(row.path);
      const bytes=readFileSync(row.path);row.bytes=bytes.length;row.sha256=createHash('sha256').update(bytes).digest('hex');row.failure=await download.failure();
      row.status=row.bytes>0&&!row.failure?'SAVED':'FAILED';
    }catch(error){row.status='FAILED';row.error=error.message;}
    row.end=new Date().toISOString();row.elapsed_ms=Date.parse(row.end)-Date.parse(row.start);
  }
  scope(){return {kind:this.kind,browser:this.id};}
  async observe(){
    // Only read-only observation is retried. Never replay a click/submit/navigation.
    for(let attempt=0;attempt<8;attempt++){
      try{return await this.#observe();}catch(error){
        if(!/DOCUMENT_TRANSITION|Execution context was destroyed|Cannot find context/.test(error.message)||attempt===7)throw error;
        this.diagnostics.push({at:new Date().toISOString(),code:'OBSERVATION_TRANSITION',attempt:attempt+1});await delay(100);
      }
    }
  }
  async #observe(){
    const state=await this.page.evaluate(({observationId,documentKey})=>{
      const root=document.body??document.documentElement;if(!root)throw Error('DOCUMENT_TRANSITION');
      const visible=node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&getComputedStyle(node).visibility==='visible'&&getComputedStyle(node).display!=='none'&&getComputedStyle(node).opacity!=='0';};
      const describe=node=>{
        const privateField=node.matches('input[type=password],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]');
        const role=node.getAttribute('role')||(node.tagName==='A'?'link':node.tagName==='BUTTON'||['submit','button','reset'].includes(node.type)?'button':node.tagName==='SELECT'?'combobox':node.type==='checkbox'?'checkbox':node.type==='radio'?'radio':node.type==='range'?'slider':'textbox');
        const label=(node.getAttribute('aria-label')||[...(node.labels||[])].map(x=>x.innerText).join(' ')||node.getAttribute('placeholder')||node.getAttribute('title')||node.innerText||node.name||node.id||node.type||'').trim().slice(0,400);
        return {role,label,name:node.name||'',dom_id:node.id||'',type:node.type||'',href:node.tagName==='A'?node.href:'',enabled:!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&!node.closest('[inert]'),visible:visible(node),value:privateField?'[private]':String(node.value??'').slice(0,1000),checked:typeof node.checked==='boolean'?node.checked:null,
          options:node.tagName==='SELECT'?[...node.options].map(o=>({label:o.label,value:o.value,disabled:o.disabled||Boolean(o.closest('optgroup[disabled]'))})):[]};
      };
      const previous=window.__jevDirect;
      const registry={documentKey:previous?.documentKey??documentKey,observationId,nodes:new Map(),guards:new Map(),describe};
      const elements=[],scrollTargets=[];
      for(const node of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=checkbox],[role=radio],[role=option],[contenteditable=true]')){
        const data=describe(node);if(!data.visible){
          const r=node.getBoundingClientRect(),style=getComputedStyle(node);
          if(r.width>0&&r.height>0&&style.display!=='none'&&style.visibility==='visible'&&style.opacity!=='0')scrollTargets.push({label:data.label,name:data.name,dom_id:data.dom_id,role:data.role,value:['button','checkbox','radio'].includes(data.role)?data.value:'',top:r.top,bottom:r.bottom});
          continue;
        }
        const id='e'+(elements.length+1);registry.nodes.set(id,node);registry.guards.set(id,JSON.stringify(data));
        elements.push({element_id:id,...data});
      }
      window.__jevDirect=registry;
      const text=[];const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let node,characters=0;
      while((node=walker.nextNode())&&characters<4000){const parent=node.parentElement;if(!parent||parent.closest('script,style,input,textarea')||!visible(parent))continue;const s=node.textContent.trim();if(s){text.push(s);characters+=s.length;}}
      const main=document.querySelector('main')??document.querySelector('form')??root;
      // A header can place main entirely below the fold. Bind the visible document
      // region then, rather than inventing a point in an offscreen main element.
      let rect=main.getBoundingClientRect();
      if(rect.bottom<=0||rect.top>=innerHeight||rect.width<=0||rect.height<=0)rect=root.getBoundingClientRect();
      const left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
      const regions=right>left&&bottom>top?[{id:'main',x:Math.round((left+right)/2),y:Math.round((top+bottom)/2)}]:[];
      return {observation_id:observationId,document_key:registry.documentKey,title:document.title,text:text.join('\n').slice(0,4000),elements,scroll_targets:scrollTargets.slice(0,200),scroll:{x:scrollX,y:scrollY,height:root.scrollHeight,viewport:innerHeight},regions};
    },{observationId:randomUUID(),documentKey:randomUUID()});
    return {...state,url:this.page.url(),page_id:this.pageIds.get(this.page),tabs:this.context.pages().map(p=>({id:this.pageIds.get(p),url:p.url(),active:p===this.page}))};
  }
  guard(candidate,state){
    if(surfaceMethods.has(candidate.method)){
      if(candidate.input.observation_id!==state.observation_id)throw Error('INVALID_BROWSER_BINDING');
      const {observation_id:_observation,...parameters}=candidate.input;
      if(['navigate','newTab'].includes(candidate.method)&&!validUrl(parameters.url))throw Error('INVALID_BROWSER_URL');
      let target;
      if(candidate.method==='switchTab'){
        target=state.tabs.find(t=>t.id===parameters.tabId);if(!target)throw Error('INVALID_BROWSER_TAB');
      }
      if(candidate.method==='scroll'){
        target=state.regions.find(r=>r.id===(parameters.region??'main'));if(!target||parameters.point?.id!==target.id||parameters.point?.x!==target.x||parameters.point?.y!==target.y||!Number.isFinite(parameters.delta)||parameters.delta===0)throw Error('INVALID_SCROLL_REGION');
        // Coordinates are rebound from the fresh observation, like DOM handles.
        // The chosen action is scrolling this semantic content surface, not an
        // old pixel. Layout-only image/font loading must not invalidate intent.
        const {point:_point,...semanticParameters}=parameters;
        return {method:candidate.method,parameters:semanticParameters,document_key:state.document_key,page_id:state.page_id,location:semanticLocation(state.url),target:{id:target.id}};
      }
      return {method:candidate.method,parameters,document_key:state.document_key,page_id:state.page_id,location:semanticLocation(state.url),...(target?{target:{...target,url:semanticLocation(target.url)}}:{})};
    }
    if(!['click','fill','select','press'].includes(candidate.method)||candidate.input.observation_id!==state.observation_id)throw Error('INVALID_BROWSER_BINDING');
    const node=state.elements.find(n=>n.element_id===candidate.input.element_id);
    if(!node?.enabled||!node.visible)throw Error('INVALID_BROWSER_BINDING');
    const {observation_id:_observation,element_id:_element,...parameters}=candidate.input;
    if(candidate.method==='fill'&&typeof parameters.value!=='string')throw Error('INVALID_BROWSER_VALUE');
    if(candidate.method==='select'&&!node.options.some(o=>o.value===parameters.value&&!o.disabled))throw Error('INVALID_BROWSER_OPTION');
    if(candidate.method==='press'&&typeof parameters.key!=='string')throw Error('INVALID_BROWSER_KEY');
    const {element_id:_id,...target}=node;
    return {method:candidate.method,parameters,document_key:state.document_key,target};
  }
  async execute(candidate){
    if(surfaceMethods.has(candidate.method)){
      const p=candidate.input,options={waitUntil:'domcontentloaded',timeout:20000};
      // Guards and semantic rebind are provided by JevSession, then one dispatch.
      if(candidate.method==='navigate')await this.page.goto(p.url,options);
      else if(candidate.method==='back')await this.page.goBack(options);
      else if(candidate.method==='forward')await this.page.goForward(options);
      else if(candidate.method==='newTab'){this.page=await this.context.newPage();await this.page.goto(p.url,options);}
      else if(candidate.method==='switchTab'){
        const page=this.context.pages().find(x=>this.pageIds.get(x)===p.tabId);if(!page)throw Error('STALE_OBSERVATION');this.page=page;await page.bringToFront();
      }else if(candidate.method==='scroll'){
        await this.page.mouse.move(p.point.x,p.point.y);await this.page.mouse.wheel(0,p.delta);
      }
      return {input_submitted:true};
    }
    const handle=await this.page.evaluateHandle(input=>{
      const registry=window.__jevDirect,node=registry?.nodes.get(input.element_id);
      if(!node?.isConnected||registry.observationId!==input.observation_id||JSON.stringify(registry.describe(node))!==registry.guards.get(input.element_id))return null;
      return node;
    },candidate.input);
    const element=handle.asElement();
    if(!element){await handle.dispose();throw Error('STALE_OBSERVATION');}
    try{
      const timeout=5000;
      if(candidate.method==='click')await element.click({timeout});
      else if(candidate.method==='fill')await element.fill(candidate.input.value,{timeout});
      else if(candidate.method==='select')await element.selectOption({value:candidate.input.value},{timeout});
      else if(candidate.method==='press')await element.press(candidate.input.key,{timeout});
      else throw Error('UNSUPPORTED_BROWSER_ACTION');
      return {input_submitted:true};
    }finally{await handle.dispose();}
  }
  screenshot(path){return this.page.screenshot({path,fullPage:false});}
  async waitForLayout({timeoutMs=5000,stableMs=200}={}){
    const start=Date.now();let previous,unchangedAt=start,last;
    do{
      last=await this.page.evaluate(()=>({ready:document.readyState==='complete'&&(!document.fonts||document.fonts.status==='loaded'),height:document.documentElement?.scrollHeight,width:innerWidth,x:scrollX,y:scrollY}));
      const signature=JSON.stringify(last);
      if(signature!==previous){previous=signature;unchangedAt=Date.now();}
      if(last.ready&&Date.now()-unchangedAt>=stableMs)return {settled:true,elapsed_ms:Date.now()-start,...last};
      await delay(50);
    }while(Date.now()-start<timeoutMs);
    return {settled:false,elapsed_ms:Date.now()-start,...last};
  }
  async readDocument({selector='body',maxCharacters=24000}={}){
    return {url:this.page.url(),title:await this.page.title(),text:(await this.page.locator(selector).innerText({timeout:3000})).slice(0,maxCharacters)};
  }
  async verifyImage(path){
    const bytes=readFileSync(path),hash=createHash('sha256').update(bytes).digest('hex');
    const decoded=await this.page.evaluate(async base64=>{
      const data=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const image=await createImageBitmap(new Blob([data]));
      const dimensions={width:image.width,height:image.height};image.close();return dimensions;
    },bytes.toString('base64'));
    return {path,bytes:bytes.length,sha256:hash,format:bytes[0]===255&&bytes[1]===216?'JPEG':bytes.subarray(1,4).toString()==='PNG'?'PNG':'OTHER',...decoded};
  }
  async downloadHistory(){
    if(this.page.url()!=='chrome://downloads/')throw Error('NOT_DOWNLOAD_HISTORY');
    return this.page.evaluate(()=>{
      const manager=document.querySelector('downloads-manager');
      return JSON.parse(JSON.stringify({items:manager?.items??manager?.items_??[],text:manager?.shadowRoot?.innerText??''},(_k,v)=>typeof v==='bigint'?String(v):v));
    });
  }
  close(){return this.browser.close();}
}
