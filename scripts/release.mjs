import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const {positionals,values}=parseArgs({options:{out:{type:'string'},manifest:{type:'string'}},strict:true,allowPositionals:true});
 if(positionals.length!==1)throw Error('Usage: release pack --out DIR | release verify --manifest FILE');
 if(positionals[0]==='pack'&&values.out&&!values.manifest){
  const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
  if(git(['status','--porcelain']))throw Error('Commit and verify the intended source before packaging. Working tree must be clean.');
  const revision=git(['rev-parse','HEAD']),dir=resolve(values.out);mkdirSync(dir,{recursive:true,mode:0o700});
  const name=`jev-fast-${revision}.tar.gz`,path=join(dir,name);
  const bytes=execFileSync('git',['archive','--format=tar.gz','--prefix=jev-fast/','HEAD'],{maxBuffer:64*1024*1024});writeFileSync(path,bytes,{flag:'wx',mode:0o600});
  const manifest={format:'jev-source-release-v1',revision,file:name,bytes:bytes.length,sha256:hash(bytes),publicTools:'p0-six-tools',decision:'decision-v1',localLedger:2,gatewayStorage:1,policy:'p0-v1',adapter:'fixture-v1',authentication:'checksum-only-not-publisher-signature'};
  const manifestFile=join(dir,'manifest.json');writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});process.stdout.write(JSON.stringify({archive:path,manifest:manifestFile})+'\n');
 }else if(positionals[0]==='verify'&&values.manifest&&!values.out){
  const path=resolve(values.manifest),m=JSON.parse(readFileSync(path,'utf8'));
  if(m.format!=='jev-source-release-v1'||typeof m.file!=='string'||basename(m.file)!==m.file||!/^jev-fast-[a-f0-9]{40}\.tar\.gz$/.test(m.file)||!Number.isSafeInteger(m.bytes)||!/^[a-f0-9]{64}$/.test(m.sha256))throw Error('Invalid release manifest');
  const bytes=readFileSync(join(resolve(path,'..'),m.file));if(bytes.length!==m.bytes||hash(bytes)!==m.sha256)throw Error('Release checksum mismatch');process.stdout.write(JSON.stringify({verified:true,revision:m.revision,authentication:'checksum-only-not-publisher-signature'})+'\n');
 }else throw Error('Usage: release pack --out DIR | release verify --manifest FILE');
}catch(error){process.stderr.write((error instanceof Error?error.message:'Release operation failed')+'\n');process.exitCode=1;}
