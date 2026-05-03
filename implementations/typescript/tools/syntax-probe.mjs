/**
 * AEON Syntax Probe
 *
 * Feeds suspect syntax patterns through the real lexer+parser and reports
 * which ones pass without errors. This identifies combinations that are
 * structurally accepted but may be semantically invalid or surprising.
 */

import { tokenize } from '../packages/lexer/dist/index.js';
import { parse } from '../packages/parser/dist/index.js';

function probe(label, input, options = {}) {
    const { tokens, errors: lexErrors } = tokenize(input);
    const filtered = tokens.filter(t => t.type !== 'Newline' && t.type !== 'LineComment' && t.type !== 'BlockComment');
    const { document, errors: parseErrors } = parse(filtered, options);

    const allErrors = [...lexErrors, ...parseErrors];
    const passed = allErrors.length === 0 && document !== null;
    const bindingCount = document?.bindings?.length ?? 0;

    return { label, input, passed, errors: allErrors, bindingCount, document };
}

// ── Category helpers ──

const results = [];

function test(label, input, opts) {
    results.push(probe(label, input, opts));
}

// ================================================================
// 1. DOUBLE/MULTIPLE ATTRIBUTES ON BINDINGS
// ================================================================

test('Double @{} on binding',
    'a @{x=1} @{y=2} = 3');

test('Triple @{} on binding',
    'a @{x=1} @{y=2} @{z=3} = 4');

test('Attr after type on binding',
    'a :int @{x=1} = 3');

test('Attr, type, then another attr',
    'a @{x=1} :int @{y=2} = 3');

// ================================================================
// 2. MULTIPLE ATTRIBUTES IN OBJECT CONTEXT
// ================================================================

test('Multiple @{} before binding in object',
    'x = { @{a=1} @{b=2} k = 1 }');

test('Object-level @{} then binding-level @{}',
    'x = { @{a=1} k @{b=2} = 1 }');

test('Object @{} with no following binding',
    'x = { @{a=1} }');

test('Object @{} between bindings',
    'x = { k1 = 1, @{a=1} k2 = 2 }');

test('Stacked @{} in object, no binding',
    'x = { @{a=1} @{b=2} }');

// ================================================================
// 3. TYPE ANNOTATION EDGE CASES
// ================================================================

test('Double colon type',
    'a :int :str = 3');

test('Type with generic on non-generic reserved type',
    'a :int<32> = 3');

test('Type with bracket on non-bracketed reserved type',
    'a :int[,] = 3');

test('Nested generics beyond depth 1',
    'a :list<list<int>> = [1]', { maxGenericDepth: 2 });

test('Nested generics at default depth',
    'a :list<list<int>> = [1]');

test('Unknown type with brackets',
    'a :mytype[x] = 3');

test('Unknown type with generics',
    'a :mytype<int> = 3');

test('Unknown type with both generics and brackets',
    'a :mytype<int>[x] = 3');

test('Radix with generic angle',
    'a :radix<10> = %1010');

test('Multiple bracket specs on sep',
    'a :sep[,][;] = "a,b"', { maxSeparatorDepth: 2 });

test('Multiple bracket specs on sep (default depth)',
    'a :sep[,][;] = "a,b"');

// ================================================================
// 4. KEY VARIATIONS
// ================================================================

test('Number as key',
    '123 = "val"');

test('Empty quoted key',
    '"" = "val"');

test('Backtick key',
    '`key` = "val"');

test('Keyword as key',
    'true = "val"');

test('Boolean token as key',
    'false = 1');

test('Switch token as key',
    'yes = 1');

test('Null-like as key',
    'none = 1');

// ================================================================
// 5. VALUE EDGE CASES
// ================================================================

test('Bare identifier as value',
    'a = hello');

test('Reference path without tilde',
    'a = $.path');

test('Nested object depth 3',
    'a = { b = { c = { d = 1 } } }');

test('Empty object',
    'a = {}');

test('Empty list',
    'a = []');

test('Empty tuple',
    'a = ()');

