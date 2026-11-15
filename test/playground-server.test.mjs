import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createPlaygroundServer, playgroundModules, watchWorkspace, defaultRoot} from '../scripts/playground.mjs';
import {composerUnsupportedReason} from '../tools/playground/composer-policy.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aeon-playground-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const put = async (path, value) => { const target=join(root,path); await mkdir(join(target,'..'),{recursive:true}); await writeFile(target,value); };
  for (const [dir,name] of [['runtime','@altopelago/aeon-runtime'], ['canonical','@altopelago/aeon-canonical'], ['parser','@altopelago/aeon-parser']]) {
    await put(`implementations/typescript/packages/${dir}/package.json`, JSON.stringify({name,exports:{'.':{import:'./dist/index.js'}}}));
    await put(`implementations/typescript/packages/${dir}/dist/index.js`, 'export const marker = "initial";');
    await put(`implementations/typescript/packages/${dir}/src/index.ts`, 'export const marker = "source";');
  }
  await put('implementations/typescript/packages/parser/node_modules/@altopelago/sansa/package.json', JSON.stringify({name:'@altopelago/sansa',exports:{'.':{import:'./src/index.js'}}}));
  await put('implementations/typescript/packages/parser/node_modules/@altopelago/sansa/src/index.js', 'export const selectedDependency = true;');
  await put('tools/playground/index.html','<script type="importmap">__PLAYGROUND_IMPORTS__</script><script>window.AeonPlaygroundExamples=__PLAYGROUND_EXAMPLES__;</script>');
  await put('tools/playground/examples.json',JSON.stringify({one:{source:'</script><script>untrusted</script>'}}));
  await put('tools/playground/local.js','// local UI');
  await put('secret.js','PRIVATE');
  return {root, put};
}
async function serve(t,root,buildState) {
  const server=createPlaygroundServer({repoRoot:root,buildState});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {url:`http://127.0.0.1:${server.address().port}`,port:server.address().port};
}
function raw(port,path,headers={}) {
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path,headers},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});
    req.on('error',reject);req.end();
  });
}
test('serves the chosen workspace/dependency and fresh bytes with no caching',async t=>{
  const {root,put}=await fixture(t),{url}=await serve(t,root);
  const html=await (await fetch(url)).text();
  assert.ok(!html.includes('__PLAYGROUND_IMPORTS__'));
  const map=JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/)[1]);
  assert.equal(map.imports['@aeon/runtime'],'/aeon/runtime/dist/index.js');
  assert.ok(!html.includes('__PLAYGROUND_EXAMPLES__'));
  assert.ok(!html.includes('</script><script>untrusted'));
  assert.ok(html.includes('\\u003c/script>'));
  const path='/aeon/runtime/dist/index.js';
  const response=await fetch(url+path);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-type'),'text/javascript; charset=utf-8');
  assert.match(await response.text(),/initial/);
  await put('implementations/typescript/packages/runtime/dist/index.js','export const marker = "edited";');
  assert.match(await (await fetch(url+path)).text(),/edited/);
  assert.match(await (await fetch(url+'/sansa/src/index.js')).text(),/selectedDependency/);
  assert.match(await (await fetch(url+'/aeon/runtime/src/index.ts')).text(),/source/);
  assert.equal((await fetch(url,{method:'HEAD'})).status,200);assert.equal(await (await fetch(url,{method:'HEAD'})).text(),'');
});
test('rejects traversal, symlink escapes, nonlocal hosts and nonread methods',async t=>{
  const {root}=await fixture(t),{url,port}=await serve(t,root);
  await symlink(join(root,'secret.js'),join(root,'tools/playground/escape.js'));
  assert.equal((await fetch(url+'/tools/playground/escape.js')).status,403);
  assert.equal((await raw(port,'/tools/playground/..%2f..%2fsecret.js')).status,403);
  assert.equal((await raw(port,'/aeon/runtime/dist/..%2f..%2f..%2f..%2f..%2fsecret.js')).status,403);
  assert.equal((await raw(port,'/aeon/runtime/dist/index.js',{Host:'attacker.invalid'})).status,403);
  assert.equal((await raw(port,'/%ZZ')).status,400);
  for(const path of ['/package.json','/.git/config','/aeon/runtime/package.json','/aeon/unknown/dist/index.js'])assert.equal((await fetch(url+path)).status,404);
  const post=await fetch(url,{method:'POST',body:'data'});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET, HEAD');
});
test('build state blocks partial module reads and reports stale-build failure',async t=>{
  const {root}=await fixture(t),state={revision:1,building:true,error:null}, {url}=await serve(t,root,state);
  assert.equal((await fetch(url+'/aeon/runtime/dist/index.js')).status,503);
  assert.equal((await fetch(url+'/tools/playground/local.js')).status,200);
  state.building=false;state.error='build failed';
  assert.deepEqual(await (await fetch(url+'/__playground/status')).json(),state);
  assert.equal((await fetch(url+'/aeon/runtime/dist/index.js')).status,200);
});
test('source watch serializes rebuilds and retains edits arriving during a build',async t=>{
  const {root,put}=await fixture(t);let starts=0,active=0,peak=0,release;
  const finish=new Promise(resolve=>release=resolve),errors=[];
  const close=watchWorkspace(root,async()=>{starts++;peak=Math.max(peak,++active);if(starts===1)await finish;active--;},e=>errors.push(e));t.after(close);
  const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'watch deadline');await new Promise(r=>setTimeout(r,30));}};
  await put('implementations/typescript/packages/runtime/src/index.ts','// edit one');await until(()=>starts===1);
  await put('implementations/typescript/packages/runtime/src/index.ts','// edit two');await new Promise(r=>setTimeout(r,400));assert.equal(starts,1);
  release();await until(()=>starts>=2 && active===0);assert.equal(peak,1);assert.deepEqual(errors,[]);
});
test('real workspace examples compile and retain local identities, references and empty keys',async()=>{
  const {runRuntime}=await import('../implementations/typescript/packages/runtime/dist/index.js');
  const {canonicalize}=await import('../implementations/typescript/packages/canonical/dist/index.js');
  const {readAeonNamespace}=await import('../implementations/typescript/packages/sdk/dist/sansa.js');
  const modules=playgroundModules();assert.equal(modules.imports['@altopelago/aeon-sdk/sansa'],'/aeon/sdk/dist/sansa.js');
  const examples=JSON.parse(await readFile(join(defaultRoot,'tools/playground/examples.json'),'utf8'));
  for(const [id,example] of Object.entries(examples)){
    const result=runRuntime(example.source,{profile:'aeon.gp.profile.v1',mode:example.mode==='transport'?'loose':'strict',datatypePolicy:example.mode==='custom'?'allow_custom':'reserved_only',includeAnnotations:true,output:'json'});
    assert.deepEqual(result.meta.errors.filter(e=>e.phase!==8),[],id);
    const canonical=canonicalize(example.source);assert.deepEqual(canonical.errors,[],id);
  }
  const ns=readAeonNamespace(examples['empty-keys'].source).namespace;
  const {resolveAddress}=await import('../implementations/typescript/packages/parser/node_modules/@altopelago/sansa/src/index.js');
  const positional=resolveAddress('$.[""].[""]',ns),identity=resolveAddress('$.\\empty\\.[""]',ns);
  assert.equal(positional.ok,true);assert.equal(identity.ok,true);assert.equal(identity.bindings[0],positional.bindings[0]);
});
test('composer identifies unsupported reference/address forms without treating quoted punctuation as syntax',async()=>{
  const {tokenize}=await import('../implementations/typescript/packages/lexer/dist/index.js');
  for(const text of ['value=1\ncopy=~value','value=1\nlink=~>value','selector:sansa=$.items.\\id\\','value@{selector:sansa=$.[""]}=1']) {
    assert.match(composerUnsupportedReason(text,tokenize),/cannot yet preserve/);
  }
  for(const text of ['"~"="literal ~ $.items"','// ~> and $.items in a comment\nvalue=1','""\\id\\={""="İ😀"}','value="SANSA &tag(\\"name\\")"']) {
    assert.equal(composerUnsupportedReason(text,tokenize),undefined,text);
  }
  assert.match(composerUnsupportedReason('value="unfinished',tokenize),/Fix the source syntax/);
});
