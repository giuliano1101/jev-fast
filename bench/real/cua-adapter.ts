import {PUBLIC_CONTROLS} from './catalog.js';

/** The supplied target is a CUA handle. No direct OS input or page script execution. */
export interface PublicCUATarget {
 click(index:number):Promise<void>;
 setValue(index:number,value:string):Promise<void>;
 playwright?:{locator(selector:string):{selectOption(value:{label:string}):Promise<void>;setChecked(value:boolean):Promise<void>}};
}
const fields:Record<string,{dom:string;value:string;kind:'select'|'fill'|'check'}>={
 language_english:{dom:'searchLanguage',value:'English',kind:'select'},fill_query:{dom:'searchInput',value:'Kyoto',kind:'fill'},
 fill_m1:{dom:'today_Month_ID',value:'Nov',kind:'select'},fill_d1:{dom:'today_Day_ID',value:'1',kind:'select'},fill_y1:{dom:'today_Year_ID',value:'2026',kind:'fill'},
 fill_m2:{dom:'ageat_Month_ID',value:'Nov',kind:'select'},fill_d2:{dom:'ageat_Day_ID',value:'15',kind:'select'},fill_y2:{dom:'ageat_Year_ID',value:'2026',kind:'fill'},
 include_end:{dom:'addendday',value:'1',kind:'check'},
};
/** Call only with the immediately preceding observation and its bindings. */
export async function executePublicControl(target:PublicCUATarget,id:string,bindings:Record<string,number>,axText:string):Promise<void>{
 const index=bindings[id];
 if(!Object.hasOwn(PUBLIC_CONTROLS,id)||!Number.isSafeInteger(index)||index!<0)throw new Error('INVALID_CURRENT_BINDING');
 const field=fields[id];
 if(field){
  const observed=axText.split('\n').filter(line=>new RegExp(`^\\s*${index}\\s+.*\\bID:\\s*${field.dom}(?:,|$)`).test(line));
  if(observed.length===0)throw new Error('FIELD_ID_CHANGED');
  if(field.kind==='check'){
   const values=observed.length===1?[...observed[0]!.matchAll(/\bValue:\s*([^,]+)(?=,|$)/g)].map(match=>match[1]!.trim()):[];
   if(values.length!==1||!['0','1'].includes(values[0]!))throw new Error('CHECKBOX_STATE_UNVERIFIED');
   if(values[0]==='0')await target.click(index!);
   return;
  }
  if(field.kind==='fill'){await target.setValue(index!,field.value);return;}
  if(!target.playwright)throw new Error('BROWSER_CONTROL_UNAVAILABLE');
  const locator=target.playwright.locator(`#${field.dom}`);
  await locator.selectOption({label:field.value});
  return;
 }
 await target.click(index!);
}
