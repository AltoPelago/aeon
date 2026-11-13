// Read-only package payload audit; no publishing/install or lifecycle scripts.
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const here=fileURLToPath(new URL('.',import.meta.url));
const aeon=resolve(here,'../..'),sansa=resolve(aeon,'../../sansa/reference-path-only');
const parser=resolve(aeon,'implementations/typescript/packages/parser');
const privateDependency=realpathSync(resolve(parser,'node_modules/@altopelago/sansa'));
assert.ok(privateDependency.startsWith(resolve(aeon,'implementations/typescript/node_modules')+'/'));
const manifest=JSON.parse(readFileSync(resolve(sansa,'package.json'))),installed=JSON.parse(readFileSync(resolve(privateDependency,'package.json')));
assert.deepEqual(installed.exports,manifest.exports);assert.deepEqual(installed.imports,manifest.imports);
const sha=b=>createHash('sha256').update(b).digest('hex');const dependencyFiles={};
function verify(dir){for(const f of readdirSync(resolve(sansa,dir),{withFileTypes:true})){const name=dir+'/'+f.name;if(f.isDirectory())verify(name);else{const h=sha(readFileSync(resolve(sansa,name)));assert.equal(sha(readFileSync(resolve(privateDependency,name))),h,name);dependencyFiles[name]=h;}}}verify('src');
function targets(value){if(typeof value==='string')return [value];return Object.values(value??{}).flatMap(targets);}
const packages=[];
for(const cwd of [sansa,...['lexer','parser','aes','core','canonical','finalize','annotation-stream'].map(p=>resolve(aeon,'implementations/typescript/packages',p))]){
 const result=JSON.parse(execFileSync('npm',['pack','--dry-run','--json','--ignore-scripts','--offline','--cache','/private/tmp/reference-path-only-npm-cache'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0];
 const data=JSON.parse(readFileSync(resolve(cwd,'package.json'))),files=new Set(result.files.map(f=>f.path));
 for(const target of [...targets(data.exports),...targets(data.imports)].filter(x=>x.startsWith('./')))assert.ok(files.has(target.slice(2)),`${data.name}: missing ${target}`);
 packages.push({name:data.name,version:data.version,packedFiles:result.files.length,exportTargetsPresent:true,relativePrivateImportTargetsPresent:true,filename:result.filename,bytes:result.size});
 writeFileSync(resolve(here,`.results/path-only-pack-${data.name.split('/').at(-1)}.json`),JSON.stringify(result,null,2)+'\n');
}
const report={date:'2026-10-19',status:'pass',mode:'npm pack --dry-run --ignore-scripts --offline; no tarball/install/publication',packages,privateDependency:relative(aeon,privateDependency),dependencyFiles,manifestExportsAndImportsMatch:true,releaseLimitations:['private dependency copy is not clean released-package installation proof','coordinated SANSA version/dependency/release is required before shipping','only Node 24.16.0 executed; broader Node/browser/native claims require their own evidence']};
writeFileSync(resolve(here,'package-audit.results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,packages:packages.length,privateSourceFiles:Object.keys(dependencyFiles).length}));
