import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../../../../../test-fixtures/property-resolve-sdk-tagged-nodes.json' with {type: 'json'};
import {evaluateQuery, parseAddress, planMutation, resolveAddress} from '@altopelago/sansa';
import {readAeonNamespace, type AeonSansaBinding} from './sansa.js';

const host = () => readAeonNamespace(fixture.source).namespace;

test('SDK authoritative property fixtures preserve text/AST handles and paths', () => {
  const namespace = host();
  for (const item of fixture.cases) {
    const context = item.context === undefined ? undefined : resolveAddress(item.context, namespace).bindings[0];
    const parsed = parseAddress(item.address);
    if ('parseCode' in item) {
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.equal(parsed.errors[0]?.code, item.parseCode);
      continue;
    }
    assert.equal(parsed.ok, true, item.address);
    for (const address of [item.address, parsed.address!]) {
      const result: ReturnType<typeof resolveAddress<AeonSansaBinding>> = resolveAddress(address, namespace, {
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
  const value = resolveAddress('$.tag', namespace).bindings[0]!;
  const child = resolveAddress('$.tag[0]', namespace).bindings[0]!;
  value.name = 'forged';
  value.nodeTag = 'forged';
  value.representationKind = 'StringLiteral';
  child.nodeTag = 'forged';
  child.value = 'forged';
  child.representationKind = 'ObjectNode';
  value.children = [];
  assert.deepEqual(resolveAddress('$.*&key("tag")&tag("tag")', namespace).bindings, [value]);
  assert.deepEqual(resolveAddress('$.*&key("tag")&tag("forged")', namespace).bindings, []);
});

test('SDK property scopes reject foreign/forged roots without reading lookalike metadata', () => {
  const namespace = host();
  const foreign = resolveAddress('$.tag', host()).bindings[0]!;
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

test('SDK repeated handles retain multiplicity and inspection charges', () => {
  const namespace = host();
  const value = resolveAddress('$.tag', namespace).bindings[0]!;
  const repeated = {...namespace, children: () => [value, value]};
  const selected = resolveAddress('$.*&tag("tag")', repeated, {maxPropertyInspections: 2});
  assert.deepEqual(selected.bindings, [value, value]);
  const limited = resolveAddress('$.*&tag("tag")', repeated, {maxPropertyInspections: 1});
  assert.ok(!limited.ok);
  assert.equal(limited.errors[0]?.code, 'SANSA_RESOLVE_PROPERTY_LIMIT_EXCEEDED');
  assert.equal(limited.errors[0]?.observed, 2);
  assert.deepEqual(limited.bindings, []);
});

test('SDK owning planes retain scope and closed consumer boundaries', () => {
  for (const scope of ['header', 'payload', 'full'] as const) {
    const namespace = readAeonNamespace(fixture.source, {namespace: {scope}}).namespace;
    assert.deepEqual(resolveAddress('$&key("body")', namespace).bindings, []);
    const result = resolveAddress(scope === 'full' ? '$.header.*&key("aeon:title")' : '$.*&key("aeon:title")', namespace);
    assert.equal(result.ok, true);
    assert.equal(result.bindings.length, scope === 'payload' ? 0 : 1);
    const query = evaluateQuery('from $.*&key("tag")\nselect .', namespace);
    assert.ok(query.ok);
    assert.equal(query.results.length, scope === 'payload' ? 1 : 0);
    const mutation = planMutation({op: 'remove', target: '$.*&key("tag")'}, namespace);
    assert.ok(!mutation.ok);
    assert.deepEqual(mutation.errors.map(e => e.code), ['SANSA_MUTATE_NON_EXACT_TARGET']);
  }
});

test('recursive tag predicates select original nodes and their direct content', async () => {
  const {default: split} = await import('../../../../../test-fixtures/node-tag-sdk.json', {with:{type:'json'}});
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


test('SDK property Query preserves original targets, row scope, ordering and shared budgets', async () => {
  const {default: fixtures} = await import('../../../../../test-fixtures/property-query-sdk-tagged-nodes.json', {with:{type:'json'}});
  const {parseQuery} = await import('@altopelago/sansa');
  const namespace = readAeonNamespace(fixtures.source).namespace;
  for (const item of fixtures.cases) {
    const parsed=parseQuery(item.query);assert.ok(parsed.ok);
    for (const input of [item.query,parsed.query]) {
      const result=evaluateQuery(input,namespace,{resolve:{maxPropertyInspections:item.limit ?? 10000}});
      if (item.code) {assert.ok(!result.ok);assert.equal(result.errors[0]?.code,item.code);assert.equal(result.errors[0]?.phase,item.phase);assert.deepEqual(result.results,[]);continue;}
      assert.ok(result.ok,JSON.stringify(result));
      assert.deepEqual(result.results.map(row=>({candidate:row.candidateAddress,valueBindings:row.value.type==='bindingSet'?row.value.bindings.map(b=>b.address):null})),item.records,item.query);
      for(const row of result.results) {
        assert.equal(row.binding,resolveAddress(row.candidateAddress!,namespace).bindings[0]);
        if(row.value.type==='bindingSet') for(const binding of row.value.bindings) assert.equal(binding,resolveAddress(binding.address!,namespace).bindings[0]);
      }
    }
  }
});
