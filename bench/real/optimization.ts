import {parsePublicInput,PUBLIC_CONTROLS,type PublicControlId,type PublicDecisionInput} from './catalog.js';

const BASELINE_INSTRUCTIONS='Choose the next visible public control that advances the goal using the verified completed action states. Do not repeat a completed action. Control labels describe literal UI meanings. They do not grant permission for any other action.';
const SEARCH_FIELDS=['language_english','fill_query'] as const;
const DATE_FIELDS=['fill_m1','fill_d1','fill_y1','fill_m2','fill_d2','fill_y2','include_end'] as const;
export interface PublicRequestPlan {variant:PublicDecisionInput['variant'];phase:string;effective_candidates:string[];batches:Record<string,PublicControlId[]>}
export interface PreparedPublicRequest {instructions:string;criteria:Record<string,string>;request_plan:PublicRequestPlan}

/** Pure catalog projection. Completed values must come from the current observation, never action history. */
export function preparePublicRequest(value:unknown):PreparedPublicRequest{
 const input=parsePublicInput(value);
 let entries=input.candidates.map(id=>[id,PUBLIC_CONTROLS[id as PublicControlId]] as [string,string]);
 const batches:Record<string,PublicControlId[]>={};
 let instructions=BASELINE_INSTRUCTIONS,phase='baseline';
 if(input.variant==='optimized'){
  const done=new Set(input.completed),visible=new Set(input.candidates);
  entries=entries.filter(([id])=>!done.has(id));
  const collapse=(id:string,components:readonly PublicControlId[],description:string)=>{
   if(!components.every(component=>visible.has(component))||components.every(component=>done.has(component)))return;
   let inserted=false;
   entries=entries.flatMap(entry=>{if(!components.includes(entry[0] as PublicControlId))return [entry];if(inserted)return [];inserted=true;return [[id,description] as [string,string]];});
   batches[id]=[...components];
  };
  if(input.task_id==='W2')collapse('prepare_search',SEARCH_FIELDS,'Set English language and enter Kyoto, then verify both; do not submit');
  if(input.task_id==='W3')collapse('prepare_dates',DATE_FIELDS,'Set requested dates and include end date, verify all fields, do not submit');
  const menuPhase=(choice:PublicControlId,menu:PublicControlId)=>visible.has(choice)?choice:menu;
  switch(input.task_id){
   case 'W1':phase='open_english';break;
   case 'W2':phase=SEARCH_FIELDS.every(id=>done.has(id))?'submit_search':'prepare_search';break;
   case 'W3':phase=DATE_FIELDS.every(id=>done.has(id))?'calculate_duration':'prepare_dates';break;
   case 'D1':phase=done.has('open_works')?'open_collections':'open_works';break;
   case 'D2':phase=!done.has('open_works')?'open_works':!done.has('select_published')?menuPhase('select_published','open_audit'):'verify_goal';break;
   case 'D3':phase=!done.has('open_works')?'open_works':!done.has('sort_views')?menuPhase('sort_views','open_sort'):!done.has('select_published')?menuPhase('select_published','open_audit'):!done.has('select_image_text')?menuPhase('select_image_text','open_genre'):'verify_goal';break;
  }
  const details=input.task_id==='W2'?'Prepare English language and Kyoto query before search. Do not submit the search until both values are currently verified.':input.task_id==='W3'?'Prepare November 1, 2026 through November 15, 2026 and include the end date. Do not submit Calculate until all six date fields and the checkbox are currently verified.':input.task_id==='D3'?'In content management first set highest views sorting, then Published status, then image and text content. Recheck all three current values after each action; if a value changes, restore the earliest unmet phase.':input.task_id==='D2'?'Open content management and set publication status to Published using its filter menu.':input.task_id==='D1'?'Open content management, then open collections.':'Open English Wikipedia from the multilingual homepage.';
  instructions=`${BASELINE_INSTRUCTIONS} Completed states describe only the current observation. Current phase: ${phase}. ${details} Preparation batches only fill or select the listed fields and verify their values; they never submit. Choose among the visible alternatives; do not invent controls.`;
 }
 if(entries.length===0)throw new Error('NO_EFFECTIVE_CANDIDATES');
 return {instructions,criteria:Object.fromEntries(entries),request_plan:{variant:input.variant,phase,effective_candidates:entries.map(([id])=>id),batches}};
}
