import {z} from 'zod';
import type {ChoiceArgs,ChoiceResponse} from '../choice/contracts.js';
const id=z.string().min(1),timeout=z.number().int().positive().safe().optional();
export const webUrlSchema=z.string().url().refine(value=>{const url=new URL(value);return url.protocol==='http:'||url.protocol==='https:';},{message:'Use an HTTP or HTTPS URL'});
const control={control_id:id};
export const realBrowserActionSchema=z.discriminatedUnion('operation',[
 z.strictObject({id,operation:z.literal('click'),...control}),
 z.strictObject({id,operation:z.literal('fill'),...control,value:z.string()}),
 z.strictObject({id,operation:z.literal('select'),...control,value:z.string()}),
 z.strictObject({id,operation:z.literal('press'),...control,key:z.string().min(1)}),
 z.strictObject({id,operation:z.literal('scroll'),dx:z.number().finite().optional(),dy:z.number().finite().optional()}),
 z.strictObject({id,operation:z.literal('back')}),
 z.strictObject({id,operation:z.literal('navigate'),url:webUrlSchema})
]);
export const realBrowserSchemas={
 browser_open:z.strictObject({url:webUrlSchema}),
 browser_observe:z.strictObject({session_id:id}),
 browser_act:z.strictObject({session_id:id,snapshot_id:id,idempotency_key:id,task:z.string().min(1),actions:z.array(realBrowserActionSchema).min(1),timeout_ms:timeout,postcondition:z.strictObject({urlContains:z.string().optional(),textIncludes:z.string().optional()}).optional()}).refine(args=>new Set(args.actions.map(action=>action.id)).size===args.actions.length,{message:'Duplicate action ID'}),
 browser_close:z.strictObject({session_id:id})
};
export const realBrowserDescriptions={
 browser_open:'Open any HTTP/HTTPS website in a new isolated Chromium session, separate from your everyday Chrome profile.',
 browser_observe:'Read current viewport text and grounded visible controls from your real browser session.',
 browser_act:'Ask real Jev to choose among grounded browser actions, execute the selected action once, and return the actual after state. Execution does not establish task completion. Reuse the same idempotency key after uncertain responses; UNKNOWN is never replayed.',
 browser_close:'Close your isolated Chromium session while preserving its durable execution audit.'
};
export type RealBrowserAction=z.infer<typeof realBrowserActionSchema>;
export type RealBrowserActArgs=z.infer<typeof realBrowserSchemas.browser_act>;
export interface RealBrowserControl {control_id:string;tag:string;role:string;label:string;operations:Array<'click'|'fill'|'select'|'press'>;href?:string;options?:Array<{value:string;label:string}>}
export interface RealBrowserObservation {navigation_pending?:boolean;session_id:string;snapshot_id:string;url:string;title:string;text:string;viewport:{width:number;height:number;scrollX:number;scrollY:number};controls:RealBrowserControl[]}
export interface RealBrowserActionResult {selected_id?:string;decision?:ChoiceResponse;execution:'executed'|'unknown';after?:RealBrowserObservation;postcondition_met?:boolean;reason?:string}
export interface RealBrowserOptions {storageDir:string;chooseAction:(client:string,args:ChoiceArgs,signal:AbortSignal)=>Promise<ChoiceResponse>;executablePath?:string}
