import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuery, resolveAddress } from '@altopelago/sansa';
import { readAeon } from './index.js';
import { createAeonNamespace, readAeonNamespace } from './sansa.js';

const INVENTORY_SOURCE = String.raw`aeon:header = {
  mode:string = "strict"
}

inventory\INVENTORY\@{source\SOURCE\:string = "erp"}:object = {
  items:list = [
    {
      sku:string = "A-100"
      qty:number = 14
      active:boolean = true
    }
    {
      sku:string = "B-200"
      qty:number = 4
      active:boolean = false
    }
  ]
  unavailable:null = !notSet
}`;

test('reads AEON directly into a payload-scoped SANSA namespace', () => {
  const { namespace } = readAeonNamespace(INVENTORY_SOURCE);

  assert.deepEqual(namespace.root.children.map((binding) => binding.name), ['inventory']);

  const result = evaluateQuery(
    'from $.inventory.items.* where .active == true select { sku = .sku qty = .qty }',
    namespace,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.results.map((entry) => entry.value), [
    { type: 'object', value: { sku: 'A-100', qty: 14 } },
  ]);
});

test('preserves AEON identity, attributes, and null metadata', () => {
  const { namespace } = readAeonNamespace(INVENTORY_SOURCE);
  const inventory = resolveAddress('$.inventory', namespace);
  assert.equal(inventory.ok, true);
  assert.equal(inventory.bindings[0]?.identity, 'INVENTORY');

  const source = resolveAddress('$.inventory.@.source', namespace);
  assert.equal(source.ok, true);
  assert.equal(source.bindings[0]?.identity, 'SOURCE');
  assert.equal(source.bindings[0]?.value, 'erp');
  assert.equal(namespace.parent?.(source.bindings[0]!), inventory.bindings[0]?.attributeSpace);

  const unavailable = resolveAddress('$.inventory.unavailable', namespace);
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.bindings[0]?.value, null);
  assert.equal(unavailable.bindings[0]?.scalarKind, 'null');
  assert.equal(unavailable.bindings[0]?.nullReason, 'notSet');
});

test('supports explicit header and full document scopes', () => {
  const compiled = readAeon(INVENTORY_SOURCE);
  const header = createAeonNamespace(compiled.compile.events, { scope: 'header' });
  const full = createAeonNamespace(compiled.compile.events, { scope: 'full' });

  assert.deepEqual(header.root.children.map((binding) => binding.name), ['aeon:mode']);
  assert.deepEqual(full.root.children.map((binding) => binding.name), ['aeon:mode', 'inventory']);
});

test('rejects event streams whose selected scope is not parent-first', () => {
  const compiled = readAeon('outer = { inner = 1 }');
  const reversed = [...compiled.compile.events].reverse();

  assert.throws(
    () => createAeonNamespace(reversed),
    /has no parent binding/u,
  );
});
