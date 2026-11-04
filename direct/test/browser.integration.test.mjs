import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {JevSession,BrowserAdapter,BrowserWorkflow,browserCandidate,browserProjection} from '../index.mjs';
import {fixture} from './helpers.mjs';

test('scroll rebind accepts layout-only movement but retains page and scroll position checks',()=>{
  const adapter=Object.create(BrowserAdapter.prototype);
  const state={observation_id:'one',document_key:'doc',page_id:'page',url:'https://example.test/',title:'Example',elements:[],scroll:{x:0,y:0,viewport:800,height:1200},regions:[{id:'main',x:500,y:400}]};
  const moved={...state,observation_id:'two',scroll:{...state.scroll,height:1600},regions:[{id:'main',x:700,y:450}]};
  const spec={id:'scroll',description:'Reveal controls in main content',method:'scroll',params:{delta:500}};
  const before=browserCandidate(state,spec),after=browserCandidate(moved,spec);
  assert.notDeepEqual(before.input.point,after.input.point);
  assert.deepEqual(adapter.guard(before,state),adapter.guard(after,moved));
  const project=s=>BrowserWorkflow.prototype.projection.call(null,spec,s);
  assert.deepEqual(project(state),project(moved));
  assert.notDeepEqual(project(state),project({...moved,scroll:{...moved.scroll,y:100}}));
  assert.notDeepEqual(adapter.guard(after,moved),adapter.guard({...after,input:{...after.input,observation_id:'three'}},{...moved,observation_id:'three',document_key:'new-document'}));
  const urlState={...state,url:'https://example.test/?search=park+four+seasons&title=Special:MediaSearch'};
  const encoded={...urlState,url:'https://example.test/?search=park%20four%20seasons&title=Special%3AMediaSearch'};
  assert.deepEqual(adapter.guard(before,urlState),adapter.guard(before,encoded));
  assert.notDeepEqual(adapter.guard(before,urlState),adapter.guard(before,{...encoded,url:encoded.url+'&changed=1'}));
});

