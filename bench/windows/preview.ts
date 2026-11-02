import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {extname,resolve,relative,isAbsolute} from 'node:path';
import {Fault} from '../../src/core/errors.js';
/** Isolated local build preview. No backend proxies or writes to production leaderboards. */
export async function readonlyPreview(root:string){
 const base=await realpath(resolve(root));if(!(await stat(base)).isDirectory())throw new Fault('INVALID_PREVIEW_ROOT');
 const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.wav':'audio/wav','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
 const server=createServer((req,res)=>{void(async()=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  const name=decodeURIComponent(new URL(req.url??'/','http://127.0.0.1').pathname);if(name.startsWith('/api/')){res.writeHead(404).end();return;}
  const file=await realpath(resolve(base,'.'+(name==='/'?'/index.html':name))),child=relative(base,file);
  if(child.startsWith('..')||isAbsolute(child)){res.writeHead(403).end();return;}
  const bytes=await readFile(file);res.setHeader('content-type',types[extname(file)]??'application/octet-stream');res.setHeader('cache-control','no-store');res.end(req.method==='HEAD'?undefined:bytes);
 })().catch(()=>{res.writeHead(404).end();});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Fault('PREVIEW_UNAVAILABLE');
 return {url:'http://127.0.0.1:'+address.port,async close(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
}
