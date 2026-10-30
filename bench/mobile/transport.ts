import {z} from 'zod';
import {isAbsolute,relative,resolve} from 'node:path';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';

const boundedText=z.string().min(1).max(8192);
const refSchema=z.string().regex(/^@e\d{1,9}$/);
const pixel=z.number().finite().nonnegative().max(100000);
/** A deliberately smaller surface than the pinned Mobile MCP server exposes. */
const schemas={
 mobile_list_available_devices:z.strictObject({}),
 mobile_list_apps:z.strictObject({}),
 mobile_get_foreground_app:z.strictObject({}),
 mobile_get_screen_size:z.strictObject({}),
 mobile_list_elements_on_screen:z.strictObject({format:z.literal('json').default('json')}),
 mobile_launch_app:z.strictObject({packageName:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),locale:z.string().regex(/^[A-Za-z0-9,-]{1,100}$/).optional()}),
 mobile_click_on_screen_at_coordinates:z.union([z.strictObject({ref:refSchema}),z.strictObject({x:pixel.int(),y:pixel.int()})]),
 mobile_press_button:z.strictObject({button:z.enum(['BACK','HOME','ENTER'])}),
 mobile_open_url:z.strictObject({url:z.url().max(8192).refine(value=>{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;})}),
 mobile_type_keys:z.strictObject({text:z.string().max(8192),submit:z.boolean()}),
 mobile_swipe_on_screen:z.strictObject({direction:z.enum(['up','down','left','right']),x:pixel.optional(),y:pixel.optional(),distance:pixel.positive().optional()}).refine(args=>(args.x===undefined)===(args.y===undefined)),
 mobile_save_screenshot:z.strictObject({saveTo:boundedText,maxSize:z.number().int().positive().max(16384).optional(),scale:z.number().positive().max(1).optional()}),
};
export type MobileToolName=keyof typeof schemas;
export type MobileToolArguments<K extends MobileToolName>=z.input<(typeof schemas)[K]>;
export interface MobileClient {
 callTool(request:{name:string;arguments:Record<string,unknown>}):Promise<unknown>;
}
export interface MobileTransportOptions {
 device:string;timeoutMs?:number;maxPending?:number;maxCalls?:number;screenshotDirectory?:string;
}
export interface MobileCallResult {
 status:'succeeded'|'failed'|'uncertain'|'blocked';operationId:number;code?:string;
 /** Host-only, deliberately non-enumerable. Never send this to a model or logger. */
 readonly hostLocalResult?:unknown;
}
const optionsSchema=z.strictObject({
 device:z.string().min(1).max(256),timeoutMs:z.number().int().min(1).max(45000).default(45000),
 maxPending:z.number().int().min(1).max(32).default(8),maxCalls:z.number().int().min(1).max(500).default(120),
 screenshotDirectory:boundedText.refine(isAbsolute).optional(),
});
const envelopeSchema=z.object({content:z.array(z.unknown()).max(5000)});

/** Host-local serial executor. Importing/constructing it never connects a device. */
export class MobileTransport {
 private readonly options:z.output<typeof optionsSchema>;
 private tail:Promise<void>=Promise.resolve();
 private pending=0;
 private dispatched=0;
 private sequence=0;
 private uncertainOperation:number|undefined;
 private inFlight=false;
 constructor(private readonly client:MobileClient,options:MobileTransportOptions){
  const parsed=optionsSchema.safeParse(options);if(!parsed.success)throw Error('INVALID_MOBILE_OPTIONS');this.options=parsed.data;
 }
 call<K extends MobileToolName>(name:K,args:MobileToolArguments<K>):Promise<MobileCallResult>{
  const operationId=++this.sequence;
  const failure=(code:string,status:MobileCallResult['status']='failed'):MobileCallResult=>({status,operationId,code});
  if(!Object.hasOwn(schemas,name))return Promise.resolve(failure('INVALID_MOBILE_CALL'));
  const parsed=schemas[name].safeParse(args);if(!parsed.success)return Promise.resolve(failure('INVALID_MOBILE_CALL'));
  const argumentsCopy:Record<string,unknown>={...parsed.data};
  if(name==='mobile_save_screenshot'){
   const path=argumentsCopy.saveTo as string,root=this.options.screenshotDirectory;
   const local=root?relative(resolve(root),resolve(path)):'';
   if(!root||!isAbsolute(path)||!local||local==='..'||local.startsWith('../')||isAbsolute(local)||path.split(/[\\/]/).includes('..')||!/^.+\.(png|jpe?g)$/i.test(path))return Promise.resolve(failure('INVALID_MOBILE_CALL'));
  }
  if(name!=='mobile_list_available_devices')argumentsCopy.device=this.options.device;
  if(this.uncertainOperation!==undefined)return Promise.resolve(failure('MOBILE_RECONCILIATION_REQUIRED','blocked'));
  if(this.pending>=this.options.maxPending)return Promise.resolve(failure('MOBILE_QUEUE_LIMIT','blocked'));
  this.pending++;
  const run=this.tail.then(async()=>{
   if(this.uncertainOperation!==undefined)return failure('MOBILE_RECONCILIATION_REQUIRED','blocked');
   if(this.dispatched>=this.options.maxCalls)return failure('MOBILE_CALL_LIMIT','blocked');
   this.dispatched++;this.inFlight=true;
   const started=performance.now();
   let timer:ReturnType<typeof setTimeout>|undefined;
   const uncertain=(code:string)=>{this.uncertainOperation=operationId;return failure(code,'uncertain');};
   // Do not abort-and-retry: cancellation cannot establish whether the phone acted.
   const request=Promise.resolve().then(()=>this.client.callTool({name,arguments:argumentsCopy}));
   const completed=request.then(value=>{this.inFlight=false;return {kind:'result' as const,value};},()=>{this.inFlight=false;return {kind:'error' as const};});
   try{
    const outcome=await Promise.race([completed,new Promise<{kind:'timeout'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),this.options.timeoutMs);})]);
    if(outcome.kind==='timeout'||performance.now()-started>=this.options.timeoutMs)return uncertain('MOBILE_OPERATION_TIMEOUT');
    if(outcome.kind==='error')return uncertain('MOBILE_OPERATION_UNCERTAIN');
    const envelope=CallToolResultSchema.safeParse(outcome.value);
    if(!envelopeSchema.safeParse(outcome.value).success||!envelope.success||envelope.data.isError)return uncertain('MOBILE_OPERATION_UNCERTAIN');
    const result:MobileCallResult={status:'succeeded',operationId};
    Object.defineProperty(result,'hostLocalResult',{value:outcome.value,enumerable:false});return result;
   }finally{if(timer)clearTimeout(timer);}
  });
  const settled=run.finally(()=>{this.pending--;});this.tail=settled.then(()=>{},()=>{});return settled;
 }
 /** Trusted host only: verify current device state separately. Late completion alone never unlocks input.
  * If the original request never settles, discard this transport after stopping its client.
  */
 reconcileFromHost(proof:{operationId:number;stateVerified:true}):boolean{
  if(!proof||proof.stateVerified!==true||this.inFlight||this.uncertainOperation===undefined||proof.operationId!==this.uncertainOperation)return false;
  this.uncertainOperation=undefined;return true;
 }
}

