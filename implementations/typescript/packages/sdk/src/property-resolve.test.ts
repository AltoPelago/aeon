import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../../../../../test-fixtures/property-resolve-sdk.json' with {type: 'json'};
import {evaluateQuery, parseAddress, planMutation, resolveAddress} from '@altopelago/sansa';
import {readAeonNamespace, type AeonSansaBinding} from './sansa.js';

const host = () => readAeonNamespace(fixture.source).namespace;

test('SDK authoritative property fixtures preserve text/AST handles and paths', () => {
  const namespace = host();
  for (const item of fixture.cases) {
    const context = item.context === undefined ? undefined : resolveAddress(item.context, namespace).bindings[0];
    const parsed = parseAddress(item.address);
    assert.equal(parsed.ok, true, item.address);
    for (const address of [item.address, parsed.address!]) {
      const result = resolveAddress(address, namespace, {
        ...(context === undefined ? {} : {contextualRoot: context}),
        ...(item.limit === undefined ? {} : {maxPropertyInspections: item.limit}),
      });
      if (item.code !== undefined) {
        assert.ok(!result.ok, item.address);
        assert.equal(result.errors[0]?.code, item.code, item.address);
        assert.deepEqual(result.bindings, []);
        if (item.observed !== undefined) {
          assert.equal(result.errors[0]?.observed, item.observed);
          assert.equal(result.errors[0]?.budget, 'maxPropertyInspections');
          assert.equal(result.errors[0]?.limit, item.limit);
        }
      } else {
        assert.ok(result.ok, `${item.address}: ${JSON.stringify(result.ok ? [] : result.errors)}`);
        assert.deepEqual(result.bindings.map(b => b.address), item.paths, item.address);
        for (const binding of result.bindings) assert.equal(binding, resolveAddress(binding.address, namespace).bindings[0]);
      }
    }
  }
});

test('SDK property metadata remains authoritative after display fields change', () => {
  const namespace = host();
  const value = resolveAddress('$.value', namespace).bindings[0]!;
  const head = resolveAddress('$.value[0]', namespace).bindings[0]!;
  value.name = 'forged';
  value.nodeTag = 'forged';
  value.representationKind = 'StringLiteral';
  head.nodeTag = 'forged';
  head.value = 'forged';
  head.representationKind = 'ObjectNode';
  value.children = [];
  assert.deepEqual(resolveAddress('$.*&key("value")&tag("tag")', namespace).bindings, [value]);
  assert.deepEqual(resolveAddress('$.*&key("value")&tag("forged")', namespace).bindings, []);
});

test('SDK property scopes reject foreign/forged roots without reading lookalike metadata', () => {
  const namespace = host();
  const foreign = resolveAddress('$.value', host()).bindings[0]!;
  let reads = 0;
  const forged = Object.defineProperty({}, 'name', {get() {reads++; throw Error('secret');}}) as AeonSansaBinding;
  for (const contextualRoot of [foreign, forged]) {
    const result = resolveAddress('?&tag("tag")', namespace, {contextualRoot});
    assert.ok(!result.ok);
    assert.equal(result.errors[0]?.code, 'SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION');
    assert.deepEqual(result.bindings, []);
  }
  assert.equal(reads, 0);
});

test('SDK direct-head ownership cannot be replaced by another owned node', () => {
  const namespace = host();
  for (const path of ['$.group.nested[0]', '$.value[0][0]']) {
    const injected = resolveAddress(path, namespace).bindings[0]!;
    const result = resolveAddress('$.value&tag("tag")', {
      ...namespace,
      properties: {...namespace.properties!, nodeHeads: function* () {yield injected;}},
    });
    assert.ok(!result.ok);
    assert.equal(result.errors[0]?.code, 'SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION');
    assert.deepEqual(result.bindings, []);
  }
});

test('SDK repeated handles retain multiplicity and inspection charges', () => {
  const namespace = host();
  const value = resolveAddress('$.value', namespace).bindings[0]!;
  const repeated = {...namespace, children: () => [value, value]};
  const selected = resolveAddress('$.*&tag("tag")', repeated, {maxPropertyInspections: 4});
  assert.deepEqual(selected.bindings, [value, value]);
  const limited = resolveAddress('$.*&tag("tag")', repeated, {maxPropertyInspections: 3});
  assert.ok(!limited.ok);
  assert.equal(limited.errors[0]?.code, 'SANSA_RESOLVE_PROPERTY_LIMIT_EXCEEDED');
  assert.equal(limited.errors[0]?.observed, 4);
  assert.deepEqual(limited.bindings, []);
});

test('SDK owning planes retain scope and closed consumer boundaries', () => {
  for (const scope of ['header', 'payload', 'full'] as const) {
    const namespace = readAeonNamespace(fixture.source, {namespace: {scope}}).namespace;
    assert.deepEqual(resolveAddress('$&key("body")', namespace).bindings, []);
    const result = resolveAddress(scope === 'full' ? '$.header.*&key("aeon:title")' : '$.*&key("aeon:title")', namespace);
    assert.equal(result.ok, true);
    assert.equal(result.bindings.length, scope === 'payload' ? 0 : 1);
    const query = evaluateQuery('from $.*&key("value")\nselect .', namespace);
    assert.ok(!query.ok);
    assert.equal(query.errors[0]?.code, 'SANSA_RESOLVE_UNSUPPORTED_SELECTOR');
    const mutation = planMutation({op: 'remove', target: '$.*&key("value")'}, namespace);
    assert.ok(!mutation.ok);
    assert.deepEqual(mutation.errors.map(e => e.code), ['SANSA_MUTATE_NON_EXACT_TARGET']);
  }
});

test('recursive tag predicates distinguish original containers, heads and content', async () => {
  const {default: split} = await import('../../../../../test-fixtures/tag-head-split.json', {with:{type:'json'}});
  const namespace = readAeonNamespace(split.source).namespace;
  for (const item of split.cases) {
    const parsed = parseAddress(item.address);
    assert.ok(parsed.ok);
    for (const address of [item.address, parsed.address]) {
      const selected = resolveAddress(address, namespace);
      assert.equal(selected.ok, true);
      assert.deepEqual(selected.bindings.map(binding => binding.address), item.paths);
      assert.deepEqual(selected.bindings.map(binding => binding.representationKind), item.kinds);
      for (const binding of selected.bindings) assert.equal(binding, resolveAddress(binding.address, namespace).bindings[0]);
    }
  }
});
