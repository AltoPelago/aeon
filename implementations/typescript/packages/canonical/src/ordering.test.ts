import assert from 'node:assert/strict';
import test from 'node:test';
import { emitEvents, resolvePaths, validateReferences, adaptTypeScriptAssignmentEventsToPortableAes } from '@altopelago/aeon-aes';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { canonicalize } from './index.js';
import { compareScalarKeys, referenceSafeOrders, reorderDocument } from './ordering.js';

const options = { ordering: 'reference-safe-v1' as const, maxAttributeDepth: 2 };

function document(source: string) {
    const lex = tokenize(source);
    assert.deepEqual(lex.errors, []);
    const result = parse(lex.tokens, { maxAttributeDepth: 2 });
    assert.deepEqual(result.errors, []);
    assert.ok(result.document);
    return result.document;
}

function semanticGraph(source: string) {
    const parsed = document(source);
    const emitted = emitEvents(resolvePaths(parsed, { indexedPaths: true }));
    assert.deepEqual(emitted.errors, []);
    assert.deepEqual(validateReferences(emitted.events, { maxAttributeDepth: 2 }).errors, []);
    // Spans/origins and event sequence order are formatting, not identity.
    // Include an authored header, but do not compare an inserted default header.
    const portable = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, { includeHeaders: true }).events;
    return portable.map(({ span: _span, origin: _origin, ...entry }) => entry)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const scenarios = [
    'd=3\nc=2\nb=~c\na=1',
    'z={leaf=1}\ny={z={leaf=2},b={d={copy=~y.z.leaf},c={copy=~z.leaf}}}\na=~y.b.d.copy',
    'z={leaf=1}\ny={z={leaf=2},b={d={copy=~y},c={copy=~y.b}}}\na=~y.b.d.copy',
    'z=1\na@{d=~z,c=0}={b@{d=~z,c=0}=0}',
    'outer={a=1,c=2,d=3,b=~outer.c}',
    'z={v=1}\na={z=0,b=~z.v,a=0}',
    'z=1\na@{z=0,b=~z,a=0}=0',
    'z=1\na=<tag@{d=~>z,c=0}({b=~z})>',
    'a@{z=1,b=~a.@.z}=~>a.@.b',
    'a@{z@{x=1}=~a.@.z.@.x,b=~a.@.z}=0',
    'a=[@{z={leaf=1}}=~a[0].@.z.leaf,2]\nb=~a[1]',
    'a=(@{z=1}=~>a[0].@.z,2)\nb=~a[1]',
    'a=<tag(@{z=1}=~a[0].@.z,2)>\nb=~a[1]',
    '"literal.@key"={"z.z"=1,b=~["literal.@key"].["z.z"]}\na=~["literal.@key"].b',
    'aeon:header={z=1,b=~["aeon:z"]}\na=~["aeon:b"]',
    'aeon:version=2.0\n"aeon:version"@{z=2}=7\na=~["aeon:version"].@.z',
    'z\\TARGET\\@{meta\\META\\=1}=<tag\\HEAD\\@{x=2}>\na\\REF\\=~>z.@.meta',
    'a=|~missing|\nb="~missing"\nc=^~missing\nd=$.missing',
    'a:custom=|yes|\nb:prose=>`line\nnext`\nc=2024-02-29T23:59:60.1234567890123',
];

for (const source of scenarios) {
    test(`reference-safe graph and fixed point: ${source}`, () => {
        // An explicit empty header makes semantic comparison independent of
        // the permitted default-header insertion.
        const authored = source.startsWith('aeon:') ? source : `aeon:header={}\n${source}`;
        const result = canonicalize(authored, options);
        assert.deepEqual(result.errors, []);
        assert.equal(canonicalize(result.text, options).text, result.text);
        assert.deepEqual(semanticGraph(result.text), semanticGraph(authored));
    });
}

test('reconsiders eligibility after each emission and projects through containing scopes', () => {
    const result = canonicalize(scenarios[0]!, options);
    assert.deepEqual(document(result.text).bindings.map(binding => binding.key), ['a', 'c', 'b', 'd']);
    const nested = canonicalize(scenarios[1]!, options);
    assert.deepEqual(document(nested.text).bindings.map(binding => binding.key), ['z', 'y', 'a']);
});

