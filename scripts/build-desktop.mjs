import {execFileSync} from 'node:child_process';
import {mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
mkdirSync('dist/native',{recursive:true});
if(process.platform==='darwin'){
 const cache=join(tmpdir(),'jev-native-swift-cache');mkdirSync(cache,{recursive:true,mode:0o700});
 execFileSync('/usr/bin/swiftc',['-parse-as-library','-swift-version','5','-O','-module-cache-path',cache,'native/desktop-macos.swift','-o','dist/native/jev-desktop-macos'],{stdio:'inherit'});
}else if(process.platform==='win32')copyFileSync('native/desktop-windows.ps1','dist/native/desktop-windows.ps1');
else throw new Error('DESKTOP_PLATFORM_UNSUPPORTED');
process.stdout.write('Native desktop backend built.\n');
