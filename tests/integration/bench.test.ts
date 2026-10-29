import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runBenchmark} from '../../bench/run.js';
test('mock benchmark exports both modes, all rows, actual manifest and no secrets',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-bench-test-'));try{
 const report=await runBenchmark({outputDir:dir,goals:[{task:'form',language:'zh',seed:4}]});
 assert.equal(report.rows.length,2);assert.ok(report.rows.every(r=>r.status==='SUCCEEDED'));
 const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));assert.equal(manifest.live_api_called,false);assert.equal(manifest.samples,2);assert.match(manifest.lock_hash,/^[0-9a-f]{64}$/);
 for(const name of ['events.jsonl','tasks.csv','summary.md','manifest.json'])assert.doesNotMatch(await readFile(join(dir,name),'utf8'),/CANARY_|Bearer |TYPESAFE_API_KEY=/);
 assert.match(await readFile(join(dir,'summary.md'),'utf8'),/mock/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('benchmark exceptions replace stale success artifacts and retain started task failures',async()=>{
 const {BrowserAdapter}=await import('../../src/browser/adapter.js');const {writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'jev-bench-failure-'));const original=BrowserAdapter.prototype.check;
 BrowserAdapter.prototype.check=async()=>{throw new Error('CANARY_ORACLE_EXCEPTION');};
 try{await writeFile(join(dir,'summary.md'),'OLD SUCCESS REPORT');await assert.rejects(runBenchmark({outputDir:dir,goals:[{task:'form',language:'en',seed:1}]}),/BENCHMARK_FAILED/);
 const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));assert.equal(manifest.status,'failed');assert.equal(manifest.samples,1);
 const csv=await readFile(join(dir,'tasks.csv'),'utf8');assert.match(csv,/FAILED/);assert.doesNotMatch(csv,/CANARY_/);
 const summary=await readFile(join(dir,'summary.md'),'utf8');assert.doesNotMatch(summary,/OLD SUCCESS REPORT|CANARY_/);
 }finally{BrowserAdapter.prototype.check=original;await rm(dir,{recursive:true,force:true});}
});
