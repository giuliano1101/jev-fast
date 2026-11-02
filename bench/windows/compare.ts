import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Fault} from '../../src/core/errors.js';
interface Run {scenario_version:string;environment:string;executor:string;cases:Array<{id:string;status:string;elapsed_ms:number;scope:string}>;usage?:{known_input_tokens?:number;main_codex_usage?:unknown;account_bill?:unknown}}
/** Comparison consumes measured runs; it never fabricates a Codex baseline from a deterministic script. */
export function compareWindowsRuns(baseline:Run,jev:Run){
 if(baseline.executor!=='codex-host'||jev.executor!=='real-jev-windows'||baseline.scenario_version!==jev.scenario_version||baseline.environment!==jev.environment)throw new Fault('INCOMPARABLE_BENCHMARK_RUNS');
 const before=new Map(baseline.cases.map(c=>[c.id,c])),after=new Map(jev.cases.map(c=>[c.id,c]));
 const ids=[...new Set([...before.keys(),...after.keys()])];const missing=ids.filter(id=>!before.has(id)||!after.has(id));
 const pairs=ids.filter(id=>before.has(id)&&after.has(id)).map(id=>{const a=before.get(id)!,b=after.get(id)!;if(a.scope!==b.scope||!Number.isFinite(a.elapsed_ms)||!Number.isFinite(b.elapsed_ms))throw new Fault('INCOMPARABLE_BENCHMARK_CASE');return {id,baseline_status:a.status,jev_status:b.status,baseline_ms:a.elapsed_ms,jev_ms:b.elapsed_ms};});
 return {matched_cases:pairs.length,missing_cases:missing,baseline_passed:pairs.filter(p=>p.baseline_status==='passed').length,jev_passed:pairs.filter(p=>p.jev_status==='passed').length,pairs,total_time_comparable:false,total_cost_comparable:baseline.usage?.account_bill!=null&&jev.usage?.account_bill!=null,note:'Per-check durations are measured. Group checks may overlap, so they are not summed. A complete business comparison must separately measure main Codex reasoning, transport, observation, recovery and verification wall time.'};
}
async function main(){if(process.argv.length!==4)throw new Fault('INVALID_ARGUMENTS');console.log(JSON.stringify(compareWindowsRuns(JSON.parse(await readFile(process.argv[2]!,'utf8')) as Run,JSON.parse(await readFile(process.argv[3]!,'utf8')) as Run),null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{console.error('BENCHMARK_COMPARISON_FAILED');process.exitCode=1;});
