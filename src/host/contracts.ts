import {z} from 'zod';
import {CallToolResultSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {choiceResponseSchema,type ChoiceResponse} from '../remote/choice.js';
const hostName=z.string().min(1);
export const hostSchemas={
 host_tools:z.strictObject({host:hostName}),
 host_act:z.strictObject({host:hostName,idempotency_key:z.string().min(1),task:z.string().min(1),state:z.json(),actions:z.array(z.strictObject({id:z.string().min(1),tool:z.string().min(1),arguments:z.record(z.string(),z.json()),description:z.string().min(1)})).min(1),timeout_ms:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).refine(args=>new Set(args.actions.map(action=>action.id)).size===args.actions.length,{message:'Duplicate action ID'})
};
export type HostActArgs=z.infer<typeof hostSchemas.host_act>;
export const hostActionResultSchema=z.strictObject({decision:choiceResponseSchema,selected_id:z.string().min(1),execution:z.enum(['executed','unknown']),result:CallToolResultSchema});
export interface HostActionResult {decision:ChoiceResponse;selected_id:string;execution:'executed'|'unknown';result:CallToolResult}
/** Unknown describes possible physical effects; it is never an instruction to replay. */
export function unknownHostResult(decision:ChoiceResponse):HostActionResult{return {decision,selected_id:decision.selected_id,execution:'unknown',result:{isError:true,content:[{type:'text',text:'HOST_ACTION_UNKNOWN: inspect the current host state; do not replay this request.'}]}};}
