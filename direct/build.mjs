import {execFileSync} from 'node:child_process';
import {mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const here = fileURLToPath(new URL('.', import.meta.url));
process.chdir(here);
rmSync('dist', {recursive: true, force: true});
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {stdio: 'inherit'});
mkdirSync('dist/native', {recursive: true});
if (process.platform === 'darwin') {
  const cache = join(tmpdir(), 'jev-direct-swift-cache');
  mkdirSync(cache, {recursive: true, mode: 0o700});
  execFileSync('/usr/bin/swiftc', ['-parse-as-library', '-swift-version', '5', '-O', '-module-cache-path', cache,
    '../native/desktop-macos.swift', '-o', 'dist/native/jev-desktop-macos'], {stdio: 'inherit'});
} else if (process.platform === 'win32') {
  copyFileSync('../native/desktop-windows.ps1', 'dist/native/desktop-windows.ps1');
}
const source = existsSync('../source-snapshot.json')?JSON.parse(readFileSync('../source-snapshot.json', 'utf8')):{repository:'giuliano1101/jev-fast',version:JSON.parse(readFileSync('package.json','utf8')).version};
writeFileSync('dist/provenance.json', JSON.stringify({source, mode: 'official-direct', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.14.0', built_at: new Date().toISOString()}, null, 2) + '\n');
execFileSync(process.execPath, ['--input-type=module', '-e', 'await import("./index.mjs")'], {stdio: 'inherit'});
