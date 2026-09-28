import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuery, resolveAddress } from '@altopelago/sansa';
import { readAeon } from './index.js';
import {
  createAeonNamespace,
  readAeonNamespace,
  type AeonSansaBinding,
  type AeonSansaNamespace,
} from './sansa.js';

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

const VALUE_FAMILIES_SOURCE = String.raw`target:number = 7
targetClone:number = ~target
targetPointer:number = ~>target

types:object = {
  previous:number = 9007199254740992
  precise:number = 9007199254740993
  price:decimal = %19.9900
  bits:radix[2] = %101.01
  octal:radix8 = %70
  maximum:radix[64] = %!
  active:boolean = true
  consent:toggle = yes
  color:hex = #ff00aa
  mask:radix[16] = %ff00aa
  payload:encoding = &QmFzZTY0IQ==
  version:sep["."] = ^0.11.0
  selector:sansa = $.types.*.sku
  released:date = 2026-07-25
  window:time = 09:30:00Z
  stamp:datetime = 2026-07-25T09:30:00Z
  zone:wtc = 2026-07-25T09:30:00Z&Australia/Melbourne
  metric:nan<number> = NaN
  ceiling:infinity<number> = Infinity
  floor:infinity<number> = -Infinity
  unavailable:null<string> = !notApplicable
}

containers:object = {
  series:list<number> = [1, 2]
  pair:tuple = ("x", 1)
  nodeValue:node = <tag("hello")>
}

annotated\ROOT\@{meta\META\@{deep\DEEP\ = 3}:string = "source"}:number = 1`;

function bindingAt(namespace: AeonSansaNamespace, address: string): AeonSansaBinding {
  const resolved = resolveAddress(address, namespace);
  if (!resolved.ok) assert.fail(JSON.stringify(resolved.errors));
  assert.equal(resolved.bindings.length, 1, `Expected one binding at ${address}`);
  return resolved.bindings[0]!;
}

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
    { type: 'object', value: { sku: 'A-100', qty: '14' } },
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
  assert.deepEqual(full.root.children.map((binding) => binding.name), ['header', 'body']);
  assert.equal(bindingAt(full, '$.header.["aeon:mode"]').value, 'strict');
  assert.equal(bindingAt(full, '$.body.inventory').identity, 'INVENTORY');
});

test('keeps colliding header and body paths distinct in full document scope', () => {
  const { compile } = readAeon(String.raw`aeon:mode = "strict"
"aeon:mode":string = "payload"`);
  assert.equal(compile.errors.length, 0);

  const full = createAeonNamespace(compile.events, { scope: 'full' });
  assert.equal(bindingAt(full, '$.header.["aeon:mode"]').value, 'strict');
  assert.equal(bindingAt(full, '$.body.["aeon:mode"]').value, 'payload');
});

test('infers WTC metadata for an untyped temporal context claim', () => {
  const { namespace } = readAeonNamespace('world = 2026-07-25T09:30:00Z&Australia/Melbourne');
  const world = bindingAt(namespace, '$.world');

  assert.equal(world.semanticType, 'wtc');
  assert.equal(world.representationKind, 'wtc');
  assert.equal(world.scalarKind, 'wtc');
});

