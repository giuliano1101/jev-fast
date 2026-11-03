import {desktopToolDefinitions,parseDesktopTool} from './contracts.js';
import {NativeDesktopDriver,nativeLaunchSpec,type NativeLaunchSpec} from './driver.js';
export interface DesktopDriver {call(method:string,input:Record<string,unknown>):Promise<Record<string,unknown>>;close():Promise<void>}
/** Direct per-host native execution. Callers must verify the observed postcondition. */
export class DesktopExecutor {
 readonly tools=desktopToolDefinitions;
 private readonly driver:DesktopDriver;
 constructor(options:{driver?:DesktopDriver;launchSpec?:NativeLaunchSpec}={}){
  if(options.driver&&options.launchSpec)throw Error('INVALID_NATIVE_CONFIGURATION');
  this.driver=options.driver??new NativeDesktopDriver(options.launchSpec??nativeLaunchSpec());
 }
 async call(name:string,input:unknown):Promise<Record<string,unknown>>{return this.driver.call(name.replace(/^desktop_/,''),parseDesktopTool(name,input));}
 close():Promise<void>{return this.driver.close();}
}