for (const source of [
    'aeon:header={x={leaf=1}}\n"aeon:x"=2\ncopy=~["aeon:x"].leaf',
    'aeon:header={x={leaf=1}}\n"aeon:x"=2\na=~>["aeon:x"].leaf',
    'aeon:header={x={branch={leaf=1}}}\n"aeon:x"={branch=2}\na=~["aeon:x"].branch.leaf',
    'aeon:header={x={leaf@{meta=1}=2}}\n"aeon:x"=0\na=~["aeon:x"].leaf.@.meta',
    'aeon:header={x=[{leaf=1}]}\n"aeon:x"=0\na=~["aeon:x"][0].leaf',
    'aeon:header={x=({leaf=1})}\n"aeon:x"=0\na=~>["aeon:x"][0].leaf',
    'aeon:header={x=<tag({leaf=1})>}\n"aeon:x"=0\na=~["aeon:x"][0].leaf',
    'aeon:header={x=[@{meta=1}=2]}\n"aeon:x"=0\na=~["aeon:x"][0].@.meta',
    'aeon:header={x={"literal.@leaf"@{"z.z"=1}=2}}\n"aeon:x"=0\na=~["aeon:x"].["literal.@leaf"].@.["z.z"]',
    'aeon:header={z={leaf=1},b=~["aeon:z"].leaf}\n"aeon:z"=2',
    'aeon:header={x={leaf=1}}\na=<tag@{meta=~["aeon:x"].leaf}>\n"aeon:x"=0',
] as const) {
    test(`partial header collision preserves independent payloads: ${source}`, () => {
        const result = canonicalize(source, options);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(semanticGraph(result.text), semanticGraph(source));
        assert.equal(canonicalize(result.text, options).text, result.text);
        if (source.includes('\na=')) {
            // The header descendant is already available. Its shadowed root
            // body binding must not become an invented local predecessor.
            assert.deepEqual(document(result.text).bindings.map(binding => binding.key), ['a', 'aeon:x']);
        }
        if (source.startsWith('aeon:header={z=')) {
            assert.deepEqual(document(result.text).header!.bindings.map(binding => binding.key), ['z', 'b']);
        }
    });
}

test('exact descendant collisions select the body payload and its metadata', () => {
    const source = 'aeon:header={x={leaf@{meta=1}=2}}\n"aeon:x"={leaf@{meta=3}=4}\na=~["aeon:x"].leaf.@.meta';
    const result = canonicalize(source, options);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(document(result.text).bindings.map(binding => binding.key), ['aeon:x', 'a']);
    assert.deepEqual(semanticGraph(result.text), semanticGraph(source));
    assert.equal(canonicalize(result.text, options).text, result.text);
});

test('partial-collision shape matrix matches Core exact-path ownership', () => {
    const headers = [
        { source: 'x@{root={leaf=1}}={leaf@{meta=2}={deep=3}}', paths: ['', '.@.root.leaf', '.leaf', '.leaf.@.meta', '.leaf.deep'] },
        { source: 'x=[@{meta=1}={leaf=2},3]', paths: ['', '[0]', '[0].@.meta', '[0].leaf', '[1]'] },
        { source: 'x=(@{meta=1}={leaf=2},3)', paths: ['', '[0]', '[0].@.meta', '[0].leaf', '[1]'] },
        { source: 'x=<tag(@{meta=1}={leaf=2},3)>', paths: ['', '[0]', '[0].@.meta', '[0].leaf', '[1]'] },
    ];
    const bodies = ['0', '{}', '{leaf=0}', '{leaf@{meta=9}=0}', '{leaf={deep=9}}', '[]', '[0]', '({leaf=0})', '<tag(0)>'];
    let checked = 0;
    for (const header of headers) for (const body of bodies) for (const suffix of header.paths) for (const marker of ['~', '~>']) {
        const source = `aeon:header={${header.source}}\n"aeon:x"=${body}\na=${marker}["aeon:x"]${suffix}`;
        const emitted = emitEvents(resolvePaths(document(source), { indexedPaths: true }));
        assert.deepEqual(emitted.errors, []);
        const errors = validateReferences(emitted.events, { maxAttributeDepth: 2 }).errors;
        const result = canonicalize(source, options);
        assert.deepEqual(result.errors.map(error => error.code), errors.map(error => error.code), source);
        if (errors.length === 0) {
            assert.deepEqual(semanticGraph(result.text), semanticGraph(source), source);
            assert.equal(canonicalize(result.text, options).text, result.text, source);
        } else {
            assert.equal(result.text, '', source);
        }
        checked += 1;
    }
    assert.equal(checked, 360);
});

test('historical bytes remain the explicit default during staged rollout', () => {
    const source = 'z=1\na=~z';
    const historical = canonicalize(source);
    assert.deepEqual(historical, canonicalize(source, { ordering: 'lexical-v1' }));
    assert.deepEqual(document(historical.text).bindings.map(binding => binding.key), ['a', 'z']);
    assert.deepEqual(document(canonicalize(source, options).text).bindings.map(binding => binding.key), ['z', 'a']);
});

