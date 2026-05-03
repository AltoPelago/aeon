/**
 * Focused grammar probes for cases where parser recovery may still return a
 * partial AST. A syntax shape is only accepted when errors.length === 0.
 */
import { tokenize } from '../packages/lexer/dist/index.js';
import { parse } from '../packages/parser/dist/index.js';

function inspect(input, options = {}) {
    const { tokens, errors: lexErrors } = tokenize(input);
    const filtered = tokens.filter(t => t.type !== 'Newline');
    const { document, errors: parseErrors } = parse(filtered, options);
    const errors = [...lexErrors, ...parseErrors];
    return {
        accepted: errors.length === 0 && document !== null,
        document,
        errors,
    };
}

function show(label, input, options) {
    const result = inspect(input, options);
    console.log(`\n--- ${label} ---`);
    console.log('Input:', input);
    console.log('Accepted:', result.accepted);
    console.log('Errors:', result.errors.map(e => `${e.code}: ${e.message}`));
    console.log('Bindings:', result.document?.bindings?.length ?? 0);
    return result;
}

const duplicateAttr = show('Duplicate attribute keys', 'a @{x=1, x=2, x=3} = 42');
if (!duplicateAttr.accepted) {
    console.log('Partial attr entries after recovery:', JSON.stringify(
        [...(duplicateAttr.document?.bindings?.[0]?.attributes?.[0]?.entries ?? new Map()).entries()],
        null,
        2,
    ));
}

const headerAfterBody = show('Header-like binding after body', 'x = 1\naeon:mode = "strict"');
console.log('Header:', headerAfterBody.document?.header ?? null);
console.log('Binding keys:', headerAfterBody.document?.bindings?.map(b => b.key) ?? []);

show('Top-level duplicate keys', 'a = 1\na = 2');
show('Floating object attribute', 'x = { @{meta=1} k = 2 }');
show('Repeated attribute entry head with raised depth', 'a @{x @{y=1} @{z=2} = 3} = 4', { maxAttributeDepth: 8 });
show('Single nested attribute entry head with raised depth', 'a @{x @{origin="core"} = 2} = 1', { maxAttributeDepth: 8 });
