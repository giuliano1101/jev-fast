import {open,readFile,stat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,extname} from 'node:path';
import {Fault} from '../core/errors.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);

export async function authorizedPath(path:string,roots:string[]){
 const target=await realpath(resolve(path));
 for(const root of roots){const actual=await realpath(resolve(root));const child=relative(actual,target);if(child===''||(!child.startsWith('..')&&!isAbsolute(child)))return target;}
 throw new Fault('FILE_OUTSIDE_AUTHORIZED_ROOTS');
}
export async function inspectArtifact(path:string,roots:string[]){
 const actual=await authorizedPath(path,roots),info=await stat(actual);if(!info.isFile()||info.size===0)throw new Fault('EMPTY_OR_INVALID_ARTIFACT');
 const hash=createHash('sha256'),file=await open(actual,'r');
 try{for await(const chunk of file.createReadStream())hash.update(chunk);}finally{await file.close();}
 const extension=extname(actual).toLowerCase();let structure:'signature_checked'|'file_readable'='file_readable';
 if(extension==='.pdf'||extension==='.zip'){
  const bytes=await readFile(actual);
  if(extension==='.pdf'&&!(bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-2048).includes(Buffer.from('%%EOF'))))throw new Fault('INVALID_PDF_ARTIFACT');
  if(extension==='.zip'&&!(bytes.subarray(0,2).toString()==='PK'&&bytes.subarray(Math.max(0,bytes.length-65557)).includes(Buffer.from([0x50,0x4b,0x05,0x06]))))throw new Fault('INVALID_ZIP_ARTIFACT');
  structure='signature_checked';
 }
 let parser:Record<string,unknown>|undefined;
 if(extension==='.pdf'||extension==='.zip'){
  const script=fileURLToPath(new URL('../../../scripts/inspect-artifact.py',import.meta.url));
  try{const output=await run(process.platform==='win32'?'python.exe':'python3',[script,actual],{windowsHide:true,timeout:30000,env:{...process.env,PYTHONPATH:fileURLToPath(new URL('../../../.runtime/python-packages',import.meta.url))}});parser=JSON.parse(output.stdout) as Record<string,unknown>;}catch{parser={available:false,valid:false,code:'DOCUMENT_PARSER_UNAVAILABLE'};}
  if(parser.available&&parser.valid!==true)throw new Fault('INVALID_DOCUMENT_ARTIFACT');
 }
 const after=await stat(actual);if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw new Fault('ARTIFACT_CHANGED_DURING_READ');
 return {path:actual,bytes:info.size,sha256:hash.digest('hex'),readable:true,structure,full_document_validation:parser?.valid===true,parser};
}
