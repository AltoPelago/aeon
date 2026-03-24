import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStringForm } from './rules/stringForm.js';
import { createDiagContext } from './diag/emit.js';

// Minimal RuleIndex and event shape for tests
function makeEvent(type: string, value: string, span: [number, number] | null) {
  return { type, value, span };
}

test('Phase 7: stringForm - min_length violation', () => {
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.s', { path: '$.s', constraints: { type: 'StringLiteral', min_length: 3 } });
  const events = new Map<string, any>(); events.set('$.s', makeEvent('StringLiteral', 'ab', [30,31]));
  const ctx = createDiagContext();
  checkStringForm(ruleIndex, events, ctx);
  assert.equal(ctx.errors.length, 1);
  const e0 = ctx.errors[0]!;
  assert.equal(e0.code, 'string_length_violation');
});

test('Phase 7: stringForm - max_length violation', () => {
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.t', { path: '$.t', constraints: { type: 'StringLiteral', max_length: 3 } });
  const events = new Map<string, any>(); events.set('$.t', makeEvent('StringLiteral', 'toolong', [32,33]));
  const ctx = createDiagContext();
  checkStringForm(ruleIndex, events, ctx);
  assert.equal(ctx.errors.length, 1);
  const e1 = ctx.errors[0]!;
  assert.equal(e1.code, 'string_length_violation');
});

test('Phase 7: stringForm - pass case within bounds', () => {
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.u', { path: '$.u', constraints: { type: 'StringLiteral', min_length: 1, max_length: 10 } });
  const events = new Map<string, any>(); events.set('$.u', makeEvent('StringLiteral', 'okay', [34,35]));
  const ctx = createDiagContext();
  checkStringForm(ruleIndex, events, ctx);
  assert.equal(ctx.errors.length, 0);
});

test('Phase 7: stringForm - empty string and min_length 0 passes', () => {
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.e', { path: '$.e', constraints: { type: 'StringLiteral', min_length: 0 } });
  const events = new Map<string, any>(); events.set('$.e', makeEvent('StringLiteral', '', [40,41]));
  const ctx = createDiagContext();
  checkStringForm(ruleIndex, events, ctx);
  assert.equal(ctx.errors.length, 0);
});

test('Phase 7: stringForm - surrogate pair (emoji) counts as two UTF-16 code units', () => {
  // Using UTF-16 semantics as project decided: emoji length === 2
  const emoji = '😄'; // surrogate pair; .length === 2 in JS
  assert.equal(emoji.length, 2);
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.emoji', { path: '$.emoji', constraints: { type: 'StringLiteral', max_length: 1 } });
  const events = new Map<string, any>(); events.set('$.emoji', makeEvent('StringLiteral', emoji, [50,51]));
  const ctx = createDiagContext();
  checkStringForm(ruleIndex, events, ctx);
  // With JS length=2 and max_length=1, should produce violation
  assert.equal(ctx.errors.length, 1);
  const e2 = ctx.errors[0]!;
  assert.equal(e2.code, 'string_length_violation');
});

// Pattern tests are skipped until pattern enforcement implemented

