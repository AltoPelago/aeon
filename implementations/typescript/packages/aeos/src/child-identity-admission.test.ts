import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../../../../../test-fixtures/aeos-child-identity-selectors.json' with {type:'json'};
import {validate, type ValidateOptions} from './validate.js';
import {normalizeSchemaObject, parseSchemaSource, schemaToAeon} from './schema-codec.js';
import type {AES} from './types/aes.js';
import type {SchemaV1} from './types/schema.js';

for (const item of cases.tests) test(`AEOS child identity: ${item.id}`,()=>{
 const events=structuredClone(item.events) as unknown as AES;
 const schema=structuredClone(item.schema) as unknown as SchemaV1;
 const options=('options' in item ? item.options : undefined) as ValidateOptions|undefined;
 const before=JSON.stringify(events);
 const result=validate(events,schema,options),expected=item.expected;
 assert.equal(result.ok,expected.ok,JSON.stringify(result));
 assert.equal(JSON.stringify(events),before);
 if(!result.ok){
  assert.deepEqual(result.guarantees,{});
  assert.ok(result.errors.some(e=>e.code===('error' in expected ? expected.error : '') && (!('errorPath' in expected) || e.path===expected.errorPath)),JSON.stringify(result));
  if('errorCount' in expected)assert.equal(result.errors.length,expected.errorCount);
 }
 assert.equal(validate(events,schema,options).ok,expected.ok);
 if(item.id==='exact-path-rejected')assert.throws(()=>normalizeSchemaObject(schema),/Child identity/);
 else {
  const normalized=normalizeSchemaObject(schema);
  assert.equal(validate(events,normalized,options).ok,expected.ok);
  if(item.id==='invalid-limit-9007199254740992')assert.throws(()=>parseSchemaSource(schemaToAeon(normalized)),/safe range/);
  else {
   const parsed=parseSchemaSource(schemaToAeon(normalized));
   assert.equal(validate(events,parsed,options).ok,expected.ok);
  }
 }
});

test('source, portable and Telex identity selection preserves the same target',async()=>{
 const {compile}=await import('@altopelago/aeon-core');
 const {projectPortableEvents,encodeTelex}=await import('@altopelago/aeon-aes');
 const {validateTelex}=await import('./telex.js');
 const source='items=[\\first\\={name\\label\\="hello"}]';
 const compiled=compile(source);assert.deepEqual(compiled.errors,[]);
 const schema:SchemaV1={rules:[{selector:'$.items.\\first\\.\\label\\',constraints:{required:true,type:'StringLiteral'}}]};
 const portable=projectPortableEvents(compiled.events);
 assert.equal(validate(compiled.events as unknown as AES,schema).ok,true);
 assert.equal(validateTelex(encodeTelex(portable),schema).ok,true);
 const bad:SchemaV1={rules:[{selector:schema.rules[0]!.selector!,constraints:{type:'NumberLiteral'}}]};
 for(const result of [validate(compiled.events as unknown as AES,bad),validateTelex(encodeTelex(portable),bad)]) {
  assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.path==='$.items[0].name'&&e.code==='type_mismatch'));
 }
});

test('illustrative schema projection explicitly omits identity selectors',async()=>{
 const {projectSchemaToAeon}=await import('./schema-tools.js');
 const selector='$.items.\\first\\';
 const result=projectSchemaToAeon({rules:[{selector,constraints:{type:'StringLiteral'}}]});
 assert.deepEqual(result.omittedRules,[selector]);
});
