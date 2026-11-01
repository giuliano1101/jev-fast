import {z} from 'zod';
import {schemas} from '../core/contracts.js';
import {choiceArgsSchema} from '../choice/contracts.js';
import {Fault} from '../core/errors.js';
import {hostSchemas} from '../host/contracts.js';
import {realBrowserSchemas,realBrowserDescriptions} from '../browser/real-contracts.js';
export type ToolName=`jev.${keyof typeof schemas}`|'jev.choose_action'|`jev.${keyof typeof realBrowserSchemas}`|`jev.${keyof typeof hostSchemas}`;
const descriptions:Record<string,string>={...realBrowserDescriptions,host_tools:'Discover tools of an operator-configured real MCP host such as the connected Android phone.',host_act:'Ask real Jev to choose and execute one configured host MCP operation, preserving durable no-replay evidence.',open_session:'Open an isolated fixture browser session; independent sessions may run concurrently.',observe:'Read a safe current fixture observation.',run_goal:'Run a fixture goal with optional caller step and time budgets.',cancel:'Cancel an active goal and report any unknown action.',status:'Read durable session, goal, or action status without replay.',close_session:'Close your session while preserving durable action status.',choose_action:'Use real Jev to choose from host-observed actions for any browser, desktop or mobile task. Host executes and verifies the effect.'};
export const toolInputSchemas=Object.fromEntries([...Object.entries(schemas).map(([name,schema])=>[`jev.${name}`,schema] as const),['jev.choose_action',choiceArgsSchema],...Object.entries(realBrowserSchemas).map(([name,schema])=>[`jev.${name}`,schema] as const),...Object.entries(hostSchemas).map(([name,schema])=>[`jev.${name}`,schema] as const)]) as Record<ToolName,z.ZodType>;
export function schemaForTool(method:string):z.ZodType|undefined{return Object.hasOwn(toolInputSchemas,method)?toolInputSchemas[method as ToolName]:undefined;}
export const toolDefinitions=Object.entries(toolInputSchemas).map(([name,schema])=>({name:name as ToolName,description:descriptions[name.slice(4)]!,inputSchema:z.toJSONSchema(schema,{io:'input'})}));
export function parseTool(method:string,args:unknown):unknown{const schema=schemaForTool(method);if(!schema)throw new Fault('UNKNOWN_METHOD');const result=schema.safeParse(args);if(!result.success)throw new Fault('INVALID_ARGUMENTS');return result.data;}
