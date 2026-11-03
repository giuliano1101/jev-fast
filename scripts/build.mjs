import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Remove retired products and stale tests, while preserving the separately built native binary.
for(const directory of ['src','tests','bench','fixtures'])rmSync('dist/'+directory,{recursive:true,force:true});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc'],{stdio:'inherit'});
mkdirSync('dist/native',{recursive:true});
if(existsSync('native/desktop-windows.ps1'))copyFileSync('native/desktop-windows.ps1','dist/native/desktop-windows.ps1');
let metadata={revision:'unknown',provenance:'unversioned',dirty:true,sourceDigest:null};
try{
 const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
 const files=git(['ls-files','--cached','--others','--exclude-standard','--','src','native','fixtures','scripts','package.json','package-lock.json','tsconfig.json']).split('\n').filter(file=>file&&existsSync(file)).sort();
 const hash=createHash('sha256');for(const file of new Set(files)){hash.update(file+'\0');hash.update(readFileSync(file));hash.update('\0');}
 metadata={revision:git(['rev-parse','HEAD']),provenance:'git-checkout',dirty:git(['status','--porcelain']).length>0,sourceDigest:'sha256:'+hash.digest('hex')};
}catch{/* An exported source archive can build without a Git checkout. */}
writeFileSync('dist/build-metadata.json',JSON.stringify(metadata,null,2)+'\n');
