import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {EventEmitter} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {createPlaygroundServer, playgroundModules, watchWorkspace, defaultRoot} from '../scripts/playground.mjs';
import {mountParserLimits} from '../tools/playground/parser-limits.mjs';
import {mountProfileControls} from '../tools/playground/profile-controls.mjs';
import {composerUnsupportedReason, COMPOSER_MAX_SOURCE_CODE_UNITS} from '../tools/playground/composer-policy.mjs';

function mockSessionStorage(t) {
  const storage = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true, value: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage);
    else delete globalThis.sessionStorage;
  });
  return storage;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aeon-playground-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const put = async (path, value) => { const target=join(root,path); await mkdir(join(target,'..'),{recursive:true}); await writeFile(target,value); };
  for (const [dir,name] of [['runtime','@altopelago/aeon-runtime'], ['profiles','@altopelago/aeon-profiles'], ['canonical','@altopelago/aeon-canonical'], ['parser','@altopelago/aeon-parser'], ['highlight','@altopelago/aeon-highlight']]) {
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
  assert.equal(map.imports['@aeon/profiles'],'/aeon/profiles/dist/index.js');
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
  const {root}=await fixture(t);let starts=0,active=0,peak=0,release;
  const finish=new Promise(resolve=>release=resolve),errors=[];
  const changes=new Map();
  const createWatcher=(path,options,listener)=>{const event=new EventEmitter();event.close=()=>event.removeAllListeners();changes.set(path,listener??options);return event;};
  const close=watchWorkspace(root,async()=>{starts++;peak=Math.max(peak,++active);if(starts===1)await finish;active--;},e=>errors.push(e),createWatcher);t.after(close);
  const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'watch deadline');await new Promise(r=>setTimeout(r,30));}};
  const changed=changes.get(join(root,'implementations/typescript/packages/runtime/src'));
  changed('change','index.ts');await until(()=>starts===1);
  changed('change','index.ts');await new Promise(r=>setTimeout(r,400));assert.equal(starts,1);
  release();await until(()=>starts>=2 && active===0);assert.equal(peak,1);assert.deepEqual(errors,[]);
});
test('real workspace examples compile and retain local identities, references and empty keys',async()=>{
  const {runRuntime}=await import('../implementations/typescript/packages/runtime/dist/index.js');
  const {canonicalize}=await import('../implementations/typescript/packages/canonical/dist/index.js');
  const {readAeonNamespace}=await import('../implementations/typescript/packages/sdk/dist/sansa.js');
  const modules=playgroundModules();assert.equal(modules.imports['@altopelago/aeon-sdk/sansa'],'/aeon/sdk/dist/sansa.js');
  assert.equal(modules.imports['@aeon/lexer'],'/aeon/lexer/dist/index.js');
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
test('composer bounds its new lexical preflight before token allocation',()=>{
  for(const width of [COMPOSER_MAX_SOURCE_CODE_UNITS+1,COMPOSER_MAX_SOURCE_CODE_UNITS+1024]) {
    let reads=0;assert.match(composerUnsupportedReason('x'.repeat(width),()=>{reads++;throw Error('should not tokenize');}),/too large/);assert.equal(reads,0);
  }
});

test('loads an executable profile and keeps it available when switching profiles or rejecting a replacement', async t => {
  const {createProfile, loadProfileContract} = await import('../implementations/typescript/packages/profiles/dist/index.js');
  const {runRuntime} = await import('../implementations/typescript/packages/runtime/dist/index.js');
  const artifact = `
profile_id = "playground.test.v1"
profile_version = "1.0.0"
core_id = "aeon.core.v1"
mode_default = "strict"
datatype_policy_default = "reserved_only"
datatype_semantics = {
  symbol = { literal_family = "SymbolicLiteral", clarifiers = "separator_chars" }
}
generic_admission = {
  reserved_datatypes = ["symbol"]
  custom_labels = false
  custom_value_kinds = []
  node_head_datatypes = []
  binding_node_reserved_arguments = []
}
collections = {}
containers = {}
capabilities = { references = true, clones = true }
`;
  const storage = mockSessionStorage(t);

  const createControls = () => {
    const select = Object.assign(new EventTarget(), {value: 'aeon.gp.profile.v1'});
    const option = {value: 'loaded-profile', hidden: true, disabled: true};
    const button = new EventTarget();
    const input = new EventTarget();
    const clear = new EventTarget();
    const status = {classList: {toggle() {}}};
    const elements = {
      '[data-playground-profile]': select,
      '[data-loaded-profile-option]': option,
      '[data-load-profile]': button,
      '[data-profile-file]': input,
      '[data-remove-profile]': clear,
      '[data-profile-status]': status,
    };
    const profiles = mountProfileControls({querySelector: selector => elements[selector]}, {
      loadContract: source => createProfile(loadProfileContract(source)),
      onChange() {},
    });
    const choose = async (name, text) => {
      input.files = [{name, size: Buffer.byteLength(text), text: async () => text}];
      input.dispatchEvent(new Event('change'));
      await setImmediate();
    };
    return {profiles, choose, select, option, status, clear};
  };

  const controls = createControls();
  await controls.choose('duration.aeon', artifact);
  const loaded = controls.profiles.selectedProfile();
  assert.equal(loaded.id, 'playground.test.v1');
  assert.equal(controls.option.disabled, false);
  assert.match(controls.option.textContent, /playground\.test\.v1.*1\.0\.0/);
  assert.equal(controls.status.textContent, 'Loaded duration.aeon.');

  const document = 'duration:symbol<time>["minutes"] = |1min|';
  for (const [selection, expected] of [
    ['aeon.gp.profile.v1', ['PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED']],
    ['set.to.eleven.v1', []],
    ['loaded-profile', []],
  ]) {
    controls.select.value = selection;
    const result = runRuntime(document, {
      profile: controls.profiles.selectedProfile(), effectiveMode: 'strict', output: 'map',
    });
    assert.deepEqual(result.meta.errors.map(({code}) => code), expected);
  }
  assert.equal(controls.profiles.selectedProfile(), loaded);
  await controls.choose('invalid.aeon', 'profile_id = "broken"');
  assert.match(controls.status.textContent, /Invalid AEON profile contract/);
  assert.equal(controls.profiles.selectedProfile(), loaded);

  const reloaded = createControls();
  await reloaded.profiles.restore();
  reloaded.select.value = 'loaded-profile';
  assert.equal(reloaded.profiles.selectedProfile().id, loaded.id);
  reloaded.clear.dispatchEvent(new Event('click'));
  assert.equal(reloaded.profiles.selectedProfile(), 'aeon.gp.profile.v1');
  assert.equal(reloaded.option.disabled, true);
  assert.equal(storage.size, 0);
});

test('parser limit settings restore valid tab values, reject invalid edits and reset to defaults', t => {
  const storage = mockSessionStorage(t);
  storage.set('aeon:playground-parser-limits', JSON.stringify({
    maxGenericDepth: 3, maxClarifierValues: 99999, maxValueNestingDepth: '2',
  }));
  const input = (name, defaultValue, max) => ({
    name, defaultValue, min: '0', max, value: defaultValue,
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
  });
  const depth = input('maxGenericDepth', '1', '64');
  const clarifiers = input('maxClarifierValues', '1', '4096');
  const values = input('maxValueNestingDepth', '256', '512');
  const form = Object.assign(new EventTarget(), {
    querySelectorAll: () => [depth, clarifiers, values],
    checkValidity: () => [depth, clarifiers, values].every(field =>
      Number.isSafeInteger(field.valueAsNumber) && field.valueAsNumber >= 0 && field.valueAsNumber <= Number(field.max)),
  });
  let changes = 0;
  const settings = mountParserLimits(form, () => { changes++; });
  assert.deepEqual(settings.options, {maxGenericDepth: 3});
  assert.equal(clarifiers.value, '1');
  assert.equal(values.value, '256');
  depth.value = '1.5';
  form.dispatchEvent(new Event('input'));
  assert.equal(settings.options.maxGenericDepth, 3);
  assert.equal(changes, 0);
  depth.value = '0';
  form.dispatchEvent(new Event('input'));
  assert.equal(settings.options.maxGenericDepth, 0);
  assert.deepEqual(JSON.parse(storage.get('aeon:playground-parser-limits')), settings.options);
  form.dispatchEvent(new Event('reset', {cancelable: true}));
  assert.deepEqual(settings.options, {});
  assert.equal(depth.value, '1');
  assert.equal(changes, 2);
});

test('all six parser limits are honored by runtime and Canonical', async () => {
  const {runRuntime, runTypedRuntime} = await import('../implementations/typescript/packages/runtime/dist/index.js');
  const {canonicalize} = await import('../implementations/typescript/packages/canonical/dist/index.js');
  const cases = [
    ['maxGenericDepth', 'a:a<b<c<d[3]>[3]>[3]>[3] = |yes|', 'GENERIC_DEPTH_EXCEEDED'],
    ['maxGenericArguments', 'x:tuple<n, n> = (1, 2)', 'GENERIC_ARGUMENTS_EXCEEDED'],
    ['maxClarifierValues', 'x:sep[".", "-"] = ^a.b-c', 'CLARIFIER_VALUES_EXCEEDED'],
    ['maxDatatypeComponents', 'x:list<n> = [1]', 'DATATYPE_COMPONENTS_EXCEEDED'],
    ['maxAttributeDepth', 'x@{m@{nested = 2} = 1} = 0', 'ATTRIBUTE_DEPTH_EXCEEDED'],
    ['maxValueNestingDepth', 'x = [[1]]', 'NESTING_DEPTH_EXCEEDED'],
  ];
  for (const [option, source, code] of cases) {
    const output = limit => runRuntime(source, {
      [option]: limit, profile: 'set.to.eleven.v1', effectiveMode: 'transport',
      includeAnnotations: true, output: 'map',
    });
    assert.equal(output(1).meta.errors[0]?.code, code, option);
    assert.equal(canonicalize(source, {[option]: 1}).errors[0]?.code, code, option);
    assert.deepEqual(output(2).meta.errors, [], option);
    assert.deepEqual(canonicalize(source, {[option]: 2}).errors, [], option);
  }
  const typed = runTypedRuntime('x = [[1]]', {schema: {rules: []}, maxValueNestingDepth: 1});
  assert.equal(typed.meta.errors[0]?.code, 'NESTING_DEPTH_EXCEEDED');
});
