import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenize} from '../../implementations/typescript/packages/lexer/dist/index.js';
import {parse} from '../../implementations/typescript/packages/parser/dist/index.js';
import {emitEvents,resolvePaths,validateReferences} from '../../implementations/typescript/packages/aes/dist/index.js';
import {referenceSafeOrders} from '../../implementations/typescript/packages/canonical/dist/ordering.js';
import {canonicalize} from '../../implementations/typescript/packages/canonical/dist/index.js';
function freeze(value,seen=new Set()){
 if(!value||typeof value!=='object'||seen.has(value))return;
 seen.add(value);for(const v of value instanceof Map?value.values():Object.values(value))freeze(v,seen);
 Object.freeze(value);
}
const snapshot=value=>JSON.stringify(value,(_key,item)=>item instanceof Map?[...item]:item);
const sources=[
 Array.from({length:100},(_,i)=>`r${i}="v"`).join('\n'),
 'z=1\na=~z\nb=~>z',
 'z@{unit="cm"}=1\na=~z.@.unit',
 'z=["first","second"]\na=~z[1]',
 'z=<tag({"a.b"=1})>\na=~z[0].["a.b"]',
 'aeon:header={x={leaf=1}}\n"aeon:x"=2\na=~>["aeon:x"].leaf',
 'aeon:header={x={leaf@{meta=1}=2}}\n"aeon:x"={leaf@{meta=3}=4}\na=~["aeon:x"].leaf.@.meta',
 'aeon:header={x={leaf=1}}\na=<tag@{meta=~["aeon:x"].leaf}>\n"aeon:x"=0',
];
for(const source of sources)test(`validated emission reuse preserves ordering: ${source.slice(0,85)}`,()=>{
 const parsed=parse(tokenize(source).tokens,{maxAttributeDepth:8});assert.deepEqual(parsed.errors,[]);
 const doc=parsed.document;
 const emission=emitEvents(resolvePaths(doc,{indexedPaths:true}));assert.deepEqual(emission.errors,[]);
 assert.deepEqual(validateReferences(emission.events,{maxAttributeDepth:8}).errors,[]);
 const expected=referenceSafeOrders(doc,1_000_000);
 const before=snapshot(emission.events);freeze(emission.events);
 assert.deepEqual(referenceSafeOrders(doc,1_000_000,emission.events),expected);
 assert.equal(snapshot(emission.events),before);
});
test('reused events retain exact dependency edge budgets',()=>{
 const doc=parse(tokenize('z=1\na=~z').tokens).document;
 const events=emitEvents(resolvePaths(doc,{indexedPaths:true})).events;
 for(const stream of [undefined,events]){
  assert.throws(()=>referenceSafeOrders(doc,0,stream),e=>e.code==='CANONICAL_ORDERING_LIMIT_EXCEEDED');
  assert.deepEqual(referenceSafeOrders(doc,1,stream),referenceSafeOrders(doc,1));
 }
});
test('authored and emitted reference legality remains fail-closed',()=>{
 for(const source of ['x=~missing','x=~x','x=~later\nlater=1',
 'aeon:header={x={leaf=1}}\na=~["aeon:x"].leaf\n"aeon:x"={leaf=2}']){
  const result=canonicalize(source);assert.equal(result.text,'');assert.ok(result.errors.length);
 }
});
