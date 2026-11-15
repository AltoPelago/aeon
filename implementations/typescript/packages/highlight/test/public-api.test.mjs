import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {highlightAeon,highlightJson} from '../dist/index.js';
import {defineAeonCodeBlock} from '../dist/element.js';

test('pure and optional element entry points import in Node without a DOM',()=>{
  assert.equal(typeof document,'undefined');
  assert.match(highlightAeon('name:string="<hello>"'),/tok-key/);
  assert.ok(!highlightAeon('name="<img src=x>"').includes('<img'));
  assert.ok(!highlightJson('{"x":"<img>"}').includes('<img'));
  assert.throws(()=>defineAeonCodeBlock(),/requires a browser/);
});
test('public diagnostic options preserve exact UTF-16 source prefixes',()=>{
  const source='name="😀&<"';
  const html=highlightAeon(source,{diagnosticLine:1,diagnosticColumn:source.indexOf('&')+1});
  assert.match(html,/aeon-diagnostic-line/);assert.match(html,/&amp;&lt;/);
});
test('dark and light themes keep existing site palette values',async()=>{
  const dark=await readFile(new URL('../dist/theme.css',import.meta.url),'utf8');
  const light=await readFile(new URL('../dist/theme-light.css',import.meta.url),'utf8');
  for(const [role,colour]of [['key','#7fb2ff'],['type','#c7b8ff'],['string','#d9c58b']])assert.ok(dark.includes(`--aeon-${role}: ${colour};`));
  for(const [role,colour]of [['key','#006f56'],['type','#5d5a8d'],['string','#7a5c1f'],['literal','#526c20'],['comment','#767676']])assert.ok(light.includes(`--aeon-${role}: ${colour};`));
  assert.ok(!dark.includes('.tok-identifier'));assert.ok(!light.includes('.tok-identifier'));
});
