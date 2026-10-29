import test from 'node:test';
import assert from 'node:assert/strict';
import {executePublicControl} from '../../bench/real/cua-adapter.js';
test('adapter refuses missing binding and missing DOM identity',async()=>{
 const calls:string[]=[];const target={click:async()=>{calls.push('click');},setValue:async()=>{calls.push('set');}};
 await assert.rejects(executePublicControl(target,'fill_query',{},''));
 await assert.rejects(executePublicControl(target,'fill_query',{fill_query:21},'21 text other'));
 assert.deepEqual(calls,[]);
});
test('adapter binds exact observed field and only fills public test value',async()=>{
 const calls:unknown[]=[];const target={click:async()=>{},setValue:async(index:number,value:string)=>{calls.push([index,value]);}};
 await executePublicControl(target,'fill_query',{fill_query:21},'21 search text field, ID: searchInput');
 assert.deepEqual(calls,[[21,'Kyoto']]);
});
test('adapter selects observed dropdown without executing scripts',async()=>{
 const calls:unknown[]=[];const target={click:async()=>{},setValue:async()=>{},playwright:{locator:(selector:string)=>({selectOption:async(value:unknown)=>{calls.push([selector,value]);},setChecked:async()=>{}})}};
 await executePublicControl(target,'fill_m1',{fill_m1:45},'45 pop up button, ID: today_Month_ID');
 assert.deepEqual(calls,[['#today_Month_ID',{label:'Nov'}]]);
});
test('adapter refuses invented and macro actions',async()=>{
 const target={click:async()=>{assert.fail('must not click');},setValue:async()=>{}};
 await assert.rejects(executePublicControl(target,'prepare_dates',{prepare_dates:4},''));
 await assert.rejects(executePublicControl(target,'delete_work',{delete_work:4},''));
});
test('adapter clicks the freshly observed unchecked checkbox through native AX only',async()=>{
 const calls:number[]=[];const target={click:async(index:number)=>{calls.push(index);},setValue:async()=>{assert.fail('must not set value');},playwright:{locator:()=>{assert.fail('hidden checkbox must not use Playwright');}}};
 await executePublicControl(target,'include_end',{include_end:139},'139 checkbox Include end day, Value: 0, ID: addendday');
 assert.deepEqual(calls,[139]);
});
test('adapter leaves an already checked native checkbox unchanged',async()=>{
 const target={click:async()=>{assert.fail('must not toggle a checked checkbox');},setValue:async()=>{assert.fail('must not set value');}};
 await executePublicControl(target,'include_end',{include_end:239},'239 checkbox Include end day, Value: 1, ID: addendday');
});
test('adapter rejects missing or ambiguous checkbox state instead of toggling blindly',async()=>{
 const target={click:async()=>{assert.fail('must not toggle unknown state');},setValue:async()=>{assert.fail('must not set value');}};
 for(const ax of ['139 checkbox Include end day, ID: addendday','139 checkbox Include end day, Value: 2, ID: addendday','138 checkbox Value: 0, ID: addendday\n139 checkbox Include end day, ID: addendday','139 checkbox Value: 0, ID: addendday\n139 checkbox Value: 1, ID: addendday'])await assert.rejects(executePublicControl(target,'include_end',{include_end:139},ax),/CHECKBOX_STATE_UNVERIFIED/);
});
