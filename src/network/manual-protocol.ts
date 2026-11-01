import {z} from 'zod';
import {syncSchema,syncReplySchema} from './protocol.js';
export const manualSyncSchema=z.strictObject({handle:z.uuid(),sync:syncSchema,revoked:z.array(z.string().regex(/^network-[a-f0-9]{64}$/)),invalidated:z.array(z.string().regex(/^network-[a-f0-9]{64}$/))});
export const manualSyncReplySchema=syncReplySchema.extend({owners:z.array(z.string().regex(/^network-[a-f0-9]{64}$/)),revocations:z.array(z.string().regex(/^network-[a-f0-9]{64}$/)),enabled:z.boolean()});
