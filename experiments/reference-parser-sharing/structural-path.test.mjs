import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from '../../implementations/typescript/packages/parser/dist/index.js';
import {tokenize} from '../../implementations/typescript/packages/lexer/dist/index.js';
import {compile} from '../../implementations/typescript/packages/core/dist/index.js';
import {canonicalize} from '../../implementations/typescript/packages/canonical/dist/index.js';
import {resolvePaths,emitEvents,validateReferences,projectPortableEvents,resolveRefs} from '../../implementations/typescript/packages/aes/dist/index.js';
const baselineCanonical=await import('./.baseline/packages/canonical/dist/index.js');
const baseline=await import('./.baseline/packages/core/dist/index.js');
const semantic=value=>JSON.parse(JSON.stringify(value,(key,v)=>key==='span'?undefined:v));
const cases=JSON.parse(readFileSync(new URL('index-alignment-cases.json',import.meta.url)));
for(const {spelling,accept} of cases.cases)for(const marker of ['~','~>'])test(`${marker} index ${spelling}`,()=>{
 const source=`copy = ${marker}items${spelling}`;const lex=tokenize(source);
 const parsed=parse(lex.tokens);assert.equal(lex.errors.length===0&&parsed.errors.length===0,accept);
 if(accept){assert.equal(parsed.document.bindings[0].value.path[1],Number(spelling.slice(1,-1)));}
 else if(lex.errors.length){
  assert.equal(lex.errors[0].code,'INVALID_NUMBER');
  const span=lex.errors[0].span;
  assert.equal(source.slice(span.start.offset,span.end.offset),spelling.slice(1,-1));
 } else {
  const e=parsed.errors[0];assert.equal(e.code,'SYNTAX_ERROR');
  const token=lex.tokens.find(t=>t.value===spelling.slice(1,-1));
  if(token){assert.deepEqual(e.span,token.span);assert.equal(e.found,token.value);}
 }
 if(!accept){const result=compile(source);assert.equal(result.events.length,0);assert.ok(result.errors.length);}
});
for(const address of ['$', '?','?.a','$.a.*','$.a.**','$.a.^','$.a[0..2]','$.a.<"outside">','$.a:csv','$.a.@','$.\\A\\','$.\\A\\.\\B\\'])test(`reject non-reference path ${address}`,()=>{
 for(const marker of ['~','~>'])assert.ok(compile(`r = ${marker}${address}`).errors.length);
});
test('quoted numeric members and ordinary numeric literals keep their meanings',()=>{
 for(const raw of ['1.5','1e2','-0','+1','00','01','1_0','0x10','1000000','9007199254740993']){
  const source=`source = { "${raw}" = "value" }\ncopy = ~source.["${raw}"]`;
  const c=compile(source);assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.events.find(e=>e.key==='copy').value.path,['source',raw]);
 }
 for(const raw of ['1.5','1e2','-0','+1','1_0','0x10','1000000','9007199254740993']){
  const source=`value = ${raw}`;assert.deepEqual(semantic(compile(source)),semantic(baseline.compile(source)),raw);
 }
});
test('canonical roundtrip preserves concrete structural targets and evaluated values',()=>{
 for(const source of [
  'z = { name = "world" }\na = ~>$.z.name',
  'z = ["first", "second"]\na = ~z[1]',
  'z@{ unit = "cm" } = 1\na = ~z.@.unit',
  'z = <tag("first", "second")>\na = ~>z[1]',
  'z = {"a.b" = "world"}\na = ~z.["a.b"]',
 ]){
  const before=compile(source,{maxAttributeDepth:8});assert.deepEqual(before.errors,[]);
  const result=canonicalize(source,{maxAttributeDepth:8});assert.deepEqual(result.errors,[]);
  assert.deepEqual(canonicalize(result.text,{maxAttributeDepth:8}),result);
  const after=compile(result.text,{maxAttributeDepth:8});assert.deepEqual(after.errors,[]);
  const ref=r=>r.events.find(e=>e.key==='a').value;
  assert.deepEqual(ref(after).path,ref(before).path);
  const value=r=>resolveRefs(r.events).aes.find(e=>e.key==='a').value;
  assert.deepEqual(semantic(value(after)),semantic(value(before)));
  assert.deepEqual(projectPortableEvents(after.events).find(e=>e.path==='$.a').value,
    projectPortableEvents(before.events).find(e=>e.path==='$.a').value);
 }
});
test('reference legality and independent limits stay enforced',()=>{
 for(const [source,code] of [['x = ~x','SELF_REFERENCE'],['x = ~later\nlater = 1','FORWARD_REFERENCE'],['x = ~missing','MISSING_REFERENCE_TARGET']]){
  const c=compile(source);assert.equal(c.events.length,0);assert.ok(c.errors.some(e=>e.code===code));assert.equal(canonicalize(source).text,'');
 }
 const source='z = { name = "v" }\nx = ~z.name';
 assert.ok(compile(source,{maxPathDepth:1}).errors.some(e=>e.code==='MAX_PATH_DEPTH_EXCEEDED'));
 assert.ok(compile(source,{maxPathCharacters:3}).errors.some(e=>e.code==='MAX_PATH_CHARACTERS_EXCEEDED'));
 assert.ok(compile('z@{unit="cm"}=1\nx=~z.@.unit',{maxAttributeDepth:0}).errors.length);
});
test('caller events cannot smuggle semantic selections through a cached structural path',()=>{
 const c=compile('z = 1\nx = ~>z');assert.deepEqual(c.errors,[]);
 for(const selection of [null,false,0,'',{}, {canonical:'$.other',isExact:true}]){
  const events=c.events.map(e=>e.key==='x'?{...e,value:{...e.value,selection}}:e);
  for(const recovery of [false,true]){
   const r=validateReferences(events,{recovery});assert.equal(r.events.length,0);assert.equal(r.errors[0].code,'INVALID_REFERENCE_SELECTION');
  }
  assert.throws(()=>projectPortableEvents(events),e=>e.code==='AES_UNSUPPORTED_REFERENCE_SELECTION');
 }
});
test('root API and declarations expose no selection/profile/session/replay machinery',async()=>{
 const api=await import('../../implementations/typescript/packages/parser/dist/index.js');
 for(const name of ['createReferenceEngine','openReferenceSession','parseWithReferenceSession','renderReferenceSelection','createReferenceReplayCodec'])assert.equal(name in api,false,name);
 const root=new URL('../../implementations/typescript/packages/',import.meta.url);
 for(const name of ['parser','core','canonical']){
  const declaration=readFileSync(new URL(`${name}/dist/${name==='parser'?'parser':'index'}.d.ts`,root),'utf8');
  assert.doesNotMatch(declaration,/referenceEngine|ReferenceSession|ReferenceSelectionProgram|maxReferenceInspections/);
 }
});

test('single-join canonical rendering preserves empty and nonempty document bytes',()=>{
 for(const source of ['', 'aeon:header = {}', 'a = 1', 'a = {b = 1}', 'a = [1,2]', 'a = "line\\ntext"']){
  for(const ordering of ['lexical-v1','reference-safe-v1']){
   const options={ordering};assert.deepEqual(canonicalize(source,options),baselineCanonical.canonicalize(source,options));
  }
 }
});

test('structural identity metadata remains valid without becoming a reference path step',()=>{
 const source='group\\G\\ = { child\\C\\ = "world" }\ncopy = ~group.child';
 const c=compile(source);assert.deepEqual(c.errors,[]);
 assert.deepEqual(c.events.find(e=>e.key==='copy').value.path,['group','child']);
 const rendered=canonicalize(source);assert.deepEqual(rendered.errors,[]);
 assert.ok(rendered.text.includes('group\\G\\'));assert.ok(rendered.text.includes('child\\C\\'));
 assert.ok(compile('group\\G\\ = 1\nother\\G\\ = 2').errors.some(e=>e.code==='DUPLICATE_STRUCTURAL_IDENTITY'));
 assert.ok(compile('group\\G\\ = 1\ncopy = ~$.\\G\\').errors.length);
});