test('Empty node (childless)',
    'a = <tag>');

test('Node with empty children',
    'a = <tag()>');

test('Nested nodes',
    'a = <outer(<inner>)>');

// ================================================================
// 6. NODE STRUCTURE EDGE CASES
// ================================================================

test('Node with double @{}',
    'a = <tag @{x=1} @{y=2}>');

test('Node with attr after type',
    'a = <tag :mytype @{x=1}>');

test('Node with type that has generics',
    'a = <tag :mytype<int>>');

test('Node with type that has brackets',
    'a = <tag :mytype[x]>');

test('Node with complex head type',
    'a = <tag :list<int>>');

test('Node bare identifier no angle close',
    'a = <tag(1, 2)');

test('Double tag in node',
    'a = <tag1 tag2>');

// ================================================================
// 7. REFERENCE PATH EDGE CASES
// ================================================================

test('Clone reference basic',
    'a = ~b');

test('Clone with dotted path',
    'a = ~b.c.d');

test('Clone with root $',
    'a = ~$.b.c');

test('Clone with bracket index',
    'a = ~b[0]');

test('Clone with attribute path',
    'a = ~b@x');

test('Clone with chained attribute paths',
    'a = ~b@x@y');

test('Pointer reference basic',
    'a = ~>b');

test('Pointer with complex path',
    'a = ~>$.b[0].c@x');

test('Clone with consecutive dots',
    'a = ~b..c');

test('Clone with trailing dot',
    'a = ~b.');

// ================================================================
// 8. CONTAINER VALUES WITH ANONYMOUS TYPES
// ================================================================

test('Anonymous typed value in list',
    'a = [:int = 1, :str = "x"]');

test('Anonymous typed value in tuple',
    'a = (:int = 1, :str = "x")');

test('Anonymous typed value in node children',
    'a = <tag(:int = 1)>');

test('Anonymous typed value at top level (should fail)',
    'a = :int = 1');

test('Double colon anonymous type in list',
    'a = [:int :str = 1]');

// ================================================================
// 9. SEPARATOR / DELIMITER EDGE CASES  
// ================================================================

test('Comma as last element in tuple',
    'a = (1, 2,)');

test('Comma as last element in list',
    'a = [1, 2,]');

test('Comma as last element in object',
    'a = {k=1, j=2,}');

test('Double comma in list',
    'a = [1,, 2]');

test('Double comma in object',
    'a = {a=1,, b=2}');

test('Semicolon as separator in list',
    'a = [1; 2]');

test('Semicolon as separator in object',
    'a = {a=1; b=2}');

// ================================================================
// 10. HEADER EDGE CASES
// ================================================================

test('Header after body binding',
    'x = 1\naeon:mode = "strict"');

test('Duplicate shorthand headers',
    'aeon:mode = "a"\naeon:mode = "b"');

test('Header with structured and shorthand mix',
    'aeon:header = { mode = "a" }\naeon:version = 1');

// ================================================================
// 11. NULL LITERAL EDGE CASES
// ================================================================

test('Valid null sentinel',
    'a = !none');

test('Invalid null sentinel',
    'a = !invalid');

test('Bare bang',
    'a = !');

test('Null with empty string reason',
    'a = !""');

test('Null with whitespace reason',
    'a = !" "');

test('Null with valid reason',
    'a = !"not available"');

// ================================================================
// 12. LITERAL TYPE MIXING / CONFUSION
// ================================================================

test('Hex as key value',
    'a = #FF00AA');

test('Radix as value',
    'a = %1010');

test('Encoding as value',
    'a = $SGVsbG8=');

test('Separator as value',
    'a = ^comma');

test('Bare caret',
    'a = ^');

test('Trimtick string',
    'a = >`line1\nline2`');

test('Multi-angle trimtick',
    'a = >>>`deeply trimmed`');

test('Five angle trimtick (over limit)',
    'a = >>>>>`nope`');

// ================================================================
// 13. MIXED STRUCTURAL PATTERNS
// ================================================================

