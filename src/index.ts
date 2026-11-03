/** Per-host Jev execution library. No CLI or MCP server is started on import. */
export {startService,stopService,serviceHealth,inspectService,type StartServiceOptions} from './service/lifecycle.js';
export {Coordinator,type CoordinatorOptions} from './service/coordinator.js';
export {readCredential,ipcCall,type Credential} from './service/ipc.js';
export {Engine} from './core/engine.js';
export {DesktopExecutor,type DesktopDriver} from './desktop/executor.js';
export {NativeDesktopDriver,nativeLaunchSpec,type NativeLaunchSpec} from './desktop/driver.js';
export {desktopToolDefinitions,parseDesktopTool} from './desktop/contracts.js';
export {LocalBrowserService,type DecisionPort,type LocalBrowserServiceOptions} from './local/service.js';
export {localBackendConfig,selectBrowser} from './local/config.js';
export {RealBrowserService} from './browser/real.js';
export {HostService,createHostMcpClient} from './host/service.js';
export {toolDefinitions,parseTool} from './service/contracts.js';
export {loadServiceProfile,type ServiceProfile} from './service/config.js';
export type {DecisionProvider,BrowserPort} from './core/contracts.js';
export type {ChoiceArgs,ChoiceResponse} from './choice/contracts.js';
export {RemoteDecisionProvider,RemoteChoiceClient,type RemoteDecisionOptions} from './remote/client.js';
