import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';

/** A local acceptance workbench, never a live bank, tax portal, cloud stream or social account. */
export async function windowsWorkbench(){
 let committed=0,panelValue='idle',swapRequested=false,swapped:undefined|(()=>void);const nonce=randomUUID();
 const html=`<!doctype html><html><head><title>Windows Jev workbench</title></head><body>
 <h1>Windows Jev workbench</h1><label>Test name<input id="name"></label><label>Category<select id="category"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
 <button id="commit">Commit once</button><output id="result">Pending</output>
 <a href="/popup" target="_blank">Open popup</a><a href="/file.pdf" download="acceptance.pdf">Download PDF</a><a href="/file.zip" download="acceptance.zip">Download ZIP</a>
 <label>Upload file<input type="file" id="upload"></label><output id="uploaded"></output>
 <a href="/login">Remember test login</a><iframe title="Child frame" src="/child"></iframe>
 <canvas aria-label="Test canvas" width="200" height="100" style="border:1px solid"></canvas><output id="touches">Touches: 0</output>
 <script>const $=s=>document.querySelector(s);$('#commit').onclick=async()=>{const r=await fetch('/commit',{method:'POST'});$('#result').textContent='Committed '+(await r.json()).count+' '+$('#name').value+' '+$('#category').value};$('#upload').onchange=()=>$('#uploaded').textContent='Uploaded '+$('#upload').files[0].name;let touches=0;const c=$('canvas');c.getContext('2d').fillRect(10,10,40,40);c.onpointerdown=()=>$('#touches').textContent='Touches: '+(++touches);</script></body></html>`;
 const server=createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  if(req.url==='/dynamic'){res.end('<h1>Dynamic test</h1><output id="clock">0</output><script>let n=0;setInterval(()=>document.querySelector("#clock").textContent=++n,20)</script>');return;}
  if(req.url==='/replace'){res.end('<button id="same" onclick="fetch(\'/commit\',{method:\'POST\'})">Same control</button><script>let done=false;setInterval(async()=>{if(!done&&(await (await fetch("/swap-flag")).json()).swap){done=true;const b=document.querySelector("#same");b.outerHTML=b.outerHTML;await fetch("/swap-applied",{method:"POST"});}},20)</script>');return;}
  if(req.url==='/swap-flag'){res.setHeader('content-type','application/json');res.end(JSON.stringify({swap:swapRequested}));return;}
  if(req.url==='/swap-applied'){swapRequested=false;swapped?.();res.end('ok');return;}
  if(req.url==='/file.zip'){res.setHeader('content-type','application/zip');res.setHeader('content-disposition','attachment; filename="acceptance.zip"');res.end(Buffer.from('UEsDBBQAAAAAADWTYl0Q3eORGwAAABsAAAAOAAAAYWNjZXB0YW5jZS50eHRXaW5kb3dzIEpldiBaSVAgYWNjZXB0YW5jZQpQSwECFAAUAAAAAAA1k2JdEN3jkRsAAAAbAAAADgAAAAAAAAAAAAAAgAEAAAAAYWNjZXB0YW5jZS50eHRQSwUGAAAAAAEAAQA8AAAARwAAAAAA','base64'));return;}
  if(req.url==='/api/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({state:panelValue,receipt:'none'}));return;}
  if(req.url==='/api/action'&&req.method==='POST'){panelValue='ready';res.setHeader('content-type','application/json');res.end(JSON.stringify({receipt:'ack-'+nonce}));return;}
  if(req.url==='/commit'&&req.method==='POST'){committed++;res.setHeader('content-type','application/json');res.end(JSON.stringify({count:committed}));return;}
  if(req.url==='/login'){res.setHeader('set-cookie','test_login=retained; Max-Age=3600; Path=/; SameSite=Lax');res.end('<h1>Test login retained</h1>');return;}
  if(req.url==='/session'){res.end('<h1>'+((req.headers.cookie??'').includes('test_login=retained')?'Authenticated test session':'Anonymous test session')+'</h1>');return;}
  if(req.url==='/child'){res.end('<label>Frame name<input></label><button onclick="this.textContent=\'Frame done\'">Frame action</button>');return;}
  if(req.url==='/popup'){res.end('<h1>Independent popup ready</h1>');return;}
  if(req.url==='/file.pdf'){
   const objects=['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n','2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n','3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n'];
   let pdf='%PDF-1.4\n';const offsets=[0];for(const obj of objects){offsets.push(Buffer.byteLength(pdf));pdf+=obj;}const xref=Buffer.byteLength(pdf);pdf+='xref\n0 4\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
   res.setHeader('content-type','application/pdf');res.setHeader('content-disposition','attachment; filename="acceptance.pdf"');res.end(pdf);return;
  }
  res.setHeader('content-type','text/html; charset=utf-8');res.end(html);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const a=server.address();if(!a||typeof a==='string')throw Error('NO_WORKBENCH_PORT');
 return {url:'http://127.0.0.1:'+a.port,nonce,get committed(){return committed;},async replaceIdenticalControl(){await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error('SWAP_FIXTURE_TIMEOUT')),5000);swapped=()=>{clearTimeout(timer);done();};swapRequested=true;});},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
