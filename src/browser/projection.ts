import {z} from 'zod';
import type {Goal,Candidate} from '../core/contracts.js';
import type {State} from './frame.js';

/** Reviewed fixture task text only. Raw DOM strings and entered values are never interpolated. */
export const taskInstructions={
 form:'Fill the name, click Next, select the target category, then submit once.',
 duplicate:'Fill the name, click Next, select the target category, then submit once.',
 filter:'Fill the filter query with the required synthetic query.',
 detail:'Open the item detail page.',navigation:'Open the item detail page.',
 back:'Open the item detail page, then return to the list.',
 cancel:'Cancel the synthetic task without submitting.',
 correction:'Submit to show validation, fill the required synthetic email, then submit once.',
 async:'Load the items, then wait for the ready state.',wait:'Load the items, then wait for the ready state.',
 scroll:'Scroll to the bottom of the page.',select:'Select the target category.'
} as const satisfies Record<Goal['task'],string>;
export const nextSteps=['fill_name','next','select_category','submit','show_validation','fill_email','fill_query','open_detail','back','cancel','load','wait','scroll','none'] as const;
export const fixtureProjectionSchema=z.strictObject({
 version:z.literal('fixture-v2'),instruction:z.enum([...new Set(Object.values(taskInstructions))] as [string,...string[]]),
 next_step:z.enum(nextSteps),name_matches_goal:z.boolean(),email_matches_goal:z.boolean(),category_matches_goal:z.boolean(),query_matches_goal:z.boolean()
});
export type FixtureProjection=z.infer<typeof fixtureProjectionSchema>;
export function projectFixture(state:State,goal:Goal):FixtureProjection{
 const progress={name_matches_goal:state.name===`Synthetic-${goal.seed}`,email_matches_goal:state.email===`synthetic-${goal.seed}@example.invalid`,category_matches_goal:state.category==='beta',query_matches_goal:state.query===`item-${goal.seed}`};
 let next:FixtureProjection['next_step']='none';
 // Use observed field/state progress, never the fixture completion oracle.
 if(!state.cancelled&&state.submitted===0)switch(goal.task){
  case 'cancel':next='cancel';break;
  case 'filter':if(!progress.query_matches_goal)next='fill_query';break;
  case 'detail':case 'navigation':if(state.step===0)next='open_detail';break;
  case 'back':next=state.step===0?'open_detail':'back';break;
  case 'select':if(!progress.category_matches_goal)next='select_category';break;
  case 'scroll':if(!state.scrolled)next='scroll';break;
  case 'async':case 'wait':if(!state.loaded)next=state.step===0?'load':'wait';break;
  case 'correction':next=!state.error&&!progress.email_matches_goal?'show_validation':!progress.email_matches_goal?'fill_email':'submit';break;
  default:next=!progress.name_matches_goal?'fill_name':state.step===0?'next':!progress.category_matches_goal?'select_category':'submit';
 }
 return {version:'fixture-v2',instruction:taskInstructions[goal.task],next_step:next,...progress};
}
const descriptions={
 fill_name:'Fill name with the required synthetic value; current name does not match the task.',
 next:'Click Next to continue; the name already matches the task.',
 select_category:'Select the target category; the current selection does not match the task.',
 submit:'Click Submit once; the name and category are ready to submit.',
 show_validation:'Click Submit to display the required email validation error before correcting it.',
 fill_email:'Fill the required synthetic email to correct the visible email validation error.',
 corrected_submit:'Click Submit once; the email is corrected and ready to submit despite the previous error message.',
 fill_query:'Fill the required synthetic filter query; the current query does not match the task.',
 open_detail:'Click Open detail to view the item detail page.',
 back:'Go back from the item detail page to the list.',
 cancel:'Click Cancel to carry out the requested cancellation without submitting.',
 alternative_cancel:'Click Cancel to abandon the current task without completing its requested steps.',
 load:'Click Load items to start loading the requested items.',
 wait:'Wait for the requested items to become ready; loading has already started.',
 scroll:'Scroll to the page bottom; the bottom has not yet been reached.'
} as const;
export const richCandidateDescriptions=new Set<string>(Object.values(descriptions));
export function describeFixtureCandidate(ref:string,operation:Candidate['operation'],projection:FixtureProjection,task:Goal['task']):string{
 if(ref==='cancel')return task==='cancel'?descriptions.cancel:descriptions.alternative_cancel;
 if(ref==='submit'&&task==='correction')return projection.next_step==='show_validation'?descriptions.show_validation:descriptions.corrected_submit;
 const key=operation==='fill'?`fill_${ref}`:ref==='category'?'select_category':ref==='detail'?'open_detail':ref==='loaded'?'wait':ref==='bottom'?'scroll':ref;
 const description=descriptions[key as keyof typeof descriptions];
 if(!description)throw new Error('Unsupported fixture candidate description');
 return description;
}