test('adapts every AEON scalar family without erasing representation metadata', () => {
  const { namespace, eventsByPath } = readAeonNamespace(VALUE_FAMILIES_SOURCE, {
    compile: { datatypePolicy: 'allow_custom', maxAttributeDepth: 8 },
  });

  const precise = bindingAt(namespace, '$.types.precise');
  assert.equal(precise.value, '9007199254740993');
  assert.equal(precise.numericLexeme, '9007199254740993');
  const preciseEvent = eventsByPath.get('$.types.precise');
  assert.equal(preciseEvent?.value.type, 'NumberLiteral');
  if (preciseEvent?.value.type !== 'NumberLiteral') assert.fail('Expected NumberLiteral');
  assert.equal(preciseEvent.value.value, '9007199254740993');

  const price = bindingAt(namespace, '$.types.price');
  assert.equal(price.value, '19.9900');
  assert.equal(price.semanticType, 'decimal');
  assert.equal(price.representationKind, 'radix');
  assert.equal(price.radixBase, 10);
  assert.equal(price.radixScale, 4);

  const bits = bindingAt(namespace, '$.types.bits');
  assert.equal(bits.value, '101.01');
  assert.equal(bits.radixBase, 2);
  assert.equal(bits.radixScale, 2);
  assert.equal(namespace.radixScale(bits), 2);
  assert.equal(bindingAt(namespace, '$.types.octal').radixBase, 8);
  assert.equal(bindingAt(namespace, '$.types.maximum').radixBase, 64);

  assert.equal(bindingAt(namespace, '$.types.active').value, true);
  assert.deepEqual(
    [bindingAt(namespace, '$.types.consent').representationKind, bindingAt(namespace, '$.types.consent').value],
    ['toggle', 'yes'],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.color').scalarKind, bindingAt(namespace, '$.types.color').value],
    ['hex', 'ff00aa'],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.mask').scalarKind, bindingAt(namespace, '$.types.mask').value],
    ['radix', 'ff00aa'],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.payload').scalarKind, bindingAt(namespace, '$.types.payload').value],
    ['encoding', 'QmFzZTY0IQ=='],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.version').scalarKind, bindingAt(namespace, '$.types.version').value],
    ['separator', '0.11.0'],
  );
  assert.deepEqual(bindingAt(namespace, '$.types.selector').value, {
    type: 'SansaAddressLiteral',
    address: '$.types.*.sku',
    canonical: '$.types.*.sku',
  });
  assert.deepEqual(
    [bindingAt(namespace, '$.types.released').scalarKind, bindingAt(namespace, '$.types.released').value],
    ['date', '2026-07-25'],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.window').scalarKind, bindingAt(namespace, '$.types.window').value],
    ['time', '09:30:00Z'],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.stamp').scalarKind, bindingAt(namespace, '$.types.stamp').value],
    ['datetime', '2026-07-25T09:30:00Z'],
  );
  assert.deepEqual(
    [bindingAt(namespace, '$.types.zone').scalarKind, bindingAt(namespace, '$.types.zone').value],
    ['wtc', '2026-07-25T09:30:00Z&Australia/Melbourne'],
  );
  assert.equal(Number.isNaN(bindingAt(namespace, '$.types.metric').value), true);
  assert.equal(bindingAt(namespace, '$.types.ceiling').value, Infinity);
  assert.equal(bindingAt(namespace, '$.types.floor').value, -Infinity);

  const unavailable = bindingAt(namespace, '$.types.unavailable');
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.scalarKind, 'null');
  assert.equal(unavailable.nullReason, 'notApplicable');
});

test('adapts references, containers, identities, and nested attributes', () => {
  const { namespace } = readAeonNamespace(VALUE_FAMILIES_SOURCE, {
    compile: { datatypePolicy: 'allow_custom', maxAttributeDepth: 8 },
  });

  assert.deepEqual(bindingAt(namespace, '$.targetClone').value, {
    type: 'CloneReference',
    path: ['target'],
    canonical: '~target',
  });
  assert.deepEqual(bindingAt(namespace, '$.targetPointer').value, {
    type: 'PointerReference',
    path: ['target'],
    canonical: '~>target',
  });
  assert.equal(bindingAt(namespace, '$.containers.series').representationKind, 'list');
  assert.equal(bindingAt(namespace, '$.containers.pair').representationKind, 'tuple');
  const node = bindingAt(namespace, '$.containers.nodeValue');
  assert.equal(node.representationKind, 'node');
  assert.equal(node.nodeTag, 'tag');

  const annotated = bindingAt(namespace, '$.annotated');
  assert.equal(annotated.identity, 'ROOT');
  const meta = bindingAt(namespace, '$.annotated.@.meta');
  assert.equal(meta.identity, 'META');
  assert.equal(meta.value, 'source');
  const deep = bindingAt(namespace, '$.annotated.@.meta.@.deep');
  assert.equal(deep.identity, 'DEEP');
  assert.equal(deep.value, '3');
  assert.equal(deep.numericLexeme, '3');
  assert.equal(namespace.parent?.(deep), meta.attributeSpace);
});

test('requires explicit opt-in for native JavaScript number materialization', () => {
  const { namespace } = readAeonNamespace(VALUE_FAMILIES_SOURCE, {
    compile: { datatypePolicy: 'allow_custom', maxAttributeDepth: 8 },
    namespace: { numericMaterialization: 'native' },
  });

  const previous = bindingAt(namespace, '$.types.previous');
  const precise = bindingAt(namespace, '$.types.precise');
  assert.equal(previous.value, 9007199254740992);
  assert.equal(precise.value, 9007199254740992);
  assert.equal(previous.numericLexeme, '9007199254740992');
  assert.equal(precise.numericLexeme, '9007199254740993');
});

test('rejects event streams whose selected scope is not parent-first', () => {
  const compiled = readAeon('outer = { inner = 1 }');
  const reversed = [...compiled.compile.events].reverse();

  assert.throws(
    () => createAeonNamespace(reversed),
    /has no parent binding/u,
  );
});
