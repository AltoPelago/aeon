import test from 'node:test';
import assert from 'node:assert/strict';
import datatypeNames from '../../../../../test-fixtures/radix-datatype-names.json' with { type: 'json' };
import { evaluateQuery, parseAddress, planMutation, resolveAddress, validateMutationPlanTarget } from '@altopelago/sansa';
import { readAeon } from './index.js';
import {
  createAeonNamespace,
  readAeonNamespace,
  type AeonSansaBinding,
  type AeonSansaNamespace,
} from './sansa.js';

test('SDK dependency preserves identity bindings with decimal numeric qualifiers', () => {
  const namespace = readAeonNamespace(String.raw`value\x\=1`).namespace;
  const selected = resolveAddress('$.value', namespace).bindings[0];
  assert.ok(selected);
  for (const decimal of ['0.0000001', '-0.0000001', '1000000000000000000000']) {
    const source = '$.\\x\\:Q[' + decimal + ']';
    const parsed = parseAddress(source);
    assert.equal(parsed.ok, true);
    for (const input of [source, parsed.address!]) {
      const result = resolveAddress(input, namespace);
      assert.equal(result.ok, true);
      assert.deepEqual(result.bindings, [selected]);
      assert.equal(result.bindings[0], selected);
    }
    const query = evaluateQuery('from ' + source + '\nselect .', namespace);
    assert.equal(query.ok, true);
    assert.equal(query.results[0]?.binding, selected);
  }
});

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
  stage:symbol = |approved|
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

test('radix metadata resolves exact integral decimals without rounding fractions', () => {
  for (const [literal, base] of [['2.00', 2], ['2e0', 2], ['20e-1', 2], ['2.0000000000000001', undefined]] as const) {
    const { namespace } = readAeonNamespace(`mask:radix[${literal}]=%1`);
    assert.equal(bindingAt(namespace, '$.mask').radixBase, base);
  }
});

test('radix metadata does not assign reserved semantics to mixed-case custom names', () => {
  for (const { datatype, base } of datatypeNames) {
    const { namespace } = readAeonNamespace(`mask:${datatype}=%1`);
    assert.equal(bindingAt(namespace, '$.mask').radixBase, base ?? undefined, datatype);
  }
});

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

test('prefixes reference targets with their namespace plane in full scope', () => {
  const { compile } = readAeon('target = 1\ncopy = ~target');
  const full = createAeonNamespace(compile.events, { scope: 'full' });

  assert.deepEqual(bindingAt(full, '$.body.copy').value, {
    type: 'CloneReference',
    path: '$.body.target',
    canonical: '~$.body.target',
  });
});

test('infers WTC metadata for an untyped temporal context claim', () => {
  const { namespace } = readAeonNamespace('world = 2026-07-25T09:30:00Z&Australia/Melbourne');
  const world = bindingAt(namespace, '$.world');

  assert.equal(world.semanticType, 'wtc');
  assert.equal(world.representationKind, 'WTCDateTimeLiteral');
  assert.equal(world.scalarKind, 'wtc');
});

test('shared Query and target validation accept Core calendar/clock payloads', () => {
  for (const [family, payload] of [
    ['wtc', '2024-T10:&Europe'],
    ['datetime', '2024-02T10Z'],
    ['datetime', '2024-T10:'],
    ['time', '23:55:60.123456789012345678900Z'],
    ['datetime', '2024-02T10:11:60.123456789012345678900'],
    ['wtc', '2024-T10:11:12.000&local'],
    ['wtc', '2024-02T10:+05:30&Europe'],
  ] as const) {
    const { namespace } = readAeonNamespace(`value = ${payload}\n`);
    const binding = bindingAt(namespace, '$.value');
    assert.equal(binding.scalarKind, family, payload);
    assert.equal(binding.value, payload);
    const query = evaluateQuery(`from $.value select ${payload}`, namespace);
    if (!query.ok) assert.fail(JSON.stringify(query.errors));
    assert.deepEqual(query.results[0]?.value, { type: 'scalar', value: payload });
    if (family === 'datetime' || family === 'wtc') {
      const relation = evaluateQuery(`from $.value select temporalRelation(., ${payload})`, namespace);
      if (!relation.ok) assert.fail(JSON.stringify(relation.errors));
      assert.deepEqual(relation.results[0]?.value, { type: 'scalar', value: 'incomparable' });
    }
    const planned = planMutation({ op: 'replace', target: '$.value', value: payload, datatype: family }, namespace);
    if (!planned.ok) assert.fail(JSON.stringify(planned.errors));
    assert.equal(validateMutationPlanTarget(planned.plan, 'aeon').ok, true, payload);
    assert.equal(validateMutationPlanTarget(planned.plan, 'json').ok, false, payload);
    assert.equal(binding.value, payload);
  }
});

