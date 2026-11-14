import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import vectors from '../../../../../test-fixtures/unicode-hardening-v1.json' with { type: 'json' };
import { canonicalize } from '@altopelago/aeon-canonical';
import { compile, compileToTelex, projectPortableEvents, parseTelex } from '@altopelago/aeon-core';
for (const vector of vectors.identity_pairs) test(vector.id + ' keys/references/canonical fixed point', () => {
  const left = JSON.stringify(vector.left); const right = JSON.stringify(vector.right);
  const source = `${left} = "left"\n${right} = "right"\nleftCopy = ~[${left}]\nrightPointer = ~>[${right}]`;
  const result = canonicalize(source); assert.deepEqual(result.errors, []);
  const again = canonicalize(result.text); assert.deepEqual(again.errors, []); assert.equal(again.text, result.text);
  const compiled = compile(result.text); assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.events.some(e => e.key === vector.left)); assert.ok(compiled.events.some(e => e.key === vector.right));
  for (const [key, target] of [['leftCopy', vector.left], ['rightPointer', vector.right]]) {
    const event = compiled.events.find(e => e.key === key);
    assert.ok(event && 'path' in event.value); assert.deepEqual(event.value.path, [target]);
  }
  const before = projectPortableEvents(compile(source).events);
  for (const path of ['$.leftCopy', '$.rightPointer']) assert.deepEqual(projectPortableEvents(compiled.events).find(e => e.path === path)?.value, before.find(e => e.path === path)?.value);
  const telex = compileToTelex(result.text); assert.deepEqual(telex.compile.errors, []); assert.ok(telex.telex);
  assert.ok(parseTelex(telex.telex).records.some(e => e.path?.includes(vector.left)));
  const duplicate = compile(`${left} = 1\n${left} = 2`); assert.ok(duplicate.errors.length > 0);
});

test('canonical output and reference targets are stable in fresh host-locale processes', context => {
  const source = '"I"="left"\n"ı"="right"\ncopy=~>["ı"]';
  const program = `import {canonicalize} from ${JSON.stringify(import.meta.resolve('@altopelago/aeon-canonical'))}; import {compile} from ${JSON.stringify(import.meta.resolve('@altopelago/aeon-core'))}; const result=canonicalize(${JSON.stringify(source)}); const parsed=compile(result.text); console.log(JSON.stringify({locale:new Intl.Collator().resolvedOptions().locale, canonical:result.text,errors:result.errors,paths:parsed.events.filter(e=>e.key==='copy').map(e=>e.value.path)}));`;
  let expected;
  for (const locale of ['C', 'en_US.UTF-8', 'tr_TR.UTF-8', 'az_AZ.UTF-8']) {
    const result=spawnSync(process.execPath,['--input-type=module','-e',program],{env:{...process.env,LANG:locale,LC_ALL:locale},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const observed=JSON.parse(result.stdout);
    context.diagnostic(JSON.stringify({requested:locale,collatorLocale:observed.locale}));
    const stable={canonical:observed.canonical,errors:observed.errors,paths:observed.paths};
    assert.deepEqual(stable.errors,[]);assert.deepEqual(stable.paths,[['ı']]);
    if (expected===undefined)expected=stable;else assert.deepEqual(stable,expected);
  }
});
