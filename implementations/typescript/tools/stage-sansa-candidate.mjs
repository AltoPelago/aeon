#!/usr/bin/env node
// Stage an explicitly supplied, reviewed archive; never fetch or publish it.
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha256='8f997d2a5478de49bbd4b0703f117f2bc50ec3b720e4f7fd3d8e5ecf1f127bd5';
const target=fileURLToPath(new URL('../.candidate-packages/altopelago-sansa-0.15.0-rc.1-query-8f997d2a.tgz',import.meta.url));
const args=process.argv.slice(2);
if(args.length>1)throw new Error('Usage: node tools/stage-sansa-candidate.mjs [reviewed-archive.tgz]');
function verify(path) {
 if(!existsSync(path))throw new Error(`Missing candidate archive: ${path}. Supply the reviewed archive as the sole argument.`);
 const actual=createHash('sha256').update(readFileSync(path)).digest('hex');
 if(actual!==sha256)throw new Error(`SANSA candidate checksum mismatch: ${path}`);
}
const source=args.length?resolve(args[0]):target;
verify(source);
if(source!==target) {
 if(existsSync(target))verify(target);
 else copyFileSync(source,target);
}
verify(target);
console.log(JSON.stringify({status:'verified',archive:target,sha256,publication:false}));
