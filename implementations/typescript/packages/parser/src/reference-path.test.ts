import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenize} from '@altopelago/aeon-lexer';
import {parse} from './parser.js';
import fixtures from '../../../../../test-fixtures/reference-path-indexes.json' with {type:'json'};
for (const {spelling,accept} of fixtures.cases) for (const marker of ['~','~>']) {
 test(`structural reference index ${marker}${spelling}`,()=>{
  const source=`copy = ${marker}items${spelling}`;
  const lex=tokenize(source), result=parse(lex.tokens);
  assert.equal(lex.errors.length===0&&result.errors.length===0,accept);
  if(accept){const ref=result.document!.bindings[0]!.value;assert.ok(ref.type==='CloneReference'||ref.type==='PointerReference');assert.deepEqual(ref.path,['items',Number(spelling.slice(1,-1))]);}
  else if(lex.errors.length){const e=lex.errors[0]!;assert.equal(e.code,'INVALID_NUMBER');assert.equal(source.slice(e.span.start.offset,e.span.end.offset),spelling.slice(1,-1));}
  else {const e=result.errors[0]!;assert.equal(e.code,'SYNTAX_ERROR');const token=lex.tokens.find(t=>t.value===spelling.slice(1,-1));if(token)assert.deepEqual(e.span,token.span);}
 });
}
for(const address of ["$", "?", "?.a", "$.a.*", "$.a.**", "$.a.^", "$.a[0..2]", "$.a.<\"outside\">", "$.a:csv", "$.a.@", "$.\\A\\", "$.\\A\\.\\B\\"]) {
 test(`references reject unsupported steps ${address}`,()=>{
  for(const marker of ['~','~>']){const lex=tokenize(`copy=${marker}${address}`);const result=parse(lex.tokens);assert.ok(lex.errors.length||result.errors.length);}
 });
}
test('quoted numeric keys remain names; ordinary numbers retain value syntax',()=>{
 for(const raw of ['1.5','1e2','-0','+1','00','01','1_0','0x10','1000000','9007199254740993']){
  const result=parse(tokenize(`copy=~source.["${raw}"]`).tokens);assert.deepEqual(result.errors,[]);const ref=result.document!.bindings[0]!.value;assert.ok(ref.type==='CloneReference');assert.deepEqual(ref.path,['source',raw]);
 }
 for(const raw of ['1.5','1e2','-0','+1','1_0','1000000','9007199254740993'])assert.deepEqual(parse(tokenize(`n=${raw}`).tokens).errors,[]);
});
