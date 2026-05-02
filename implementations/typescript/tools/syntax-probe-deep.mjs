/**
 * Deep probe on the most interesting findings from the initial scan.
 * Focus: object-level attributes, duplicate attr keys, header ordering.
 */

import { tokenize } from '../packages/lexer/dist/index.js';
import { parse } from '../packages/parser/dist/index.js';

function probe(label, input, options = {}) {
    const { tokens, errors: lexErrors } = tokenize(input);
    const filtered = tokens.filter(t => t.type !== 'Newline' && t.type !== 'LineComment' && t.type !== 'BlockComment');
    const { document, errors: parseErrors } = parse(filtered, options);
    const allErrors = [...lexErrors, ...parseErrors];
    const passed = allErrors.length === 0 && document !== null;
    return { label, input, passed, errors: allErrors, document };
}

function show(r) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.label}`);
    console.log(`   Input: ${JSON.stringify(r.input)}`);
    if (!r.passed) {
        console.log(`   Errors: ${r.errors.map(e => e.message).join('; ')}`);
    } else {
        // Show structural detail
        const doc = r.document;
        if (doc?.bindings?.length) {
            for (const b of doc.bindings) {
                const val = b.value;
                if (val.type === 'ObjectNode') {
                    console.log(`   Object attrs: ${val.attributes.length}, bindings: ${val.bindings.length}`);
                    for (const ob of val.bindings) {
                        console.log(`     binding "${ob.key}" attrs: ${ob.attributes.length}`);
                    }
                }
            }
        }
    }
    console.log('');
}

console.log('═'.repeat(60));
console.log('  DEEP PROBES');
console.log('═'.repeat(60) + '\n');

// ── Object-level @{} behavior ──
console.log('── OBJECT ATTRIBUTE ACCUMULATION ──\n');

show(probe('Object: 1 pre-binding @{}, binding has 0',
    'x = { @{a=1} k = 1 }'));

show(probe('Object: 2 pre-binding @{}, binding has 0',
    'x = { @{a=1} @{b=2} k = 1 }'));

show(probe('Object: 5 stacked @{}, then binding',
    'x = { @{a=1} @{b=2} @{c=3} @{d=4} @{e=5} k = 1 }'));

show(probe('Object: @{} then @{} then binding with own @{}',
    'x = { @{a=1} @{b=2} k @{c=3} = 1 }'));

show(probe('Object: @{} between two bindings',
    'x = { k1 = 1, @{mid=1} k2 = 2 }'));

show(probe('Object: @{} after last binding',
    'x = { k1 = 1, @{trailing=1} }'));

show(probe('Object: only @{}, no bindings at all',
    'x = { @{orphan=1} }'));

show(probe('Object: multiple @{}, no bindings',
    'x = { @{a=1} @{b=2} @{c=3} }'));

// ── Duplicate attribute keys ──
console.log('\n── DUPLICATE ATTRIBUTE KEYS ──\n');

show(probe('Attr: duplicate key in same block',
    'a @{x=1, x=2} = 3'));

show(probe('Attr: same key different values',
    'a @{mode="a", mode="b"} = 3'));

// ── Top-level duplicate keys ──
console.log('\n── TOP-LEVEL DUPLICATE KEYS ──\n');

show(probe('Top: duplicate keys',
    'a = 1\na = 2'));

show(probe('Top: triple duplicate',
    'a = 1\na = 2\na = 3'));

// ── Header edge cases ──
console.log('\n── HEADER SEQUENCING ──\n');

show(probe('Header then binding (normal)',
    'aeon:mode = "strict"\nx = 1'));

show(probe('Binding then header-like (should warn)',
    'x = 1\naeon:mode = "strict"'));

show(probe('aeon:envelope as key (not header)',
    'aeon:envelope = "test"'));

// ── Attribute entry ordering edge cases ──
console.log('\n── ATTRIBUTE ENTRY WITH @{} ON ENTRIES ──\n');

show(probe('Attr entry with nested @{} depth=1 (default)',
    'a @{x @{y=1} = 2} = 3'));

show(probe('Attr entry with nested @{} depth=2',
    'a @{x @{y=1} = 2} = 3', { maxAttributeDepth: 2 }));

show(probe('Attr entry double @{} within attribute block (depth=2)',
    'a @{x @{y=1} @{z=2} = 3} = 4', { maxAttributeDepth: 2 }));

show(probe('Attr entry: type then @{} (depth=2)',
    'a @{x :int @{y=1} = 2} = 3', { maxAttributeDepth: 2 }));

show(probe('Attr entry: @{} then type (depth=2)',
    'a @{x @{y=1} :int = 2} = 3', { maxAttributeDepth: 2 }));

// ── Node with @{} before type ──
console.log('\n── NODE ATTRIBUTE/TYPE ORDERING ──\n');

show(probe('Node: @{} before simple type',
    'a = <tag @{x=1} :mytype>'));

show(probe('Node: type before @{}',
    'a = <tag :mytype @{x=1}>'));

show(probe('Node: @{} before children',
    'a = <tag @{x=1} (1, 2)>'));

show(probe('Node: type and @{} before children',
    'a = <tag @{x=1} :mytype (1, 2)>'));

// ── Anonymous typed values ──
console.log('\n── ANONYMOUS TYPED VALUES ──\n');

show(probe('List with mixed typed and untyped',
    'a = [1, :int = 2, "x"]'));

show(probe('Tuple with anonymous type then value',
    'a = (:string = "hello")'));

show(probe('Nested anonymous types in list',
    'a = [:list<int> = [1, 2]]'));

show(probe('Anonymous type with attribute (should fail?)',
    'a = [:int @{x=1} = 1]'));
