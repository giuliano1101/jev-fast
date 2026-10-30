import {randomUUID} from 'node:crypto';
import type {ExecutionJournal,PendingExecution} from '../hybrid/execution-journal.js';
import {classifyMobilePage} from './adapter.js';
import {parseMobileElements,type MobileTransport,type MobileToolName,type MobileToolArguments} from './transport.js';
export interface MobileResetResult {status:'SUCCEEDED'|'FAILED'|'UNKNOWN';reason:string;tools:{name:string;durationMs:number}[]}
/** Setup only, excluded from measured trials. It navigates known Settings pages, never a switch. */
export async function resetMobileHome(transport:Pick<MobileTransport,'call'>,journal:ExecutionJournal):Promise<MobileResetResult>{
 const result:MobileResetResult={status:'FAILED',reason:'UNKNOWN_PAGE',tools:[]};
 if(await journal.getPending('mobile-surface'))return {...result,status:'UNKNOWN',reason:'SURFACE_QUARANTINED'};
 const sessionId=`reset_${randomUUID()}`,deadline=Date.now()+60000;let observationId=`reset_${randomUUID()}`;
 async function input<K extends MobileToolName>(name:K,args:MobileToolArguments<K>){
  if(Date.now()>=deadline){result.reason='RESET_LIMIT';return false;}
  const event:PendingExecution={schemaVersion:1,eventId:randomUUID(),leaseKey:'mobile-surface',sessionId,actionId:name,observationId,startedAt:Date.now()};
  await journal.begin(event);const start=performance.now();
  const response=await transport.call(name,args);result.tools.push({name,durationMs:performance.now()-start});
  if(response.status!=='succeeded'){result.status='UNKNOWN';result.reason='RESET_INPUT_UNCERTAIN';return false;}
  await journal.acknowledge(event,'executed');return true;
 }
 try{
  if(!await input('mobile_launch_app',{packageName:'com.android.settings'}))return result;
  for(let attempt=0;attempt<6&&Date.now()<deadline;attempt++){
   const start=performance.now();const observed=await transport.call('mobile_list_elements_on_screen',{format:'json'});
   result.tools.push({name:'mobile_list_elements_on_screen',durationMs:performance.now()-start});
   if(observed.status!=='succeeded')return {...result,reason:'RESET_OBSERVATION_FAILED'};
   const nodes=parseMobileElements(observed.hostLocalResult);const page=classifyMobilePage(nodes);observationId=`reset_${randomUUID()}`;
   if(page==='home')return {...result,status:'SUCCEEDED',reason:'HOME_VERIFIED'};
   if(['search_empty','search_font','search_notification'].includes(page)){
    const cancel=nodes.filter(n=>n.identifier==='com.android.settings:id/animated_cancel_button'&&n.text==='取消'&&n.enabled!==false);
    if(cancel.length!==1)return result;
    if(!await input('mobile_click_on_screen_at_coordinates',{ref:cancel[0]!.ref}))return result;
   }else if(['bluetooth','sharing','font_preview','notification_list','special_permissions'].includes(page)){
    if(!await input('mobile_press_button',{button:'BACK'}))return result;
   }else return result;
  }
  return {...result,reason:'RESET_LIMIT'};
 }catch{const pending=await journal.getPending('mobile-surface').catch(()=>true);return {...result,status:pending?'UNKNOWN':'FAILED',reason:'RESET_FAILED'};}
}
