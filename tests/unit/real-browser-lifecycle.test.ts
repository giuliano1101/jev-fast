import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,type Browser,type BrowserContext} from 'playwright';
import {RealBrowserService} from '../../src/browser/real.js';
test('revocation drains a context allocated before its first page exists',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-real-lifecycle-'));let rejectPage!:(error:Error)=>void,entered!:()=>void,closed=0;const entering=new Promise<void>(resolve=>{entered=resolve;});
 const context={setDefaultTimeout(){},setDefaultNavigationTimeout(){},async newPage(){entered();return new Promise((_resolve,reject)=>{rejectPage=reject;});},async close(){closed++;rejectPage(new Error('context closed'));},pages(){return [];}} as unknown as BrowserContext;
 const browser={async newContext(){return context;},async close(){}} as unknown as Browser;t.mock.method(chromium,'launch',async()=>browser);
 const service=new RealBrowserService({storageDir:dir,chooseAction:async()=>{throw new Error('unused');}});const opening=service.open('owner',{url:'https://example.net'}),rejected=assert.rejects(opening,/BROWSER_OPEN_CONTEXT_CLOSED/);let revoke:Promise<void>|undefined;
 try{await entering;revoke=service.revokeOwner('owner');await new Promise(resolve=>setTimeout(resolve,10));assert.ok(closed>0,'owner revocation must close a context before awaiting its blocked newPage');await revoke;await rejected;}
 finally{rejectPage?.(new Error('context closed'));await rejected;await revoke;await service.shutdown();await rm(dir,{recursive:true,force:true});}
});
