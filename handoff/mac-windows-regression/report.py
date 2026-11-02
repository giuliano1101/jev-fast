"""Emit only aggregate offline results. Private logs are never uploaded."""
import datetime,json,pathlib,re,subprocess,sys

root=pathlib.Path(__file__).resolve().parents[2]
out=root/'.runtime/mac-regression'
out.mkdir(parents=True,exist_ok=True)
expected=['typecheck','lint','unit','integration','safety','deployment','native_protocol']
groups={'setup':{},'checks':{}}
status=out/'status.tsv'
if status.exists():
    for row in status.read_text().splitlines():
        group,name,code=row.split('\t')
        item={'exit_code':int(code)}
        log=(out/(name+'.log')).read_text(errors='replace')
        log=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',log)
        for label,key in [('tests','tests'),('pass','passed'),('fail','failed'),('skipped','skipped')]:
            found=re.findall(r'(?:\u2139|#)\s+'+label+r'\s+(\d+)',log)
            if found:
                item[key]=int(found[-1])
        if name in ('deployment','native_protocol'):
            match=re.search(r'Ran (\d+) tests?',log)
            if match:
                item['tests']=int(match.group(1))
        groups['checks' if group=='check' else 'setup'][name]=item
not_run=[name for name in expected if name not in groups['checks']]
exit_code=int(sys.argv[1])
if not_run or any(item['exit_code'] for group in groups.values() for item in group.values()):
    exit_code=exit_code or 1
def command(*args):
    try:
        return subprocess.check_output(args,cwd=root,text=True,stderr=subprocess.DEVNULL).strip()
    except (OSError,subprocess.CalledProcessError):
        return None
result={'base_revision':'56d4cd5e8fc80064aa112b11cf6abe2c2cc0524b','tested_revision':command('git','rev-parse','HEAD'),'branch':command('git','branch','--show-current'),'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform':sys.platform,'node_version':command('node','--version'),'scope':'isolated offline source regression; no hosted Jev calls','setup':groups['setup'],'checks':groups['checks'],'not_run':not_run,'exit_code':exit_code,'all_required_checks_passed':exit_code==0 and not not_run,'raw_logs_uploaded':False,'shared_service_changed':False}
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
print('Return only result.json and redacted failure summaries. Private logs:',out)
raise SystemExit(exit_code)
