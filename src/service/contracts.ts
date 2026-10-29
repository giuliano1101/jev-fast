import {z} from 'zod';
import {schemas} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
export type ToolName=`jev.${keyof typeof schemas}`;
const descriptions:Record<keyof typeof schemas,string>={open_session:'Open the approved local synthetic fixture.',observe:'Read a safe current observation.',run_goal:'Run an approved bounded synthetic goal through the shared safety gate.',cancel:'Cancel an active goal and report any unknown action.',status:'Read durable session, goal, or action status without replay.',close_session:'Close a session while preserving durable action status.'};
export const toolDefinitions=Object.entries(schemas).map(([name,schema])=>({name:`jev.${name}` as ToolName,description:descriptions[name as keyof typeof schemas],inputSchema:z.toJSONSchema(schema,{io:'input'})}));
export function parseTool(method:string,args:unknown):unknown {
 const definition=toolDefinitions.find(t=>t.name===method);
 if(!definition)throw new Fault('UNKNOWN_METHOD');
 const result=schemas[method.slice(4) as keyof typeof schemas].safeParse(args);
 if(!result.success)throw new Fault('INVALID_ARGUMENTS');
 return result.data;
}
