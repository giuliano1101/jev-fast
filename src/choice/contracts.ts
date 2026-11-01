import {z} from 'zod';
import {usageSchema} from '../core/contracts.js';
/** JSON transport guards bound bytes/depth separately; these are not task/action quotas. */
export const choiceArgsSchema=z.strictObject({
 idempotency_key:z.string().min(1),task:z.string().min(1),state:z.json(),
 actions:z.array(z.strictObject({id:z.string().min(1),description:z.string().min(1)})).min(1),
 timeout_ms:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).refine(value=>new Set(value.actions.map(action=>action.id)).size===value.actions.length,{message:'Duplicate action ID'});
export type ChoiceArgs=z.infer<typeof choiceArgsSchema>;
export const choiceDecisionSchema=z.strictObject({provider:z.literal('jev'),model:z.literal('jev-1.14.0'),selected_id:z.string().min(1),confidence:z.number().finite().min(0).max(1),usage:usageSchema.nullable()});
export type ChoiceDecision=z.infer<typeof choiceDecisionSchema>;

export type {ChoiceResponse} from '../remote/choice.js';