test('shared temporal target validation still rejects malformed descriptors', () => {
  const { namespace } = readAeonNamespace('value = 1\n');
  for (const [family, payload] of [
    ['datetime', '2024--T10:'],
    ['datetime', '2024-02T10::20'],
    ['wtc', '2024-T10:&Europe//comment'],
    ['wtc', '2024-T10:&Local'],
    ['datetime', '2024-02T10Z '],
  ] as const) {
    const planned = planMutation({ op: 'replace', target: '$.value', value: payload, datatype: family }, namespace);
    if (!planned.ok) assert.fail(JSON.stringify(planned.errors));
    const validation = validateMutationPlanTarget(planned.plan, 'aeon');
    assert.equal(validation.ok, false, payload);
    assert.equal(validation.errors[0]?.code, 'SANSA_MUTATE_TARGET_UNSUPPORTED_VALUE');
  }
});

test('portable temporal and symbolic bindings retain non-string Query semantics', () => {
  const { namespace } = readAeonNamespace(`
day = 2024-02-29
clock = 10:20:30Z
stamp = 2024-02-29T10:20:30Z
world = 2024-02-29T10:20:30Z&Europe
status = |approved|
`);
  const relations = evaluateQuery(`from $ select {
    day = temporalRelation($.day, 2024-02-29)
    clock = temporalRelation($.clock, 10:20:30Z)
    stamp = temporalRelation($.stamp, 2024-02-29T10:20:30Z)
    world = temporalRelation($.world, 2024-02-29T10:20:30Z&Europe)
  }`, namespace);
  if (!relations.ok) assert.fail(JSON.stringify(relations.errors));
  assert.deepEqual(relations.results[0]?.value, {
    type: 'object', value: { day: 'equal', clock: 'equal', stamp: 'equal', world: 'equal' },
  });
  const symbol = evaluateQuery('from $.status where . == |approved| select .', namespace);
  if (!symbol.ok) assert.fail(JSON.stringify(symbol.errors));
  assert.equal(symbol.results.length, 1);
  for (const source of [
    'from $.day where . == "2024-02-29" select .',
    'from $.status where . == "approved" select .',
    'from $.status select lower(.)',
  ]) {
    assert.equal(evaluateQuery(source, namespace).ok, false, source);
  }
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
  assert.equal(price.representationKind, 'RadixLiteral');
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
    ['ToggleLiteral', 'yes'],
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
  assert.deepEqual(
    [
      bindingAt(namespace, '$.types.stage').semanticType,
      bindingAt(namespace, '$.types.stage').representationKind,
      bindingAt(namespace, '$.types.stage').scalarKind,
      bindingAt(namespace, '$.types.stage').value,
    ],
    ['symbol', 'SymbolicLiteral', 'symbol', 'approved'],
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
    path: '$.target',
    canonical: '~$.target',
  });
  assert.deepEqual(bindingAt(namespace, '$.targetPointer').value, {
    type: 'PointerReference',
    path: '$.target',
    canonical: '~>$.target',
  });
  assert.equal(bindingAt(namespace, '$.containers.series').representationKind, 'ListNode');
  assert.equal(bindingAt(namespace, '$.containers.pair').representationKind, 'TupleLiteral');
  const node = bindingAt(namespace, '$.containers.nodeValue');
  assert.equal(node.representationKind, 'NodeLiteral');
  assert.equal(node.nodeTag, 'tag');
  const head = bindingAt(namespace, '$.containers.nodeValue[0]');
  assert.equal(head.representationKind, 'NodeHead');
  assert.equal(head.nodeTag, 'tag');
  assert.equal(head.value, 'tag');
  assert.equal(bindingAt(namespace, '$.containers.nodeValue[0][0]').value, 'hello');

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

test('separates binding, node-head, and content metadata in portable topology', () => {
  const source = String.raw`value\BINDING\@{keyMeta\KEY_META\ = "outer"} = <tag\HEAD\@{role\ROLE\ = "button"}:node(\CHILD\ = "hello")>`;
  const { namespace } = readAeonNamespace(source, { compile: { maxAttributeDepth: 8 } });

  const node = bindingAt(namespace, '$.value');
  assert.equal(node.identity, 'BINDING');
  assert.equal(node.representationKind, 'NodeLiteral');
  assert.equal(bindingAt(namespace, '$.value.@.keyMeta').identity, 'KEY_META');

  const head = bindingAt(namespace, '$.value[0]');
  assert.equal(head.identity, 'HEAD');
  assert.equal(head.representationKind, 'NodeHead');
  assert.equal(head.datatype, 'node');
  assert.equal(head.value, 'tag');
  assert.equal(bindingAt(namespace, '$.value[0].@.role').identity, 'ROLE');

  const content = bindingAt(namespace, '$.value[0][0]');
  assert.equal(content.identity, 'CHILD');
  assert.equal(content.value, 'hello');
});

test('resolves explicit node heads and translates references across their portable level', () => {
  const { namespace } = readAeonNamespace(String.raw`value = <tag("first", "second")>
copy = ~value[0]`);

  const head = resolveAddress('$.value[0]%NodeHead', namespace);
  assert.equal(head.ok, true);
  if (!head.ok) return;
  assert.equal(head.bindings.length, 1);
  assert.equal(head.bindings[0]?.value, 'tag');

  assert.deepEqual(bindingAt(namespace, '$.copy').value, {
    type: 'CloneReference',
    path: '$.value[0][0]',
    canonical: '~$.value[0][0]',
  });
});

test('translates references into node-valued attribute content', () => {
  const { namespace } = readAeonNamespace('a@{x = <tag("child")>} = 1\ncopy = ~a.@.x[0]');

  assert.deepEqual(bindingAt(namespace, '$.copy').value, {
    type: 'CloneReference',
    path: '$.a.@.x[0][0]',
    canonical: '~$.a.@.x[0][0]',
  });
  assert.equal(bindingAt(namespace, '$.a.@.x[0][0]').value, 'child');
});

test('derives portable provenance from exact source text', () => {
  const source = 'a = "😀"';
  const { namespace } = readAeonNamespace(source);
  const binding = bindingAt(namespace, '$.a');

  assert.match(binding.origin ?? '', /^sha256:[0-9a-f]{64}$/u);
  assert.equal(binding.span, '0:10');

  const { compile } = readAeon(source);
  assert.equal(bindingAt(createAeonNamespace(compile.events), '$.a').origin, undefined);
  const explicit = bindingAt(createAeonNamespace(compile.events, {
    sourceBytes: new TextEncoder().encode(source),
  }), '$.a');
  assert.equal(explicit.origin, binding.origin);
  assert.equal(explicit.span, binding.span);
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

test('child identities resolve to original bindings and current structural paths', () => {
  const { namespace } = readAeonNamespace("group\\g\\ = { items = [\\a\\=1, \\b\\=2] }");
  assert.equal(namespace.identity?.(bindingAt(namespace, '$.group')), 'g');
  const result = resolveAddress("$.\\g\\.items.\\a\\", namespace);
  assert.equal(result.ok, true);
  assert.equal(result.bindings[0], bindingAt(namespace, '$.group.items[0]'));
  assert.equal(result.bindings[0]?.address, '$.group.items[0]');
  assert.equal(resolveAddress("$.\\a\\", namespace).bindings.length, 0);
  assert.equal(resolveAddress("$.\\g\\.items.\\missing\\", namespace).bindings.length, 0);
});

test('child identity selection observes reorders without equating snapshots', () => {
  const before = readAeonNamespace("items=[\\a\\=1, \\b\\=2]").namespace;
  const after = readAeonNamespace("items=[\\b\\=2, \\a\\=1]").namespace;
  const first = resolveAddress("$.items.\\a\\", before).bindings[0]!;
  const moved = resolveAddress("$.items.\\a\\", after).bindings[0]!;
  assert.equal(first.address, '$.items[0]');
  assert.equal(moved.address, '$.items[1]');
  assert.notEqual(first, moved);
  assert.equal(first.value, moved.value);
  const removed = readAeonNamespace("items=[\\b\\=2]").namespace;
  assert.equal(resolveAddress("$.items.\\a\\", removed).bindings.length, 0);
});

test('child identities preserve explicit attribute navigation and plane scope', () => {
  const { namespace } = readAeonNamespace(INVENTORY_SOURCE);
  const source = resolveAddress("$.\\INVENTORY\\.@.\\SOURCE\\", namespace);
  assert.equal(source.ok, true);
  assert.equal(source.bindings[0], bindingAt(namespace, '$.inventory.@.source'));
  assert.equal(resolveAddress("$.\\SOURCE\\", namespace).bindings.length, 0);
  const input = "aeon:header={value\\head\\=1}\n\"aeon:value\"\\body\\=2";
  for (const scope of ['header', 'payload', 'full'] as const) {
    const scoped = readAeonNamespace(input, { namespace: { scope } }).namespace;
    if (scope === 'full') {
      assert.equal(resolveAddress("$.header.\\head\\", scoped).bindings.length, 1);
      assert.equal(resolveAddress("$.body.\\body\\", scoped).bindings.length, 1);
      assert.equal(resolveAddress("$.\\head\\", scoped).bindings.length, 0);
    } else {
      assert.equal(resolveAddress(scope === 'header' ? "$.\\head\\" : "$.\\body\\", scoped).bindings.length, 1);
      assert.equal(resolveAddress(scope === 'header' ? "$.\\body\\" : "$.\\head\\", scoped).bindings.length, 0);
    }
  }
});

test('SDK identity accessor preserves logical inspection and binding limits', () => {
  const original = readAeonNamespace("items=[\\a\\=1, \\b\\=2]").namespace;
  let calls = 0;
  const namespace = { ...original, identity: (binding: AeonSansaBinding) => { calls += 1; return original.identity!(binding); } };
  const address = "$.items.\\a\\";
  const limited = resolveAddress(address, namespace, { maxIdentityInspections: 1 });
  assert.equal(limited.ok, false);
  assert.equal(limited.errors[0]?.code, 'SANSA_RESOLVE_IDENTITY_LIMIT_EXCEEDED');
  assert.equal(limited.errors[0]?.limit, 1);
  assert.equal(limited.errors[0]?.observed, 2);
  assert.deepEqual(limited.bindings, []);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(resolveAddress(address, namespace, { maxIdentityInspections: 2 }).ok, true);
  assert.equal(calls, 2);
  const zero = resolveAddress(address, namespace, { maxBindings: 0 });
  assert.equal(zero.ok, false);
  assert.deepEqual(zero.bindings, []);
  assert.equal(zero.errors[0]?.code, 'SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED');
});

test('SDK admits Query identity while activation and mutation remain guarded', () => {
  const original = readAeonNamespace("items=[\\a\\=1]\nselector:sansa=$.items.\\a\\").namespace;
  let calls = 0;
  const namespace = { ...original, identity: (binding: AeonSansaBinding) => { calls += 1; return original.identity!(binding); } };
  const queries = [
    ['from $.selector\nselect path(.)', { addressActivation: 'trusted' as const }],
  ] as const;
  for (const [query, options] of queries) {
    const result = evaluateQuery(query, namespace, options);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, 'SANSA_RESOLVE_UNSUPPORTED_SELECTOR');
  }
  assert.equal(planMutation({ op: 'remove', target: "$.items.\\a\\" }, namespace).ok, false);
  assert.equal(calls, 0);
  const selected = evaluateQuery('from $.items.\\a\\\nselect .', namespace);
  assert.equal(selected.ok, true);
  assert.equal(selected.results[0]?.binding, bindingAt(namespace, '$.items[0]'));
  assert.equal(selected.results[0]?.candidateAddress, '$.items[0]');
  assert.equal(selected.results[0]?.valueAddress, '$.items[0]');
  assert.equal(calls, 1);

});

test('SDK identity selection fails closed on duplicate and malformed adapter metadata', () => {
  const namespace = readAeonNamespace('items=[\\a\\=1, \\b\\=2]').namespace;
  const second = bindingAt(namespace, '$.items[1]');
  second.identity = 'a';
  const ambiguous = resolveAddress('$.items.\\a\\', namespace);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.errors[0]?.code, 'SANSA_RESOLVE_AMBIGUOUS_IDENTITY');
  assert.equal(ambiguous.errors[0]?.identity, 'a');
  assert.deepEqual(ambiguous.bindings, []);
  second.identity = 'bad!';
  const malformed = resolveAddress('$.items.\\a\\', namespace);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.errors[0]?.code, 'SANSA_RESOLVE_INVALID_IDENTITY');
  assert.deepEqual(malformed.bindings, []);
});

