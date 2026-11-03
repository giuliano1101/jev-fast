import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
test('build removes obsolete executable products from an existing output directory',()=>{
 for(const file of ['src/cli/index.js','src/mcp/index.js','src/network/main.js','src/mac-public/main.js','src/local/main.js','src/desktop/main.js'])assert.equal(existsSync(resolve('dist',file)),false,file);
});
