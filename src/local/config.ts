import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,win32} from 'node:path';
import {z} from 'zod';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {HostConfig} from '../host/service.js';
export type LocalBrowserOptions={mode:'launch'|'attach'|'extension';browser:'chrome'|'msedge'|'chromium';stateDir:string;endpoint?:string;executablePath?:string;headless?:boolean};
/** Installed vendor channels only; choosing a channel never silently switches to a headless browser. */
export function selectBrowser(platform:string=process.platform,environment:Record<string,string|undefined>=process.env,exists:(path:string)=>boolean=existsSync):'chrome'|'msedge'{
 if(platform==='win32'){
  for(const channel of ['msedge','chrome'] as const)for(const root of [environment.ProgramFiles,environment['ProgramFiles(x86)'],environment.LOCALAPPDATA].filter((x):x is string=>!!x))if(exists(win32.join(root,channel==='msedge'?'Microsoft':'Google',channel==='msedge'?'Edge':'Chrome','Application',channel==='msedge'?'msedge.exe':'chrome.exe')))return channel;
 }else if(platform==='darwin'){
  if(exists('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))return 'chrome';
  if(exists('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'))return 'msedge';
 }else if(['/usr/bin/google-chrome','/usr/bin/google-chrome-stable'].some(exists))return 'chrome';
 throw Error('LOCAL_BROWSER_NOT_INSTALLED');
}
export function localBackendConfig(options:LocalBrowserOptions):HostConfig{
 const cli=join(dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')),'cli.js');
 const args=[cli,`--browser=${options.browser}`,'--timeout-action=0','--timeout-navigation=0','--cdp-timeout=0','--idle-timeout=0',`--output-dir=${join(options.stateDir,'output')}`];
 if(options.mode==='attach'){
  const endpoint=options.endpoint??options.browser;
  if(!['chrome','msedge'].includes(endpoint)){
   let url:URL;try{url=new URL(endpoint);}catch{throw Error('INVALID_LOCAL_CDP_ENDPOINT');}
   if(!['http:','ws:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('INVALID_LOCAL_CDP_ENDPOINT');
  }
  args.push(`--cdp-endpoint=${endpoint}`);
 }else if(options.mode==='extension')args.push('--extension');
 else args.push('--isolated');
 if(options.headless){if(options.mode!=='launch')throw Error('HEADLESS_REQUIRES_LAUNCH');args.push('--headless');}
 if(options.executablePath)args.push(`--executable-path=${options.executablePath}`);
 return {serverCommand:process.execPath,serverArgs:args};
}
const safeObservationSchemas:Record<string,z.ZodType>={
 browser_snapshot:z.strictObject({target:z.string().optional(),depth:z.number().optional(),boxes:z.boolean().optional()}),
 browser_console_messages:z.strictObject({level:z.enum(['error','warning','info','debug']).optional(),all:z.boolean().optional()}),
 browser_network_requests:z.strictObject({static:z.boolean().optional(),filter:z.string().optional(),all:z.boolean().optional()}),
 browser_network_request:z.strictObject({index:z.number().int().positive(),part:z.enum(['request-headers','request-body','response-headers','response-body']).optional()})
};
/** The pinned backend's readOnlyHint is necessary but not sufficient: tabs/evaluate and file outputs are excluded. */
export function readOnlyObservation(tool:Tool,args:Record<string,unknown>):boolean{return tool.annotations?.readOnlyHint===true&&safeObservationSchemas[tool.name]?.safeParse(args).success===true;}
