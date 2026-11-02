import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {safeCode} from '../service/ipc.js';
import {Fault} from '../core/errors.js';
import {WindowsEngine} from './engine.js';
import {localBrowserAction} from './browser.js';
import {hostStepSchema} from './host-workflow.js';
import {routeCapability,type ActionIntent} from './router.js';

const id=z.string().min(1),empty=z.strictObject({});
const intent=z.strictObject({operation_id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),target:id,snapshot_id:id,task:id,actions:z.array(z.strictObject({id,description:id,action:z.record(z.string(),z.unknown())})).min(1),expected:z.record(z.string(),z.unknown())});
const definitions={
 status:{schema:empty,description:'Read real Jev readiness and available Windows executors; no model Key or operator APIs.'},
 route:{schema:z.strictObject({capability:id,environment:z.enum(['windows','remote','android'])}),description:'Route by actual capability and target environment. A route is not execution.'},
 browser_open:{schema:z.strictObject({url:z.url().refine(u=>/^https?:/.test(u)),operation_id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)}),description:'Ask real Jev to open an authorized URL in the local persistent browser. Returns owned session and actual observation.'},
 browser_observe:{schema:z.strictObject({session_id:id}),description:'Read actual local browser text, controls, frames, canvas bounds and downloads. Fresh snapshot, no input.'},
 browser_act:{schema:intent.extend({actions:z.array(z.strictObject({id,description:id,action:localBrowserAction})).min(1)}),description:'Jev chooses one observed local browser action; durable dispatch and postcondition verification. Same operation_id never replays unknown input.'},
 browser_screenshot:{schema:z.strictObject({session_id:id}),description:'Save actual local browser screenshot privately; image interpretation is a separate host verification step.'},
 browser_diagnostics:{schema:z.strictObject({session_id:id}),description:'Read local H5 canvas/viewport/media/resource/error diagnostics. Game replay uses observed canvas actions, never arbitrary JavaScript.'},
 browser_close:{schema:z.strictObject({session_id:id}),description:'Close only this owned browser session; uncertain contexts remain retained.'},
 desktop_windows:{schema:empty,description:'List actual Windows top-level windows for task-scoped attachment.'},
 desktop_attach:{schema:z.strictObject({process_id:z.number().int().positive(),window_handle:z.number().int()}),description:'Read one Windows window and bind process start identity. No physical input.'},
 desktop_observe:{schema:z.strictObject({target_id:id}),description:'Read actual Windows UI Automation controls; password fields remain private.'},
 desktop_screenshot:{schema:z.strictObject({target_id:id}),description:'Capture only the attached native window to a private PNG. Captured pixels still require visual verification.'},
 desktop_act:{schema:intent,description:'Jev selects one observed UIA Invoke/SetValue/Toggle/Select. No arbitrary shell or coordinate input.'},
 native_status:{schema:empty,description:'Discover actual upstream native desktop permissions and tool schemas; no hosted model call.'},
 native_apps:{schema:empty,description:'Read real running native apps on this machine; metadata only.'},
 native_prepare:{schema:z.strictObject({app:z.union([z.string().min(1),z.number().int().positive()])}),description:'Bind a native app target to this client using a real state or launch inventory; no input.'},
 native_observe:{schema:z.strictObject({target_id:id,include_screenshot:z.boolean().optional()}),description:'Refresh this owned native app observation. Pixels are saved privately, not sent as base64 to Jev.'},
 native_act:{schema:intent,description:'Real Jev selects an upstream native app action, including Unicode typing, keys, mouse, scroll, drag or document opening. Stable operation id, actual native guards and posterior verification.'},
 host_tools:{schema:z.strictObject({host:id}),description:'Discover actual configured remote host MCP schemas before using them.'},
 host_step:{schema:hostStepSchema,description:'Persist a named Android/MCP-host workflow step, invoke real Jev once and retain unknown outcomes. A subsequent fresh read must verify task completion.'},
 host_progress:{schema:z.strictObject({workflow_id:id}),description:'Inspect immutable workflow step progress without repeating actions.'},
 panel_observe:{schema:z.strictObject({panel_id:id}),description:'Read an operator-configured local control-panel status API.'},
 panel_act:{schema:intent,description:'Jev selects a preconfigured local panel operation and checks status/receipt. Does not establish real cloud video, audio or RTC success.'},
 artifact_inspect:{schema:z.strictObject({path:id}),description:'Read a task-authorized local output: path, size, SHA-256 and PDF/ZIP signatures. Full document validation is reported separately.'},
 operation_status:{schema:z.strictObject({operation_id:id}),description:'Inspect original local action outcome. UNKNOWN is never replayed.'},
 request_recover:{schema:z.strictObject({request_id:id}),description:'Query only the original Jev request with privately cached continuation; never resubmit.'},
 verify_known:{schema:z.strictObject({kind:z.enum(['browser','desktop','panel','native']),target:id,operation_id:id}),description:'Fresh read to verify a known executed action without repeating it. Does not clear UNKNOWN.'},
 release:{schema:empty,description:'Release only this executor connection and owned browser sessions, retaining unresolved contexts.'},
};
export async function startWindowsMcp(engine:WindowsEngine,transport:Transport=new StdioServerTransport()){
 const server=new Server({name:'jev-windows',version:'0.3.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(definitions).map(([name,d])=>({name:'jev_windows.'+name,description:d.description,inputSchema:z.toJSONSchema(d.schema,{io:'input'})}))}));
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  let complete=()=>{};
  try{
   complete=engine.enterTask();
   const name=request.params.name.replace(/^jev_windows\./,'') as keyof typeof definitions,d=definitions[name];if(!d)throw new Fault('UNKNOWN_TOOL');
   const a=d.schema.parse(request.params.arguments??{}) as Record<string,unknown>;let result:unknown;
   switch(name){
    case 'status':result=await engine.status();break;
    case 'route':result=a.capability==='mobile'&&a.environment==='android'?{route:'jev',executor:'configured-host-discovery',next:'jev_windows.host_tools',requires_device_match:true}:routeCapability({capability:String(a.capability),environment:a.environment as 'windows'|'remote'|'android',registered:['windows-browser','remote-browser',...(process.platform==='win32'?['windows-desktop']:[])]});break;
    case 'browser_open':result=await engine.browserOpen(String(a.url),String(a.operation_id),extra.signal);break;
    case 'browser_observe':result=await engine.browserObserve(String(a.session_id));break;
    case 'browser_act':result=await engine.browserAct(a as unknown as ActionIntent,extra.signal);break;
    case 'browser_screenshot':result=await engine.browserScreenshot(String(a.session_id));break;
    case 'browser_diagnostics':result=await engine.browserDiagnostics(String(a.session_id));break;
    case 'browser_close':result=await engine.browserClose(String(a.session_id));break;
    case 'desktop_windows':result=await engine.desktop.list();break;
    case 'desktop_attach':result=await engine.desktopAttach(Number(a.process_id),Number(a.window_handle));break;
    case 'desktop_observe':result=await engine.desktopObserve(String(a.target_id));break;
    case 'desktop_screenshot':result=await engine.desktopScreenshot(String(a.target_id));break;
    case 'desktop_act':result=await engine.desktopAct(a as unknown as ActionIntent,extra.signal);break;
    case 'native_status':result=await engine.native.status();break;
    case 'native_apps':result=await engine.native.apps();break;
    case 'native_prepare':result=await engine.native.prepare(a.app as string|number);break;
    case 'native_observe':result=await engine.native.fresh(String(a.target_id),a.include_screenshot===true);break;
    case 'native_act':result=await engine.nativeAct(a as unknown as ActionIntent,extra.signal);break;
    case 'host_tools':result=await engine.hostTools(String(a.host));break;
    case 'host_step':result=await engine.hostStep(hostStepSchema.parse(a),extra.signal);break;
    case 'host_progress':result=await engine.host.progress(String(a.workflow_id));break;
    case 'panel_observe':result=await engine.panelObserve(String(a.panel_id));break;
    case 'panel_act':result=await engine.panelAct(a as unknown as ActionIntent,extra.signal);break;
    case 'artifact_inspect':result=await engine.artifact(String(a.path));break;
    case 'operation_status':result=await engine.operationStatus(String(a.operation_id));break;
    case 'request_recover':result=await engine.recoverRequest(String(a.request_id));break;
    case 'verify_known':result=await engine.verifyKnown(a.kind as 'browser'|'desktop'|'panel'|'native',String(a.target),String(a.operation_id));break;
    case 'release':result=await engine.release();break;
   }
   return {content:[{type:'text',text:JSON.stringify(result)}]};
  }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:error instanceof z.ZodError?'INVALID_ARGUMENTS':safeCode(error)})}]};}finally{complete();}
 });
 server.onerror=()=>process.stderr.write('WINDOWS_MCP_PROTOCOL_ERROR\n');
 await server.connect(transport);return server;
}
