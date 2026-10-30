// Records assistant-operated Mobile MCP trials. No device or API calls are made here.
// The local operator bridge must write result-<nonce>.json with tool timestamps.
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(process.env.JEV_MOBILE_RUNTIME_DIR??'.runtime/mobile');
const active=join(root,'baseline-active.json');
const tasks={M1:'bluetooth',M2:'sharing',M3:'font',M4:'notifications',M5:'font',M6:'notifications'};
function elements(row){
 const t=row.response?.content?.find(x=>x.type==='text')?.text;
 if(row.name!=='mobile_list_elements_on_screen'||!t?.startsWith('Found these elements on screen: '))return [];
 return JSON.parse(t.slice('Found these elements on screen: '.length)).filter(x=>x.coordinates?.y>=96);
}
function page(nodes){
 const text=s=>nodes.some(n=>n.text===s),id=s=>nodes.some(n=>n.identifier===s);
 if(id('com.android.settings:id/animated_hint')&&text('搜索设置项'))return 'home';
 const query=nodes.find(n=>n.identifier==='com.android.settings:id/search_src_text');
 if(query){if(!query.text)return 'search-empty';if(query.text==='字体')return 'search-font';if(query.text==='通知')return 'search-notification';return 'other-query';}
 if(text('特殊应用权限')&&text('设备和应用通知'))return 'special-permissions';
 if(text('设备和应用通知')&&id('com.android.settings:id/special_access_summary'))return 'notifications';
 if(text('字体与显示')&&id('com.android.settings:id/title_font_size')&&id('com.android.settings:id/display_zoom_title'))return 'font';
 if(text('蓝牙')&&id('android:id/switch_widget')&&nodes.some(n=>n.label==='转到上一层级')&&!text('连接与共享'))return 'bluetooth';
 if(text('连接与共享')&&text('飞行模式')&&text('USB 网络共享'))return 'sharing';
 if(nodes.some(n=>n.identifier==='com.heytap.browser:id/fez'&&n.text==='Example Domain'))return 'example-title';
 return 'other';
}
const [command,task,repeat]=process.argv.slice(2);
if(command==='start'){
 if(!Object.hasOwn(tasks,task)||!/^r[1-9]$/.test(repeat??''))throw Error('INVALID_TRIAL');
 const last=JSON.parse(await readFile(join(root,'response.json'),'utf8'));
 if(page(elements(last))!=='home'||Date.now()-last.finished_at>30000)throw Error('FRESH_HOME_RESET_REQUIRED');
 const id=`${task}-baseline-${repeat}`;
 await mkdir('artifacts/mobile/baseline',{recursive:true});
 let previous;try{previous=JSON.parse(await readFile(active,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(previous){try{await readFile(`artifacts/mobile/baseline/${previous.id}.json`);}catch{throw Error('FINISH_PREVIOUS_TRIAL_FIRST');}}
 try{await readFile(`artifacts/mobile/baseline/${id}.json`);throw Error('TRIAL_ALREADY_RECORDED');}catch(e){if(e.code!=='ENOENT')throw e;}
 await writeFile(active,JSON.stringify({id,task,started_at:Date.now(),reset:'settings-home-verified',mode:'assistant-mobile-mcp'}),{flag:'w',mode:0o600});
 console.log(JSON.stringify({trial:id,status:'started'}));
}else if(command==='finish'){
 const run=JSON.parse(await readFile(active,'utf8'));const ended=Date.now();
 const rows=[];
 for(const name of await readdir(root))if(/^result-[A-Za-z0-9-]+\.json$/.test(name)){
  const row=JSON.parse(await readFile(join(root,name),'utf8'));
  if(row.started_at>=run.started_at&&row.finished_at<=ended)rows.push(row);
 }
 rows.sort((a,b)=>a.started_at-b.started_at);
 const observed=rows.filter(r=>r.name==='mobile_list_elements_on_screen');
 const pages=observed.map(r=>page(elements(r)));
 const inputs=rows.filter(r=>!['mobile_list_elements_on_screen','mobile_get_foreground_app','mobile_get_screen_size','mobile_save_screenshot'].includes(r.name));
 const ordered=expected=>{let i=0;for(const p of pages)if(p===expected[i])i++;return i===expected.length;};
 const goal=pages.at(-1)===tasks[run.task]&&(run.task!=='M5'||ordered(['home','search-empty','search-font','font','example-title','font']))&&(run.task!=='M6'||ordered(['home','search-empty','search-font','font','search-font','search-empty','search-notification','special-permissions','notifications']));
 const failed=rows.some(r=>r.response?.isError)||inputs.length>12||ended-run.started_at>300000;
 const result={...run,finished_at:ended,status:goal&&!failed?'SUCCEEDED':'FAILED',goal_verified:goal,
  elapsed_ms:ended-run.started_at,mobile_tool_ms:rows.reduce((n,r)=>n+r.finished_at-r.started_at,0),
  physical_actions:inputs.length,observations:observed.length,public_observed_pages:pages,
  tools:rows.map(r=>({name:r.name,start_offset_ms:r.started_at-run.started_at,elapsed_ms:r.finished_at-r.started_at,error:Boolean(r.response?.isError)})),
  paid_api_requests:0,measurement:'Complete assistant workflow including reasoning/tool dispatch and final recording; resets excluded. Tool time separately measured by the local MCP host. No model-only latency inference.'};
 await writeFile(`artifacts/mobile/baseline/${run.id}.json`,JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify(result));
}else throw Error('EXPECTED_START_OR_FINISH');
