#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<24||major===24&&minor<19)throw Error('Node 24.19 or newer is required.');
const args=process.argv.slice(2).filter(arg=>arg!=='--print-config');
const noBuild=args.includes('--no-build');if(noBuild)args.splice(args.indexOf('--no-build'),1);
const compiler=join(root,'node_modules','typescript','bin','tsc');
const backend=join(root,'node_modules','@playwright','mcp','cli.js');
if(!existsSync(compiler)||!existsSync(backend))throw Error('Dependencies are missing. Run npm ci --ignore-scripts in '+root+' and rerun this setup.');
if(!noBuild)execFileSync(process.execPath,[compiler,'--project',join(root,'tsconfig.json')],{cwd:root,stdio:'inherit'});
const entry=join(root,'dist','src','local','main.js');
if(!existsSync(entry))throw Error('Build is missing. Rerun without --no-build.');
const {parseLocalOptions}=await import(pathToFileURL(entry).href);
const options=parseLocalOptions(args);
if(options.help){process.stdout.write('Usage: node scripts/setup-local-browser.mjs [--print-config] [--no-build] [--mode launch|attach|extension] [--browser chrome|msedge|chromium] [--cdp-endpoint LOCAL_ENDPOINT] [--state-dir ABSOLUTE_PATH]\nChecks Node, installed npm dependencies and TypeScript build, then prints actual local stdio MCP configuration. No browser or paid Jev action is started. Configure your AI client using this JSON; unknown client settings are never edited automatically.\n');process.exit(0);}
const browser=options.browser;
const serverArgs=[entry,'--mode',browser.mode,'--browser',browser.browser,'--state-dir',browser.stateDir];
if(browser.endpoint)serverArgs.push('--cdp-endpoint',browser.endpoint);
if(browser.executablePath)serverArgs.push('--executable-path',browser.executablePath);
if(browser.headless)serverArgs.push('--headless');
if(options.endpoint)serverArgs.push('--jev-endpoint',options.endpoint);
process.stdout.write(JSON.stringify({mcpServers:{'jev-local-browser':{command:process.execPath,args:serverArgs}}},null,2)+'\n');
