import test from 'node:test';
import assert from 'node:assert/strict';
import { createFailingEnvelope, createPassingEnvelope } from './types/envelope.js';
import { validate } from './validate.js';
import type { AES } from './types/aes.js';
import type { SchemaV1 } from './types/schema.js';

test('Phase 9: Envelope preserves provided guarantees object', () => {
  const g = { '$.x': ['integer-representable'] };
  const env = createFailingEnvelope([], [], g as any);
  assert.strictEqual(typeof env.guarantees, 'object');
  assert.deepStrictEqual(env.guarantees, g);
});

test('Phase 9: createPassingEnvelope includes empty guarantees by default', () => {
  const env = createPassingEnvelope();
  assert.strictEqual(typeof env.guarantees, 'object');
  assert.deepStrictEqual(env.guarantees, {});
});

test('Phase 9: validate() emits representation guarantees for passing envelope', () => {
  const aes: AES = [
    {
      path: { segments: [{ type: 'root' }, { type: 'member', key: 'x' }] },
      key: 'x',
      value: { type: 'NumberLiteral', raw: '42', value: '42', span: [1, 2] },
      span: [1, 2],
    },
  ] as unknown as AES;

  const schema: SchemaV1 = { rules: [] };

  const res = validate(aes, schema);
  assert.strictEqual(res.ok, true);
  // guarantees should include 'present' and 'integer-representable' for $.x
  assert.ok(Array.isArray(res.guarantees['$.x']));
  assert.ok(res.guarantees['$.x'].includes('present'));
  assert.ok(res.guarantees['$.x'].includes('integer-representable'));
});
