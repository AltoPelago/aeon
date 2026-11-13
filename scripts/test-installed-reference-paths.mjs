#!/usr/bin/env node
// Pack actual artifacts and exercise a clean offline consumer. No publication.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const sansa=arg('--sansa')??realpathSync(resolve(root,'implementations/typescript/packages/parser/node_modules/@altopelago/sansa'));
const reportPath=arg('--report');
const runRoot=mkdtempSync(join(tmpdir(),'aeon-installed-reference-paths-'));
const artifacts=join(runRoot,'artifacts'),consumer=join(runRoot,'consumer');mkdirSync(artifacts);mkdirSync(consumer);
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_PATH:'',NPM_CONFIG_IGNORE_SCRIPTS:'true'}});
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const packages=[];
for(const dir of [sansa,...['lexer','parser','aes','annotation-stream','core','canonical','finalize'].map(p=>resolve(root,'implementations/typescript/packages',p))]){
 const pkg=read(join(dir,'package.json'));
 if(dir===sansa)run('npm',['pack','--json','--ignore-scripts','--offline','--cache',join(runRoot,'cache'),'--pack-destination',artifacts],dir);
 else run('pnpm',['--dir',dir,'pack','--pack-destination',artifacts],root);
 const tarball=join(artifacts,`${pkg.name.replace('@','').replace('/','-')}-${pkg.version}.tgz`);
 const packed=JSON.parse(run('tar',['-xOf',tarball,'package/package.json'],root));
 assert.equal(packed.version,pkg.version);
 for(const value of Object.values(packed.dependencies??{}))assert.ok(!/^(workspace:|file:|link:)/.test(value));
 packages.push({name:pkg.name,version:pkg.version,tarball,integrity:'sha512-'+createHash('sha512').update(readFileSync(tarball)).digest('base64'),dependencies:packed.dependencies??{}});
}
const parser=packages.find(p=>p.name==='@altopelago/aeon-parser');assert.equal(parser.dependencies['@altopelago/sansa'],packages[0].version);
writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'aeon-installed-reference-consumer',version:'1.0.0',private:true,type:'module',dependencies:Object.fromEntries(packages.map(p=>[p.name,pathToFileURL(p.tarball).href]))},null,2));
run('npm',['install','--offline','--ignore-scripts','--no-audit','--fund=false','--cache',join(runRoot,'cache')],consumer);
writeFileSync(join(consumer,'vectors.json'),readFileSync(join(root,'test-fixtures/reference-structural-paths.json')));
const smoke=String.raw`
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {realpathSync,readFileSync} from 'node:fs';
import * as parser from '@altopelago/aeon-parser';
import {compile} from '@altopelago/aeon-core';
import {canonicalize} from '@altopelago/aeon-canonical';
import {projectPortableEvents,validateReferences} from '@altopelago/aeon-aes';
import {validatePositionIndex} from '@altopelago/sansa/parsing/selector-cursor';
for(const name of ['@altopelago/sansa','@altopelago/aeon-parser','@altopelago/aeon-core','@altopelago/aeon-canonical'])assert.ok(realpathSync(fileURLToPath(import.meta.resolve(name))).startsWith(process.cwd()+'/node_modules/'));
assert.equal(validatePositionIndex('999999',undefined,()=>{throw new Error()}),999999);
for(const name of ['createReferenceEngine','openReferenceSession','parseWithReferenceSession','createReferenceReplayCodec'])assert.equal(name in parser,false);
for(const raw of ['1.5','1e2','-0','+1','00','01','1_0','0x10','1000000','9007199254740993']){
 const result=compile('copy=~items['+raw+']');assert.equal(result.events.length,0);assert.ok(result.errors.length);
}
for(const path of ["$.a.*", "$.a.**", "$.a.^", "$.a[0..2]", "?.a", "$.\\A\\"])assert.ok(compile('copy=~'+path).errors.length);
for(const source of ['z={name="world"}\ncopy=~>z.name','z=["a","b"]\ncopy=~z[1]','z@{unit="cm"}=1\ncopy=~z.@.unit','aeon:header={x={leaf=1}}\n"aeon:x"=2\ncopy=~>["aeon:x"].leaf']){
 const opts={maxAttributeDepth:8},before=compile(source,opts),canon=canonicalize(source,opts);assert.deepEqual(before.errors,[]);assert.deepEqual(canon.errors,[]);
 const after=compile(canon.text,opts);assert.deepEqual(after.errors,[]);assert.deepEqual(canonicalize(canon.text,opts),canon);
 const ref=r=>r.events.find(e=>e.key==='copy').value;
 assert.deepEqual(ref(after).path,ref(before).path);assert.equal('selection' in ref(after),false);
 const portable=r=>projectPortableEvents(r.events).find(e=>e.path==='$.copy').value;
 assert.deepEqual(portable(after),portable(before));
}
const good=compile('z=1\ncopy=~>z');assert.deepEqual(good.errors,[]);
for(const selection of [null,false,0,'',{}]){
 const events=good.events.map(e=>e.key==='copy'?{...e,value:{...e.value,selection}}:e);
 assert.equal(validateReferences(events,{recovery:true}).events.length,0);
 assert.throws(()=>projectPortableEvents(events),e=>e.code==='AES_UNSUPPORTED_REFERENCE_SELECTION');
}
const vectors=JSON.parse(readFileSync('vectors.json','utf8'));
for(const vector of vectors.cases){
 const result=compile(vector.source,vectors.options);
 assert.equal(result.errors.length===0,vector.ok,vector.id);
 if(!vector.ok){assert.equal(result.events.length,0);assert.ok(result.errors.some(e=>e.code===vector.code),vector.id);continue;}
 const expected=vector.target.map(p=>typeof p==='object'?{type:'attr',key:p.attribute}:p);
 assert.deepEqual(result.events.find(e=>e.key==='copy').value.path,expected,vector.id);
 const canonical=canonicalize(vector.source,vectors.options);assert.deepEqual(canonical.errors,[],vector.id);
 const replay=compile(canonical.text,vectors.options);assert.deepEqual(replay.errors,[],vector.id);
 assert.deepEqual(replay.events.find(e=>e.key==='copy').value.path,expected,vector.id);
}
console.log(JSON.stringify({node:process.version,status:'pass',installedRoot:process.cwd()}));
`;
writeFileSync(join(consumer,'smoke.mjs'),smoke);
const runtime=JSON.parse(run(process.execPath,['smoke.mjs'],consumer));
writeFileSync(join(consumer,'consumer.ts'),`import {canonicalize} from '@altopelago/aeon-canonical';\nimport {parse,type ParserOptions} from '@altopelago/aeon-parser';\nimport {validatePositionIndex,parseDotSelectorFromCursor,type SansaSelectorCursor} from '@altopelago/sansa/parsing/selector-cursor';\nconst result=canonicalize('z=1\\nx=~z');\nconst options: ParserOptions={maxAttributeDepth:1};\n// @ts-expect-error Generic reference engines are not part of the structural contract.\nconst rejected: ParserOptions={referenceEngine:{}};\nconst index: number=validatePositionIndex('0',undefined,()=>{throw Error()});\nvoid result;void options;void rejected;void index;void parse;void parseDotSelectorFromCursor;\n`);
writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,module:'NodeNext',target:'ES2022',types:[],skipLibCheck:false},files:['consumer.ts']}));
run(process.execPath,[resolve(root,'implementations/typescript/node_modules/typescript/bin/tsc'),'-p',join(consumer,'tsconfig.json')],consumer);
const report={status:'pass',node:process.version,runtime,typedConsumer:'pass',offlineInstall:true,lifecycleScripts:false,publication:false,runRoot,packages};
if(reportPath)writeFileSync(resolve(reportPath),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,node:report.node,packages:packages.length,typedConsumer:report.typedConsumer,runRoot}));