test('SDK identities distinguish binding, exposed node head and content occurrences', () => {
  const namespace = readAeonNamespace(String.raw`value\BINDING\ = <tag\HEAD\:node(\CHILD\ = "hello")>`).namespace;
  for (const [selector, path] of [
    ['$.\\BINDING\\', '$.value'],
    ['$.\\BINDING\\.\\HEAD\\', '$.value[0]'],
    ['$.\\BINDING\\.\\HEAD\\.\\CHILD\\', '$.value[0][0]'],
  ]) {
    const result = resolveAddress(selector!, namespace);
    assert.equal(result.ok, true);
    assert.equal(result.bindings[0], bindingAt(namespace, path!));
  }
  assert.equal(resolveAddress('$.\\HEAD\\', namespace).bindings.length, 0);
  const contextual = bindingAt(namespace, '$.value[0]');
  assert.equal(resolveAddress('?.\\HEAD\\', namespace, { contextualRoot: contextual }).bindings.length, 0);
  assert.equal(resolveAddress('?.\\CHILD\\', namespace, { contextualRoot: contextual }).bindings[0], bindingAt(namespace, '$.value[0][0]'));
});

test('SDK constrained identity activation requires a proven parent grant', () => {
  const original = readAeonNamespace('items=[\\a\\={name\\n\\="hello"}]\nselector:sansa=$.items.\\a\\.\\n\\').namespace;
  let calls = 0;
  const namespace = {...original, identity:(b:AeonSansaBinding)=>{calls++;return original.identity!(b);}};
  const query = 'from $\nselect path($.selector)';
  const addressActivation = {allowedRoots:['$.items'],allowedSelectors:['member','childIdentity'] as const};
  const r = evaluateQuery(query,namespace,{addressActivation,resolve:{maxIdentityInspections:2}});
  assert.equal(r.ok,true);
  assert.equal(r.results[0]?.value.type,'bindingSet');
  if(r.results[0]?.value.type==='bindingSet')assert.equal(r.results[0].value.bindings[0],bindingAt(namespace,'$.items[0].name'));
  assert.equal(calls,2);
  calls=0;
  const denied = evaluateQuery(query,namespace,{addressActivation:{...addressActivation,allowedRoots:['$.items[0]']}});
  assert.equal(denied.ok,false);assert.equal(denied.errors[0]?.code,'SANSA_QUERY_PATH_ACTIVATION_DENIED');assert.equal(calls,0);
});
