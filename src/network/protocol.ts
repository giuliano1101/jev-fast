import {z} from 'zod';
import {idSchema,schemas} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {parseTool,toolDefinitions,type ToolName} from '../service/contracts.js';
import {canonicalDigest,canonicalJson} from '../remote/protocol.js';
export {canonicalJson,canonicalDigest};
export const MAX_BODY=65536;
export const bindingSchema=z.strictObject({device_id:idSchema,agent_id:idSchema});
export type Binding=z.infer<typeof bindingSchema>;
export const nonceSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const methodSchema=z.enum(toolDefinitions.map(t=>t.name) as [ToolName,...ToolName[]]);
export const replySchema=z.discriminatedUnion('ok',[
 z.strictObject({ok:z.literal(true),result:z.json()}),
 z.strictObject({ok:z.literal(false),error:z.strictObject({code:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)})})
]);
export type LocalReply=z.infer<typeof replySchema>;
export const outcomeSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('reply'),reply:replySchema}),z.strictObject({kind:z.literal('unknown')})
]);
export type Outcome=z.infer<typeof outcomeSchema>;
export const receiptSchema=z.strictObject({request_id:idSchema,delivery_nonce:nonceSchema,outcome:outcomeSchema});
export type Receipt=z.infer<typeof receiptSchema>;
export const deliverySchema=bindingSchema.extend({request_id:idSchema,method:methodSchema,params:z.json(),delivery_nonce:nonceSchema,expires_at:z.number().int().positive(),local_instance_id:z.uuid()});
export type Delivery=z.infer<typeof deliverySchema>;
export const syncSchema=z.strictObject({connector_id:z.uuid(),ready:z.boolean(),local_instance_id:z.uuid().nullable(),capacity:z.number().int().min(0).max(4),results:z.array(receiptSchema).max(1)}).refine(v=>!v.ready||v.local_instance_id!==null);
export type Sync=z.infer<typeof syncSchema>;
export const syncReplySchema=z.strictObject({acks:z.array(z.strictObject({request_id:idSchema,delivery_nonce:nonceSchema})).max(1),job:deliverySchema.nullable()});
export const statuses=['QUEUED','DISPATCHED','COMPLETED','REJECTED','UNKNOWN'] as const;
export interface Envelope {request_id:string;delivery_status:typeof statuses[number];reply?:LocalReply;}
/** No caller identity, arbitrary synthetic text, or provider configuration is stored. */
export function normalizeRequest(method:string,value:unknown):{request_id:string;params:Record<string,unknown>} {
 const wrapper=z.strictObject({request_id:idSchema,params:z.unknown()}).safeParse(value);
 if(!wrapper.success)throw new Fault('INVALID_ARGUMENTS');
 const params=parseTool(method,wrapper.data.params) as Record<string,unknown>;
 if(method==='jev.run_goal'){
  const goal=params.goal as z.infer<typeof schemas.run_goal>['goal'];
  const canonical={name:`Synthetic-${goal.seed}`,email:`synthetic-${goal.seed}@example.invalid`,category:'beta',query:`item-${goal.seed}`};
  for(const [key,val] of Object.entries(goal.values??{}))if(val!==canonical[key as keyof typeof canonical])throw new Fault('NONCANONICAL_SYNTHETIC_VALUE');
  const success=params.success as z.infer<typeof schemas.run_goal>['success'];
  if(success.kind==='field'&&success.value!==canonical[success.field])throw new Fault('NONCANONICAL_SYNTHETIC_VALUE');
 }
 if(Buffer.byteLength(canonicalJson(params))>48000)throw new Fault('REQUEST_TOO_LARGE');
 return {request_id:wrapper.data.request_id,params};
}
export const networkToolDefinitions=[...toolDefinitions.map(t=>({...t,inputSchema:z.toJSONSchema(z.strictObject({request_id:idSchema,params:schemas[t.name.slice(4) as keyof typeof schemas]}),{io:'input'})})),
 {name:'jev.network_status',description:'Read connector readiness without dispatching.',inputSchema:z.toJSONSchema(z.strictObject({}))},
 {name:'jev.request_status',description:'Recover the durable delivery result by the original request_id. UNKNOWN never permits replay.',inputSchema:z.toJSONSchema(z.strictObject({request_id:idSchema}))}];
