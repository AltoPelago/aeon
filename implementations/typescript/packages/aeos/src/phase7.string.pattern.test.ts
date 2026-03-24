import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPatterns } from './rules/stringForm.js';
import { createDiagContext } from './diag/emit.js';

function makeEvent(type: string, value: string, span: [number, number] | null) {
  return { type, value, span };
}

test('Phase 7: stringForm - pattern match pass', () => {
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.code', { path: '$.code', constraints: { type: 'StringLiteral', pattern: '^[A-Z]{3}-\\d{3}$' } });
  const events = new Map<string, any>(); events.set('$.code', makeEvent('StringLiteral', 'ABC-123', [60,61]));
  const ctx = createDiagContext();
  checkPatterns(ruleIndex, events, ctx);
  assert.equal(ctx.errors.length, 0);
});

test('Phase 7: stringForm - pattern mismatch produces pattern_mismatch', () => {
  const ruleIndex = new Map<string, any>();
  ruleIndex.set('$.code', { path: '$.code', constraints: { type: 'StringLiteral', pattern: '^[A-Z]{3}-\\d{3}$' } });
  const events = new Map<string, any>(); events.set('$.code', makeEvent('StringLiteral', 'abc123', [62,63]));
  const ctx = createDiagContext();
  checkPatterns(ruleIndex, events, ctx);
  assert.equal(ctx.errors.length, 1);
  const e = ctx.errors[0]!;
  assert.equal(e.code, 'pattern_mismatch');
});