test('opt-in attributed container heads have exactly one space after equals', () => {
    for (const source of ['a=[@{m=1}={z=0}]', 'a=(@{m=1}={z=0})', 'a=<tag(@{m=1}={z=0})>']) {
        const authored = `aeon:header={}\n${source}`;
        const result = canonicalize(authored, options);
        assert.deepEqual(result.errors, []);
        assert.match(result.text, /@\{m = 1\} = \{/);
        assert.doesNotMatch(result.text, /@\{m = 1\} =  +\{/);
        assert.equal(canonicalize(result.text, options).text, result.text);
        assert.deepEqual(semanticGraph(result.text), semanticGraph(authored));
        // The old contract remains byte-for-byte unchanged.
        assert.match(canonicalize(source).text, /@\{m = 1\} =  +\{/);
    }
});

for (const [source, code] of [
    ['z=~a\na=7', 'FORWARD_REFERENCE'],
    ['a={b=~a.z,z=1}', 'FORWARD_REFERENCE'],
    ['a@{b=~a.@.z,z=1}=0', 'FORWARD_REFERENCE'],
    ['a=~missing', 'MISSING_REFERENCE_TARGET'],
    ['a=~a', 'SELF_REFERENCE'],
    ['a@{x=~a}=0', 'SELF_REFERENCE'],
    ['a=~["aeon:version"]', 'MISSING_REFERENCE_TARGET'],
    ['a=<tag@{z=1}>\nb=~a.@.z', 'MISSING_REFERENCE_TARGET'],
    ['aeon:version=1\na=~["aeon:version"]\n"aeon:version"=2', 'FORWARD_REFERENCE'],
    ['aeon:header={version@{z=1}=1}\n"aeon:version"=2\na=~["aeon:version"].@.z', 'MISSING_REFERENCE_TARGET'],
    ['aeon:header={x@{hidden=1}={leaf=2}}\n"aeon:x"=0\na=~["aeon:x"].@.hidden', 'MISSING_REFERENCE_TARGET'],
    ['aeon:header={x@{meta={leaf=1}}=0}\n"aeon:x"=2\na=~["aeon:x"].@.meta.leaf', 'MISSING_REFERENCE_TARGET'],
    ['aeon:header={x={leaf@{hidden=1}={deep=2}}}\n"aeon:x"={leaf=0}\na=~["aeon:x"].leaf.@.hidden', 'MISSING_REFERENCE_TARGET'],
    ['aeon:header={x={leaf=1}}\na=~["aeon:x"].leaf\n"aeon:x"={leaf=2}', 'FORWARD_REFERENCE'],
] as const) {
    test(`rejects authored references without repair: ${source}`, () => {
        const result = canonicalize(source, options);
        assert.equal(result.text, '');
        assert.deepEqual(result.errors.map(error => error.code), [code]);
    });
}

test('metadata depth is consumer-selected and remains enforced', () => {
    const source = 'a@{z@{x=1}=1,b=~a.@.z.@.x}=0';
    assert.ok(canonicalize(source, { ordering: 'reference-safe-v1' }).errors.length > 0);
    assert.deepEqual(canonicalize(source, options).errors, []);
});

test('dependency edge budget fails closed and deduplicates shared predecessors', () => {
    assert.deepEqual(canonicalize('z=1\na={b=~z,c=~>z}', { ...options, maxOrderingEdges: 1 }).errors, []);
    assert.deepEqual(canonicalize('z=1\na=0', { ...options, maxOrderingEdges: 0 }).errors, []);
    for (const [source, limit] of [['z=1\na=~z', 0], ['z=1\na=~z\nb=~z', 1], ['outer={z=1,b=~outer.z}', 0]] as const) {
        const result = canonicalize(source, { ...options, maxOrderingEdges: limit });
        assert.equal(result.text, '');
        assert.deepEqual(result.errors.map(error => error.code), ['CANONICAL_ORDERING_LIMIT_EXCEEDED']);
    }
    for (const limit of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const result = canonicalize('a=1', { ...options, maxOrderingEdges: limit });
        assert.equal(result.text, '');
        assert.deepEqual(result.errors.map(error => error.code), ['CANONICAL_ORDERING_INVALID_OPTION']);
    }
    const invalid = canonicalize('a=1', { ordering: 'unknown' as never });
    assert.equal(invalid.text, '');
    assert.equal(invalid.errors[0]?.code, 'CANONICAL_ORDERING_INVALID_OPTION');
});

test('Unicode scalar ordering differs from UTF-16 without case or composition normalization', () => {
    const keys = ['😀', '\uE000', 'é', 'e\u0301', 'a', 'A', 'aa'];
    const expected = ['A', 'a', 'aa', 'e\u0301', 'é', '\uE000', '😀'];
    assert.deepEqual([...keys].sort(compareScalarKeys), expected);
    const source = keys.map(key => `${JSON.stringify(key)}=0`).join('\n');
    const result = canonicalize(source, options);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(document(result.text).bindings.map(binding => binding.key), expected);
    assert.equal(canonicalize(result.text, options).text, result.text);
});

test('ordering copies rather than mutates the authored AST', () => {
    const parsed = document('z=1\na@{z=1,b=~a.@.z}={z=1,b=~a.z}');
    const before = JSON.stringify(parsed, (_, value: unknown) => value instanceof Map ? [...value] : value);
    const ordered = reorderDocument(parsed, referenceSafeOrders(parsed, 100));
    assert.notEqual(ordered, parsed);
    assert.equal(JSON.stringify(parsed, (_, value: unknown) => value instanceof Map ? [...value] : value), before);
    assert.throws(() => reorderDocument(parsed, new Map()), { code: 'CANONICAL_ORDERING_CONFLICT' });
});

for (const character of ['\n', '\r', '\t', '\0', '\u000b', '\u001f', '"', '\\', '😀']) {
    test(`reference-safe selectors preserve escaped key content: ${JSON.stringify(character)}`, () => {
        const key = JSON.stringify(`z${character}key`);
        for (const source of [
            `${key}=1\na=~[${key}]`,
            `holder@{${key}=1}=0\na=~>holder.@.[${key}]`,
            `holder@{meta={${key}=1,a=~holder.@.meta.[${key}]}}=0`,
            `${key}=1\na=<tag@{meta=~>[${key}]}(~[${key}])>`,
            `${key}=1\na=[@{meta=~[${key}]}=(~>[${key}])]`,
        ]) {
            const authored = `aeon:header={}\n${source}`;
            const result = canonicalize(authored, options);
            assert.deepEqual(result.errors, [], source);
            assert.deepEqual(semanticGraph(result.text), semanticGraph(authored), source);
            assert.equal(canonicalize(result.text, options).text, result.text, source);
        }
    });
}

test('reference selector escape correction does not change the historical contract', () => {
    const source = '"z\\nkey"=1\na=~["z\\nkey"]';
    assert.ok(canonicalize(source).text.includes('~["z\nkey"]'));
    assert.ok(canonicalize(source, options).text.includes('~["z\\nkey"]'));
});

function permutations<T>(entries: readonly T[]): T[][] {
    return entries.length === 0 ? [[]] : entries.flatMap((entry, index) =>
        permutations(entries.filter((_, i) => i !== index)).map(rest => [entry, ...rest]));
}

test('exhaustive four-entry DAG permutations converge to the smallest legal order', () => {
    const keys = ['d', 'c', 'b', 'a'];
    const possibleEdges = keys.flatMap((key, index) => keys.slice(0, index).map(target => [key, target] as const));
    const orders = permutations(keys).sort((a, b) => a.join('').localeCompare(b.join('')));
    let checked = 0;
    for (let mask = 0; mask < 1 << possibleEdges.length; mask += 1) {
        const edges = possibleEdges.filter((_, index) => (mask & (1 << index)) !== 0);
        // Independent oracle: enumerate all legal permutations, then choose
        // their lexicographic minimum, without using the production heap/graph.
        const legal = orders.filter(order => edges.every(([source, target]) => order.indexOf(target) < order.indexOf(source)));
        const expectedOrder = legal[0]!;
        let canonical: string | undefined;
        for (const order of legal) {
            const source = order.map(key => {
                const targets = edges.filter(([source]) => source === key).map(([, target]) => `~${target}`);
                return `${key}=${targets.length === 0 ? '0' : `[${targets.join(',')}]`}`;
            }).join('\n');
            const result = canonicalize(source, options);
            assert.deepEqual(result.errors, [], source);
            assert.deepEqual(document(result.text).bindings.map(binding => binding.key), expectedOrder, source);
            if (canonical !== undefined) assert.equal(result.text, canonical, source);
            canonical = result.text;
            checked += 1;
        }
        assert.equal(canonicalize(canonical!, options).text, canonical);
    }
    assert.equal(checked, 315);
});
