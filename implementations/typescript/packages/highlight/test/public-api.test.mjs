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

test('provider renderer uses only the selected tokenizer and preserves options',async()=>{
  const {createHighlighter}=await import('../dist/renderer.js');
  const lexer=await import('@altopelago/aeon-lexer');let calls=0;
  const h=createHighlighter({...lexer,tokenize:(source,options)=>{calls++;assert.deepEqual(options,{includeComments:true,includeNewlines:true});return lexer.tokenize(source,options);}});
  const source='name\\id\\="😀"';assert.equal(h.highlightAeon(source),highlightAeon(source));assert.equal(calls,1);
});
test('provider entry loads without loading a lexer or DOM',async()=>{
  const {spawnSync}=await import('node:child_process');
  const script=`import {register} from 'node:module';
    register('data:text/javascript,'+encodeURIComponent('export function resolve(s,c,n){if(s.includes("aeon-lexer"))throw Error("unexpected lexer load");return n(s,c);}'),import.meta.url);
    const {createHighlighter}=await import(process.argv[1]);let calls=0;
    const h=createHighlighter({TokenType:{},tokenize:()=>{calls++;return {tokens:[]};}});
    if(h.highlightAeon('<raw>')!=='&lt;raw&gt;'||calls!==1)throw Error('provider ignored');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,new URL('../dist/renderer.js',import.meta.url).href],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});


test('numeric/temporal theme roles are distinct and addresses inherit symbol colour',async()=>{
  for(const [file,number,temporal] of [['theme.css','#7dd3fc','#f5e6a8'],['theme-light.css','#006b80','#806500']]){
    const css=await readFile(new URL('../dist/'+file,import.meta.url),'utf8');
    assert.ok(css.includes('--aeon-number: '+number+';'));
    assert.ok(css.includes('--aeon-temporal: '+temporal+';'));
    assert.ok(css.includes('--aeon-sansa: var(--aeon-symbol);'));
    assert.ok(css.includes('.tok-number { color: var(--aeon-number); }'));
    assert.ok(css.includes('.tok-temporal { color: var(--aeon-temporal); }'));
  }
});
