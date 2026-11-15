import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@altopelago/aeon-canonical';
import { compile } from '@altopelago/aeon-core';
import { evaluateQuery, planMutation, resolveAddress } from '@altopelago/sansa';
import { readAeonNamespace } from './sansa.js';

test('identity aliases retain empty member paths and original Query bindings', () => {
  const { namespace } = readAeonNamespace('""\\root\\={""\\leaf\\="İ😀"}');
  const literal = resolveAddress('$.[""].[""]', namespace);
  const alias = resolveAddress('$.\\root\\.\\leaf\\', namespace);
  assert.equal(literal.ok, true);
  assert.equal(alias.ok, true);
  assert.equal(alias.bindings.length, 1);
  assert.equal(alias.bindings[0], literal.bindings[0]);
  assert.equal(alias.bindings[0]?.address, '$.[""].[""]');
  assert.notEqual(alias.bindings[0], namespace.root);
  const query = evaluateQuery('from $.\\root\\\nselect .\\leaf\\', namespace);
  assert.equal(query.ok, true);
  assert.equal(query.results[0]?.candidateAddress, '$.[""]');
  assert.equal(query.results[0]?.valueAddress, '$.[""].[""]');
  assert.deepEqual(query.results[0]?.value, { type: 'bindingSet', bindings: literal.bindings });
  const lower = evaluateQuery('from $.\\root\\.\\leaf\\\nselect lower(.)', namespace);
  assert.equal(lower.ok, true);
  assert.deepEqual(lower.results[0]?.value, { type: 'scalar', value: 'i\u0307😀' });
});

test('list identities and canonical references keep the same empty-key target', () => {
  const source = 'items=[\\item\\={""\\label\\="İ😀"}]\ncopy=~items[0].[""]';
  const canonical = canonicalize(source);
  assert.deepEqual(canonical.errors, []);
  assert.equal(canonicalize(canonical.text).text, canonical.text);
  for (const text of [source, canonical.text]) {
    const { namespace } = readAeonNamespace(text);
    const selected = resolveAddress('$.items.\\item\\.\\label\\', namespace);
    const literal = resolveAddress('$.items[0].[""]', namespace);
    assert.equal(selected.ok, true);
    assert.equal(selected.bindings[0], literal.bindings[0]);
    assert.equal(selected.bindings[0]?.address, '$.items[0].[""]');
    assert.equal(selected.bindings[0]?.value, 'İ😀');
    const compiled = compile(text);
    assert.deepEqual(compiled.errors, []);
    const reference = compiled.events.find(event => event.key === 'copy');
    assert.ok(reference && 'path' in reference.value);
    assert.deepEqual(reference.value.path, ['items', 0, '']);
  }
});

test('Unicode line-terminator globs work below an empty member', () => {
  const { namespace } = readAeonNamespace('""={' + JSON.stringify('line\n') + '="hit",plain="other"}');
  const selected = resolveAddress('$.[""].(' + JSON.stringify('*\n') + ')', namespace);
  assert.equal(selected.ok, true);
  assert.equal(selected.bindings.length, 1);
  assert.equal(selected.bindings[0]?.name, 'line\n');
  assert.equal(selected.bindings[0]?.value, 'hit');
});

test('empty ordinary members do not admit identity-based mutation', () => {
  const { namespace } = readAeonNamespace('""\\root\\={""\\leaf\\="original"}');
  assert.equal(planMutation({ op: 'replace', target: '$.\\root\\.\\leaf\\', value: 'changed' }, namespace).ok, false);
  assert.equal(planMutation({ op: 'replace', target: '$.[""].[""]', value: 'changed' }, namespace).ok, true);
  assert.equal(resolveAddress('$.[""].[""]', namespace).bindings[0]?.value, 'original');
});
