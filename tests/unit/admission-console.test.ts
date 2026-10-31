import test from 'node:test';
import assert from 'node:assert/strict';
test('operator console is loopback only and guards all operator API with fragment token and exact origin',async()=>{
 const path='../../src/network/admission-console.js',api=await import(path).catch(()=>({}));assert.equal(typeof api.startAdmissionConsole,'function','admission console missing');
 const adapter={list:()=>[{id:'a',type:'ai',name:'<script>label</script>',enabled:false}],setEnabled:()=>({ok:true})};
 const panel=await api.startAdmissionConsole({registry:adapter});
 try{
  const url=new URL(panel.url);assert.equal(url.hostname,'127.0.0.1');assert.ok(url.hash.length>32);
  assert.equal((await fetch(url.origin+'/api/status')).status,403);
  const headers={origin:url.origin,'x-jev-control-token':url.hash.slice(1)};
  assert.equal((await fetch(url.origin+'/api/status',{headers})).status,200);
  assert.equal((await fetch(url.origin+'/api/status',{headers:{...headers,origin:'https://evil.invalid'}})).status,403);
  assert.equal((await fetch(url.origin+'/api/admission',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({id:'a',enabled:true})})).status,200);
  const script=await (await fetch(url.origin+'/app.js')).text();assert.ok(script.includes('textContent'));assert.equal(script.includes('innerHTML'),false);
 }finally{await panel.close();}
});