test('owned isolated browser fills, selects, checks and submits once using grounded local handles',async()=>{
  const f=fixture();let submitted=0,decisions=0;
  const server=createServer((req,res)=>{
    if(req.method==='POST'){submitted++;res.end('ok');return;}
    res.setHeader('content-type','text/html;charset=utf-8');
    res.end(`<!doctype html><title>Offline Jev browser adapter test</title><label>City <input aria-label="City"></label><label>Category <select aria-label="Category"><option value="a">Alpha</option><option value="b">Beta</option></select></label><label><input type="checkbox" aria-label="Confirm">Confirm</label><input type="password" aria-label="Private" value="not-for-the-model"><button>Save</button><p role="status">Pending</p><script>document.querySelector('button').onclick=async()=>{await fetch('/save',{method:'POST'});document.querySelector('p').textContent='Saved';};</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let session;
  try{
    const adapter=await BrowserAdapter.launch({url:`http://127.0.0.1:${server.address().port}/`});
    session=await JevSession.open({adapter,jev:{async choose(args){decisions++;return {selected_id:args.actions[0].id,confidence:1};},close(){}},directory:join(f.runtime,'session')});
    const state=await session.observe();
    assert.equal(state.elements.find(e=>e.label==='Private').value,'[private]');
    assert.equal(JSON.stringify(browserProjection(state)).includes('not-for-the-model'),false);
    const specs=[
      {id:'fill',method:'fill',label:'City',params:{value:'Kyoto'},verify:s=>s.elements.some(e=>e.label==='City'&&e.value==='Kyoto')},
      {id:'select',method:'select',label:'Category',params:{value:'b'},verify:s=>s.elements.some(e=>e.label==='Category'&&e.value==='b')},
      {id:'check',method:'click',label:'Confirm',verify:s=>s.elements.some(e=>e.label==='Confirm'&&e.checked)},
      {id:'save',method:'click',label:'Save',verify:s=>s.text.includes('Saved')},
    ];
    for(const spec of specs){
      const options={task:spec.id,goalId:'offline',idempotencyKey:spec.id,intent:{step:spec.id},project:browserProjection,
        candidates:s=>[browserCandidate(s,{...spec,description:spec.id})],verify:spec.verify};
      const result=await session.step(options);
      assert.equal(result.status,'VERIFIED',JSON.stringify({step:spec.id,result}));
      assert.equal((await session.step(options)).cached,true);
    }
    assert.equal(submitted,1);assert.equal(decisions,4);
  }finally{await session?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.cleanup();}
});

test('workflow owns tabs, main-body scrolling, unique fields and one real browser download',async()=>{
  const f=fixture();let downloads=0,decisions=0;
  const server=createServer((req,res)=>{
    if(req.url==='/file'){downloads++;res.setHeader('Content-Disposition','attachment; filename="test.txt"');res.end('saved through Chrome');return;}
    res.setHeader('content-type','text/html;charset=utf-8');
    res.end('<title>Workflow fixture</title><aside style="position:fixed;left:0;width:200px;height:100vh;overflow:auto"><div style="height:5000px">Sidebar</div></aside>'+(req.url==='/below'?'<header style="height:1000px">Tall header</header>':'')+'<main style="margin-left:250px"><input name="sample"><input name="same" type="radio" value="one"><input name="same" type="radio" value="two"><div style="height:1600px"></div><a href="/file">Get file</a></main>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let workflow;
  try{
    const url=`http://127.0.0.1:${server.address().port}/`;
    const adapter=await BrowserAdapter.launch();
    const session=await JevSession.open({adapter,jev:{async choose(args){decisions++;return {selected_id:args.actions[0].id,confidence:1};},close(){}},directory:join(f.runtime,'session')});
    workflow=new BrowserWorkflow(session,{goalId:'integration',outputDirectory:join(f.runtime,'output')});
    await workflow.run({id:'nav',task:'Open fixture',method:'navigate',params:{url},verify:s=>s.title==='Workflow fixture'});
    await workflow.run({id:'fill',task:'Fill unlabeled named field',method:'fill',target:{name:'sample'},params:{value:'中文'},verify:s=>s.elements.some(e=>e.name==='sample'&&e.value==='中文')});
    await workflow.run({id:'radio',task:'Choose radio two',method:'click',target:{name:'same',value:'two'},verify:s=>s.elements.some(e=>e.name==='same'&&e.value==='two'&&e.checked)});
    const first=(await workflow.observe()).page_id;
    await workflow.run({id:'tab',task:'New tab',method:'newTab',params:{url},verify:s=>s.tabs.length===2});
    const second=(await workflow.observe()).page_id;
    await workflow.run({id:'switch',task:'Switch tab',method:'switchTab',params:{tabId:first},verify:s=>s.page_id===first});
    await workflow.run({id:'switch-back',task:'Switch back',method:'switchTab',params:{tabId:second},verify:s=>s.page_id===second});
    await workflow.scrollUntil({id:'scroll',task:'Reveal file link in main',visible:s=>s.elements.some(e=>e.label==='Get file'),delta:650});
    const spec={id:'download',task:'Download file once',method:'click',label:'Get file',verify:()=>adapter.downloads.some(d=>d.status==='SAVED')};
    await workflow.run(spec);await workflow.run(spec);
    assert.equal(downloads,1);assert.equal(workflow.actions.at(-1).result.cached,true);
    assert.equal(decisions,workflow.requests.length);
    assert.equal(adapter.downloads[0].bytes,20);
    assert.ok(workflow.actions[0].result.timings.execute_ms>=0);
    await workflow.run({id:'below',task:'Open below-fold main fixture',method:'navigate',params:{url:url+'below'},verify:s=>s.title==='Workflow fixture'});
    assert.equal((await workflow.observe()).elements.some(e=>e.name==='sample'),false);
    await workflow.scrollUntil({id:'below-scroll',task:'Reveal below-fold main',visible:s=>s.elements.some(e=>e.name==='sample'),delta:550});
    // Invalid target and dangerous navigation cannot dispatch or reserve Jev use.
    const before=decisions;
    const state=await workflow.observe();
    assert.throws(()=>adapter.guard(browserCandidate(state,{id:'bad',description:'bad',method:'navigate',params:{url:'javascript:alert(1)'}}),state),/INVALID_BROWSER_URL/);
    assert.equal(decisions,before);
  }finally{await workflow?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.cleanup();}
});
