import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {runRuntime} from '../implementations/typescript/packages/runtime/dist/index.js';
import {canonicalize} from '../implementations/typescript/packages/canonical/dist/index.js';
import {tokenize} from '../implementations/typescript/packages/lexer/dist/index.js';
import {formatClarifierValue} from '../implementations/typescript/packages/parser/dist/index.js';
import * as sansa from '../implementations/typescript/packages/parser/node_modules/@altopelago/sansa/src/index.js';
import {composerUnsupportedReason} from '../tools/playground/composer-policy.mjs';
import {createComposerPaths} from '../tools/playground/composer-paths.mjs';

const composerCode = readFileSync(new URL('../tools/playground/aeon-source-composer.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
// Only HTML form controls are decoded here; AEON is always handled by its runtime.
class DetailFormData {
  constructor(detail) { this.detail = detail; }
  get(key) {
    if (this.detail.edits.has(key)) return this.detail.edits.get(key);
    const fields = this.detail.innerHTML.matchAll(/<input\b[^>]*>|<(textarea|select)\b[^>]*>[\s\S]*?<\/\1>/g);
    for (const [field, pairedTag] of fields) {
      const attrs = field.slice(0, field.indexOf('>'));
      if (!attrs.includes(`name="${key}"`) || /\bdisabled\b/.test(attrs)) continue;
      const content = pairedTag ? field.slice(field.indexOf('>') + 1, field.lastIndexOf('</')) : '';
      const value = !pairedTag ? attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? ''
        : pairedTag === 'textarea' ? content
          : (content.match(/<option value="([^"]*)" selected/) ?? content.match(/<option value="([^"]*)"/))?.[1] ?? '';
      return decode(value);
    }
    return null;
  }
}
function runtime(text) {
  return runRuntime(text, {profile:'aeon.gp.profile.v1', mode:'loose', datatypePolicy:'reserved_only', includeAnnotations:true, output:'map'});
}
async function mounted(text) {
  let descriptions = 0;
  const elements = new Map();
  for (const name of ['modal','tree','detail','open','reload','apply','add-peer','add-child','add-attribute','add-comment','remove']) {
    elements.set(name, {hidden:true, innerHTML:'', edits:new Map(), listeners:{},
      addEventListener(type, listener) { this.listeners[type] = listener; }, querySelector() { return null; }});
  }
  const source = {value:text, dispatchEvent() {}};
  const errors = [];
  const context = vm.createContext({window:{}, document:{addEventListener(){},removeEventListener(){}},
    Map, Event, FormData:DetailFormData, countParent:()=>{descriptions++;}, formatClarifierValue, parseAddress:sansa.parseAddress, renderAddress:sansa.renderAddress,
    createComposerPaths(api) {
      const paths = createComposerPaths(api);
      return {...paths, describe(path) { descriptions++; return paths.describe(path); }};
    }});
  vm.runInContext(composerCode, context);
  vm.runInContext("const originalParentPath = sourceParentPath; sourceParentPath = path => { countParent(); return originalParentPath(path); };", context);
  const composer = context.window.AeonSourceComposer.mount({
    shell:{querySelector(selector) { return elements.get(selector.match(/data-source-builder-(.*)\]/)?.[1]); },querySelectorAll() {return [];}},
    source, runtimeReady:Promise.resolve({runRuntime}), onError:error=>errors.push(String(error)),
    validateSource:async value=>{const reason = composerUnsupportedReason(value, tokenize); if (reason) throw Error(reason);}
  });
  await composer.open();
  return {source, elements, errors, context, inspections:()=>descriptions,
    async apply() {await elements.get('apply').listeners.click(); assert.deepEqual(errors, []); return source.value;},
    select(path) {elements.get('tree').listeners.click({target:{closest(selector) {return selector === '[data-source-builder-path]' ? {dataset:{sourceBuilderPath:path}} : null;}}});},
    edit(key, value) {elements.get('detail').edits.set(key, value);}
  };
}
async function roundTrip(input) {
  assert.deepEqual(runtime(input).meta.errors, [], 'valid input');
  const composer = await mounted(input);
  const output = await composer.apply();
  assert.deepEqual(runtime(output).meta.errors, [], output);
  const before = canonicalize(input), after = canonicalize(output);
  assert.deepEqual(before.errors, [], input); assert.deepEqual(after.errors, [], output);
  assert.equal(after.text, before.text, output);
  return composer;
}

test('mounted Composer preserves quoted body member kinds at root and below objects', async()=>{
  for (const key of ['@name', '', '[0]', '//name', '#comment1', ' leading ', 'a.@.b']) {
    await roundTrip(`${JSON.stringify(key)}="kept"`);
    await roundTrip(`obj={${JSON.stringify(key)}="kept"}`);
  }
  await roundTrip('"@name"@{"@unit"="kg"}="kept"');
});
test('Composer renaming uses member and attribute roles, including empty and @ names', async()=>{
  const composer = await mounted('name="kept"');
  composer.edit('name', '@renamed');
  assert.equal(canonicalize(await composer.apply()).text, canonicalize('"@renamed"="kept"').text);
  const empty = await mounted('name="kept"'); empty.edit('name','');
  assert.equal(canonicalize(await empty.apply()).text, canonicalize('""="kept"').text);
  const attr = await mounted('value@{unit="kg"}=1'); attr.select('$.value.@.unit'); attr.edit('name','@unit');
  assert.equal(canonicalize(await attr.apply()).text, canonicalize('value@{"@unit"="kg"}=1').text);
});
test('typed tuples retain all elements and datatype arguments', async()=>{
  await roundTrip('safe=0\ncoords:tuple<number,number>=(1,2)');
  await roundTrip('coords:triple<number,number,number>=(1,2,3)');
});
test('attribute composites retain recursive value children and their metadata', async()=>{
  for (const value of ['{a=1}', '[1,2]', '(1,2)', '<n(1,2)>', '{"@name"="kept", nested={b=2}}']) {
    await roundTrip(`value@{info=${value}}=2`);
  }
  await roundTrip('value@{info:list<number>=[1,2]}=2');
  await roundTrip('value@{info={a\\nested\\:number=1}}=2');
});
test('anonymous list, tuple and node children retain identity, attributes and datatype', async()=>{
  for (const value of ['[@{unit="kg"}:number=1]', '(@{unit="kg"}:number=1,2)', '<n(@{unit="kg"}:number=1)>']) {
    await roundTrip(`values=${value}`);
  }
  await roundTrip('values=[\\first\\@{unit="kg"}:number=1,\\second\\:number=2]');
});
test('indexed child traversal is linear for wide mounted Composer open/apply', async t=>{
  const counts = [];
  for (const width of [256,512]) {
    const composer = await mounted(Array.from({length:width},(_,i)=>`field${i}=${i}`).join('\n'));
    await composer.apply();
    counts.push(composer.inspections());
    assert.ok(composer.inspections() >= width && composer.inspections() < width * 20, String(counts));
  }
  assert.ok(counts[1] < counts[0] * 2.1, String(counts));
  t.diagnostic(`256/512-row path-helper calls: ${counts.join("/")}`);
});
test('indexed ordering retains comments, attributes, siblings and collapsed descendants', async()=>{
  const composer = await mounted('//# first\nobj@{unit="kg"}={a=1,b=2}\nlast=3');
  await composer.apply();
  const tree = composer.elements.get('tree').innerHTML;
  assert.ok(tree.indexOf('$.obj#comment1') < tree.indexOf('$.obj.@.unit'), tree);
  assert.ok(tree.indexOf('$.obj.@.unit') < tree.indexOf('$.obj.a'));
  assert.ok(tree.indexOf('$.obj.a') < tree.indexOf('$.obj.b'));
  assert.ok(tree.indexOf('$.obj.b') < tree.indexOf('$.last'));
});
test('lexical Composer guard still rejects reference and SANSA literal edits before rewriting', async()=>{
  for (const input of ['name="kept"\ncopy=~$.name', 'address:sansa=$.items.\\child\\']) {
    await assert.rejects(mounted(input), /reference|SANSA/i);
  }
});

test('Data, Annotations and Canonical never inspect or format the inactive AES table',()=>{
  const controller = readFileSync(new URL('../tools/playground/playground.js', import.meta.url), 'utf8');
  const formatters = controller.slice(controller.indexOf('  function formatRuntimeResult('), controller.indexOf('  function escapeHtml('));
  const context = vm.createContext({window:{},Map});
  vm.runInContext(formatters, context);
  assert.ok(controller.includes('formatRuntimeResult(runtimeResult, state.view)'));
  let aesReads = 0;
  const result = {...runtime('value="' + 'x'.repeat(2048) + '"'),
    get aes() {aesReads++; throw Error('inactive AES was read');}};
  for (const view of ['finalized','annotations','canonical']) {
    const payload = context.formatRuntimeResult(result, view);
    assert.equal(payload.aes, '');
    if (view === 'finalized') assert.equal(payload.finalized, JSON.stringify(result.document, null, 2));
    else assert.equal(payload.finalized, '');
  }
  assert.equal(aesReads, 0);
  const active = runtime('value@{unit="kg"}=1');
  assert.equal(context.formatRuntimeResult(active, 'aes').aes, context.renderAesTable(active.aes, active.document));
  assert.match(context.formatRuntimeResult(active, 'aes').aes, /\$\.value\.@\.unit/);
});
