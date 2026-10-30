"""Read-only descriptive analysis of the frozen expanded benchmark."""
import argparse,json,math,statistics
from pathlib import Path

def pct(values):
    x=sorted(values)
    return {'n':len(x),'p50_ms':x[math.ceil(.50*len(x))-1] if x else None,'p95_ms':x[math.ceil(.95*len(x))-1] if x else None,'min_ms':x[0] if x else None,'max_ms':x[-1] if x else None}

def group(rows,key):
    out={}
    for value in sorted({r[key] for r in rows}):
        rs=[r for r in rows if r[key]==value];ran=[r for r in rs if r['status']!='NOT_RUN'];good=[r for r in rs if r['status']=='SUCCEEDED']
        out[str(value)]={'planned':len(rs),'attempted':len(ran),'succeeded':len(good),'success_fraction':len(good)/len(rs),'all_attempted':pct([r['elapsed_ms'] for r in ran if 'elapsed_ms'in r]),'successful':pct([r['elapsed_ms'] for r in good]),'run_goal_successful':pct([r['run_goal_ms'] for r in good])}
    return out

parser=argparse.ArgumentParser();parser.add_argument('--normal',type=Path,required=True);parser.add_argument('--faults',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);a=parser.parse_args()
rows=json.load(open(a.normal/'rows.json'));faults=json.load(open(a.faults/'rows.json'));attempts=json.load(open(a.normal/'attempts.json'));assert len(rows)==108 and len(faults)==48
for r in rows:r['difficulty']='complex' if r['task'] in ['form','duplicate'] else 'medium' if r['task'] in ['back','correction','async','wait'] else 'simple'
by_id={(r['task'],r['seed'],r['entry']):r for r in rows};pairs={}
for entry in ['cli','mcp']:
    ratios=[]
    for r in rows:
        if r['entry']!='direct' or r['status']!='SUCCEEDED':continue
        other=by_id[(r['task'],r['seed'],entry)]
        if other['status']=='SUCCEEDED':ratios.append(other['elapsed_ms']/r['elapsed_ms'])
    pairs[entry+'_over_direct']={'successful_pairs':len(ratios),'median_workflow_time_ratio':statistics.median(ratios) if ratios else None,'meaning':'facade/direct matched completed workflow; not computer-use speedup'}
fault_groups={}
for name in sorted({r['scenario'] for r in faults}):
    fs=[r for r in faults if r['scenario']==name];fault_groups[name]={'planned':len(fs),'attempted':sum(r['status']!='NOT_RUN' for r in fs),'safe_passed':sum(r.get('expected_pass',r.get('safe_pass',False)) is True for r in fs)}
u=[x['usage'] for x in attempts if x.get('usage') is not None]
d={'normal_planned':108,'normal_succeeded':sum(r['status']=='SUCCEEDED' for r in rows),'normal_not_run':sum(r['status']=='NOT_RUN' for r in rows),'by_entry':group(rows,'entry'),'by_task':group(rows,'task'),'by_seed':group(rows,'seed'),'by_language':group(rows,'language'),'by_difficulty':group(rows,'difficulty'),'matched_pairs':pairs,'faults':fault_groups,'fault_safe_passed':sum(r.get('expected_pass',r.get('safe_pass',False)) is True for r in faults),'model_attempts':len(attempts),'known_usage_attempts':len(u),'unknown_usage_attempts':len(attempts)-len(u),'known_input_tokens':sum(x['input_tokens'] for x in u),'estimated_known_cost_usd':sum(x['input_tokens'] for x in u)*.042/1e6,'hosted_response_observed':pct([x['observed_ms'] for x in attempts if 'observed_ms' in x]),'pacing_wait_ms':sum(r.get('pace_wait_ms',0) for r in rows),'quantile':'nearest rank; descriptive fixed tasks, not random independent population'}
with a.out.open('x') as f:json.dump(d,f,indent=2);f.write('\n')
print(json.dumps(d,indent=2))
