import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '@altopelago/aeon-parser';
import {tokenize} from '@altopelago/aeon-lexer';
import {resolvePaths,emitEvents,validateReferences,projectPortableEvents,type AssignmentEvent} from './index.js';
test('structural events reject unexpected selections without cached-path fallback',()=>{
 const parsed=parse(tokenize('z=1\nx=~>z').tokens);assert.ok(parsed.document);
 const original=emitEvents(resolvePaths(parsed.document,{indexedPaths:true})).events;
 for(const selection of [null,false,0,'',{}, {canonical:'$.other',isExact:true}]){
  const events=original.map(e=>e.key==='x'?{...e,value:{...e.value,selection}}:e) as readonly AssignmentEvent[];
  for(const recovery of [false,true]){const result=validateReferences(events,{recovery});assert.equal(result.events.length,0);assert.equal(result.errors[0]?.code,'INVALID_REFERENCE_SELECTION');}
  assert.throws(()=>projectPortableEvents(events),(e:unknown)=>e instanceof Error&&'code' in e&&e.code==='AES_UNSUPPORTED_REFERENCE_SELECTION');
 }
});
