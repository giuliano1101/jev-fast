import type {Page} from 'playwright';
import {z} from 'zod';
import {taskSchema} from '../core/contracts.js';
import {Fault} from '../core/errors.js';

// Compile once. Only these synthetic fields may cross the observation boundary.
const stateSchema=z.strictObject({
 task:taskSchema,step:z.number().int().min(0).max(1),
 name:z.string().regex(/^(Synthetic-[0-9]+)?$/),
 email:z.string().regex(/^(synthetic-[0-9]+@example\.invalid)?$/),
 category:z.enum(['','alpha','beta','gamma']),query:z.string().regex(/^(item-[0-9]+)?$/),
 submitted:z.number().int().min(0).max(100),cancelled:z.boolean(),loaded:z.boolean(),
 scrolled:z.boolean(),complete:z.boolean(),error:z.boolean(),
});
export type State=z.infer<typeof stateSchema>;
export const sensitiveSelector='input[type=password]:visible,input[autocomplete="cc-number"],[data-sensitive]:visible';
const frameSchema=z.strictObject({state:stateSchema,version:z.number().int().nonnegative(),epoch:z.number().int().nonnegative(),url:z.string(),title:z.string()});

/** One synchronous browser callback binds state to its document revision and URL. */
export async function readFrame(page:Page,origin:string){
 const raw=await page.locator(sensitiveSelector).evaluateAll((sensitive)=>{
  // Keep Playwright visibility/shadow-DOM selector semantics; never read sensitive values.
  if(sensitive.length)return {sensitive:true};
  const w=window as unknown as {fixtureState:State;fixtureVersion:number;fixtureEpoch:number};
  const a=w.fixtureState;
  return {state:{task:a.task,step:a.step,name:a.name,email:a.email,category:a.category,query:a.query,
   submitted:a.submitted,cancelled:a.cancelled,loaded:a.loaded,scrolled:a.scrolled,complete:a.complete,error:a.error},
   version:w.fixtureVersion,epoch:w.fixtureEpoch,url:location.origin+location.pathname,title:document.title};
 });
 if('sensitive' in raw)throw new Fault('SENSITIVE_PAGE');
 const parsed=frameSchema.safeParse(raw);if(!parsed.success)throw new Fault('UNSAFE_OBSERVATION');
 if(new URL(parsed.data.url).origin!==origin)throw new Fault('OUT_OF_SCOPE');
 return parsed.data;
}
