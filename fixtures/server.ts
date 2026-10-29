import {createServer,type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
export class FixtureServer {
 private constructor(private server:Server,readonly origin:string){}
 static async start(options:{redirectTarget?:string}={}):Promise<FixtureServer>{
  const html=await readFile(new URL('../../fixtures/page.html',import.meta.url),'utf8').catch(()=>readFile(new URL('./page.html',import.meta.url),'utf8'));
  const server=createServer((req,res)=>{
   if(req.headers.host!==`127.0.0.1:${(server.address() as {port:number}).port}`){res.writeHead(403).end();return;}
   if(req.url==='/redirect'){res.writeHead(302,{location:options.redirectTarget??'https://external.invalid/redirect'}).end();return;}
   if(req.method!=='GET'){res.writeHead(405).end();return;}
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"});res.end(html);
  });await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return new FixtureServer(server,`http://127.0.0.1:${(server.address() as {port:number}).port}`);
 }
 async close(){await new Promise<void>((resolve,reject)=>this.server.close(e=>e?reject(e):resolve()));}
}
