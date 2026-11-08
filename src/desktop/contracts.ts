import {z} from 'zod';
function approvedFileURL(file:string){
  if(!file.startsWith('file:///')||file.includes('?')||file.includes('#')||file.includes('@'))return false;
  try{if(decodeURIComponent(file).split('/').includes('..'))return false;const url=new URL(file);return url.protocol==='file:'&&url.hostname===''&&url.username===''&&url.pathname.startsWith('/')&&url.search===''&&url.hash==='';}catch{return false;}
}
const app=z.union([z.string().min(1),z.number().int().positive().safe()]);
const id=z.string().min(1),point=z.number().finite();
const target={app,observation_id:id};
const coordinates={coordinate_space:z.enum(['screen','screenshot']).optional()};
export const desktopSchemas={
 desktop_status:z.strictObject({}),
 desktop_list_apps:z.strictObject({}),
 desktop_launch_app:z.strictObject({app,activate:z.boolean().optional()}),
 desktop_open_document:z.strictObject({app,path:z.string().min(1)}),
 desktop_get_state:z.strictObject({app,window_id:id.optional(),include_screenshot:z.boolean().optional()}),
 desktop_screenshot:z.strictObject({app:app.optional(),window_id:id.optional(),full_display:z.boolean().optional()}).refine(value=>value.app!==undefined||value.full_display===true,{message:'Window capture needs an app; full display may use the frontmost app'}),
 desktop_activate_app:z.strictObject({app,window_id:id.optional()}),
 desktop_click:z.strictObject({...target,element_id:id.optional(),x:point.optional(),y:point.optional(),button:z.enum(['left','right','middle']).optional(),click_count:z.number().int().positive().safe().optional(),...coordinates}).refine(value=>value.element_id!==undefined?value.x===undefined&&value.y===undefined:value.x!==undefined&&value.y!==undefined,{message:'Choose one observed element or coordinate pair'}),
 desktop_type_text:z.strictObject({...target,text:z.string(),element_id:id.optional()}),
 desktop_press_key:z.strictObject({...target,key:z.string().min(1)}),
 desktop_set_value:z.strictObject({...target,element_id:id,value:z.string()}),
 desktop_scroll:z.strictObject({...target,element_id:id.optional(),dx:point.optional(),dy:point.optional()}),
 desktop_drag:z.strictObject({...target,from_x:point,from_y:point,to_x:point,to_y:point,...coordinates}),
 desktop_perform_action:z.strictObject({...target,element_id:id,action:z.string().min(1)}),
 desktop_copy_files:z.strictObject({...target,element_ids:z.array(id).min(1).max(8),files:z.array(z.string().min(1).max(4096)).min(1).max(8)}).refine(value=>value.element_ids.length===value.files.length && new Set(value.element_ids).size===value.element_ids.length && new Set(value.files).size===value.files.length && value.files.every(approvedFileURL),{message:'Copy requires the same number of unique observed elements and approved file URLs'}),
};
const descriptions:Record<keyof typeof desktopSchemas,string>={
 desktop_status:'Read native desktop platform and actual OS permissions. No application allowlist or model call.',
 desktop_list_apps:'List running native applications on this execution machine; launch also accepts installed application names or paths outside this inventory.',
 desktop_launch_app:'Launch any installed native application by name, bundle ID, path or running process ID.',
 desktop_open_document:'Open a local document in the selected native application. This may change the visible desktop.',
 desktop_get_state:'Read actual native app/window accessibility controls with grounded observation and element IDs; optionally include pixels.',
 desktop_screenshot:'Capture actual native window pixels or full_display with origin/scale mapping; full_display may omit app to choose the frontmost display. Screenshot success is not task completion.',
 desktop_activate_app:'Activate a native app/window. Does not restrict which installed apps can be targeted.',
 desktop_click:'Click one grounded native control or observed coordinate once. Old or mismatched targets are rejected.',
 desktop_type_text:'Enter arbitrary Unicode text in a native app, optionally targeting an observed editable element.',
 desktop_press_key:'Send a native named key or modifier chord such as cmd+s, ctrl+a, return or alt+f4.',
 desktop_set_value:'Set the actual value of an observed native editable control through the OS accessibility API.',
 desktop_scroll:'Scroll the observed app/window or control; positive dy moves down.',
 desktop_drag:'Drag between observed coordinates using the app snapshot coordinate mapping.',
 desktop_perform_action:'Invoke an observed native element action exposed by its OS accessibility provider.',
 desktop_copy_files:'Copy only the observed selected elements whose file URLs exactly match the approved file URL set. Returns whether that set matched and the file URL count, without clipboard text or file contents.',
};
export const desktopToolDefinitions=Object.entries(desktopSchemas).map(([name,schema])=>({name,description:descriptions[name as keyof typeof desktopSchemas],inputSchema:z.toJSONSchema(schema)}));
export function parseDesktopTool(name:string,args:unknown):Record<string,unknown>{
 if(!Object.hasOwn(desktopSchemas,name))throw new Error('DESKTOP_TOOL_UNAVAILABLE');
 return desktopSchemas[name as keyof typeof desktopSchemas].parse(args) as Record<string,unknown>;
}
