/**
 * Quick check: what does the AST actually contain for duplicate attr keys?
 */
import { tokenize } from '../packages/lexer/dist/index.js';
import { parse } from '../packages/parser/dist/index.js';

const input = 'a @{x=1, x=2, x=3} = 42';
const { tokens } = tokenize(input);
const filtered = tokens.filter(t => t.type !== 'Newline');
const { document, errors } = parse(filtered);

console.log('Errors:', errors.length);
console.log('Binding attrs:', JSON.stringify(
    [...document.bindings[0].attributes[0].entries.entries()],
    null, 2
));

// Also check: header after body
const input2 = 'x = 1\naeon:mode = "strict"';
const { tokens: t2 } = tokenize(input2);
const f2 = t2.filter(t => t.type !== 'Newline');
const { document: d2, errors: e2 } = parse(f2);
console.log('\n--- Header after body ---');
console.log('Errors:', e2.length);
console.log('Header:', d2.header);
console.log('Bindings:', d2.bindings.length, d2.bindings.map(b => `${b.key}=${JSON.stringify(b.value)}`));

// Also check: top-level dup keys
const input3 = 'a = 1\na = 2';
const { tokens: t3 } = tokenize(input3);
const f3 = t3.filter(t => t.type !== 'Newline');
const { document: d3, errors: e3 } = parse(f3);
console.log('\n--- Top-level duplicate keys ---');
console.log('Errors:', e3.length, e3.map(e => e.message));
console.log('Bindings:', d3.bindings.length);
