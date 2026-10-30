import {readFileSync} from 'node:fs';
import {z} from 'zod';
const schema=z.strictObject({revision:z.string().regex(/^(unknown|[a-f0-9]{40})$/),provenance:z.enum(['git-checkout','unversioned']),dirty:z.boolean(),sourceDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable()});
/** Build identity is evidence, not a signature or an authorization decision. */
function readBuild(){try{return schema.parse(JSON.parse(readFileSync(new URL('../../build-metadata.json',import.meta.url),'utf8')));}catch{return {revision:'unknown',provenance:'not-embedded',dirty:true,sourceDigest:null};}}
export const buildMetadata=readBuild();
