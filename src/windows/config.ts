import {readFile} from 'node:fs/promises';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import type {PanelProfile} from './panel.js';

const action=z.strictObject({method:z.literal('POST'),path:z.string(),body:z.record(z.string(),z.unknown())});
export const windowsConfigSchema=z.strictObject({
 endpoint:z.url().default('https://jev.43-160-233-161.sslip.io/mcp'),runtime:z.string(),allowedFileRoots:z.array(z.string()).default([]),
 browser:z.strictObject({headless:z.boolean().default(false),executable:z.string().optional(),cdpUrl:z.url().optional()}).default({headless:false}),
 panels:z.array(z.strictObject({id:z.string(),url:z.url(),statusPath:z.string(),actions:z.record(z.string(),action)})).default([])
});
export interface WindowsConfig {endpoint:string;runtime:string;allowedFileRoots:string[];browser:{headless:boolean;executable?:string;cdpUrl?:string};panels:PanelProfile[];script:string}
export async function loadWindowsConfig(path:string):Promise<WindowsConfig>{
 const file=resolve(path),config=windowsConfigSchema.parse(JSON.parse(await readFile(file,'utf8')));
 const base=dirname(file),absolute=(p:string)=>isAbsolute(p)?p:resolve(base,p);
 const runtime=absolute(config.runtime),script=fileURLToPath(new URL('../../../scripts/windows-uia.ps1',import.meta.url));
 if(config.browser.cdpUrl&&config.browser.headless)throw new Fault('ATTACHED_BROWSER_CANNOT_BE_HEADLESS');
 return {...config,runtime,allowedFileRoots:[runtime,...config.allowedFileRoots.map(absolute)],script,browser:config.browser};
}
export function browserProfile(config:WindowsConfig){return join(config.runtime,'browser-profile');}