const elementSchema=z.object({
 ref:refSchema,type:boundedText,text:z.string().max(8192).optional(),label:z.string().max(8192).optional(),identifier:z.string().max(8192).optional(),
 coordinates:z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().finite().nonnegative(),height:z.number().finite().nonnegative()}),
 enabled:z.boolean().optional(),
});
export type MobileElement=z.output<typeof elementSchema>;
/** Private UI text remains in host memory only; this parser has no logger/network sink. */
export function parseMobileElements(value:unknown,options:{statusBarHeight?:number}={}):MobileElement[]{
 try{
  const height=options.statusBarHeight??96;if(!Number.isFinite(height)||height<0)throw Error();
  const response=z.object({isError:z.boolean().optional(),content:z.tuple([z.object({type:z.literal('text'),text:z.string().max(2_000_000)})])}).parse(value);
  const prefix='Found these elements on screen: ';
  if(response.isError||!response.content[0].text.startsWith(prefix))throw Error();
  const elements=z.array(elementSchema).max(5000).parse(JSON.parse(response.content[0].text.slice(prefix.length)));
  if(new Set(elements.map(element=>element.ref)).size!==elements.length)throw Error();
  return elements.filter(element=>element.coordinates.y>=height);
 }catch{throw Error('INVALID_MOBILE_ELEMENTS');}
}
const mappingSchema=z.strictObject({actionId:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),text:boundedText.optional(),label:boundedText.optional(),identifier:boundedText.optional()}).refine(value=>value.text!==undefined||value.label!==undefined||value.identifier!==undefined);
export type PublicMobileMapping=z.output<typeof mappingSchema>;
export interface MobilePublicProjection {public:{candidates:string[]};readonly hostLocalBindings:Record<string,string>}
/** Only host-defined action IDs may be forwarded to the remote decision API. Never UI text. */
export function projectPublicObservation(elements:readonly MobileElement[],mappings:readonly PublicMobileMapping[]):MobilePublicProjection{
 const validated=z.array(mappingSchema).max(128).safeParse(mappings);
 if(!validated.success||new Set(validated.data.map(value=>value.actionId)).size!==validated.data.length)throw Error('INVALID_PUBLIC_MAPPING');
 const nodes=z.array(elementSchema).max(5000).safeParse(elements);
 if(!nodes.success||new Set(nodes.data.map(value=>value.ref)).size!==nodes.data.length)throw Error('INVALID_MOBILE_ELEMENTS');
 const candidates:string[]=[],bindings:Record<string,string>={},used=new Set<string>();
 for(const mapping of validated.data){
  const matches=nodes.data.filter(element=>element.enabled!==false&&(mapping.text===undefined||element.text===mapping.text)&&(mapping.label===undefined||element.label===mapping.label)&&(mapping.identifier===undefined||element.identifier===mapping.identifier));
  if(matches.length>1||matches[0]&&used.has(matches[0].ref))throw Error('AMBIGUOUS_PUBLIC_BINDING');
  if(matches[0]){used.add(matches[0].ref);candidates.push(mapping.actionId);bindings[mapping.actionId]=matches[0].ref;}
 }
 return Object.defineProperty({public:{candidates}},'hostLocalBindings',{value:bindings,enumerable:false}) as MobilePublicProjection;
}