test('Binding value is another binding-like pattern',
    'a = b = 1');

test('Equals in value position',
    'a = =');

test('At sign in value position',
    'a = @');

test('Colon in value position',
    'a = :');

test('Dot in value position',
    'a = .');

test('Hash alone in value position',
    'a = #');

test('Dollar alone in value position',
    'a = $');

test('Percent alone in value position',
    'a = %');

test('Ampersand in value position',
    'a = &');

// ================================================================
// 14. DUPLICATE KEYS
// ================================================================

test('Duplicate keys at top level',
    'a = 1\na = 2');

test('Duplicate keys in object',
    'a = { k = 1, k = 2 }');

test('Duplicate keys in attributes',
    'a @{x = 1, x = 2} = 3');

// ================================================================
// 15. NESTING DEPTH
// ================================================================

test('Extreme list nesting depth 5',
    'a = [[[[[1]]]]]');

test('Extreme object nesting depth 3',
    'a = {b = {c = {d = 1}}}');

test('Mixed nesting depth',
    'a = {b = [{c = (1, 2)}]}');

// ================================================================
// 16. WHITESPACE AND FORMATTING EDGE CASES
// ================================================================

test('No spaces around equals',
    'a=1');

test('Extra spaces everywhere',
    'a   =   1');

test('Tab-separated',
    'a\t=\t1');

test('Multiple bindings same line',
    'a = 1 b = 2');

test('Multiple bindings same line with comma',
    'a = 1, b = 2');

// ================================================================
// 17. ATTRIBUTE DEPTH STRESS
// ================================================================

test('Nested attribute depth 2 (default max=1)',
    'a @{x @{y = 1} = 2} = 3');

test('Nested attribute depth 2 (max=2)',
    'a @{x @{y = 1} = 2} = 3', { maxAttributeDepth: 2 });

test('Nested attribute depth 3 (max=2)',
    'a @{x @{y @{z = 0} = 1} = 2} = 3', { maxAttributeDepth: 2 });

// ================================================================
// 18. ATTRIBUTE ENTRIES WITH ATTRIBUTES (CHAINING)
// ================================================================

test('Attribute entry has own @{} (depth 2)',
    'a @{meta @{nested = true} :int = 42} = 1', { maxAttributeDepth: 2 });

test('Attribute entry has type and attr',
    'a @{meta :int @{x = 1} = 42} = 1', { maxAttributeDepth: 2 });

test('Attribute entry with double @{}',
    'a @{meta @{a=1} @{b=2} = 42} = 1', { maxAttributeDepth: 2 });

// ================================================================
// OUTPUT
// ================================================================

console.log('\n' + '═'.repeat(72));
console.log('  AEON SYNTAX PROBE RESULTS');
console.log('═'.repeat(72) + '\n');

const passed = results.filter(r => r.passed);
const failed = results.filter(r => !r.passed);

console.log(`✅ PASSED (no errors, document returned): ${passed.length}`);
console.log(`❌ REJECTED (errors or null document):    ${failed.length}`);
console.log('');

// ── Passed ──
console.log('─'.repeat(72));
console.log('  ✅ ACCEPTED SYNTAX (these pass without any errors)');
console.log('─'.repeat(72));
for (const r of passed) {
    const bindings = r.document?.bindings?.length ?? 0;
    console.log(`  ✅ ${r.label}`);
    console.log(`     Input:    ${JSON.stringify(r.input)}`);
    console.log(`     Bindings: ${bindings}`);
    console.log('');
}

// ── Failed ──
console.log('─'.repeat(72));
console.log('  ❌ REJECTED SYNTAX (errors were produced)');
console.log('─'.repeat(72));
for (const r of failed) {
    const msgs = r.errors.map(e => e.message || String(e));
    console.log(`  ❌ ${r.label}`);
    console.log(`     Input:  ${JSON.stringify(r.input)}`);
    console.log(`     Errors: ${msgs.join('; ')}`);
    console.log('');
}
