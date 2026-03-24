import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuleIndex } from './rules/schemaIndex.js';
import { createDiagContext } from './diag/emit.js';
import { ErrorCodes } from './diag/codes.js';

test('Phase 8: datatype allowlist - rejects unknown datatype', () => {
  const schema: any = {
    rules: [ { path: '$.x', constraints: { datatype: 'unknown-type' } } ],
    datatype_allowlist: [ 'product-id', 'user-id' ]
  };
  const ctx = createDiagContext();
  buildRuleIndex(schema, ctx as any);
  // Expect a datatype_allowlist_reject emitted
  const codes = ctx.errors.map(e => e.code);
  assert.ok(codes.includes(ErrorCodes.DATATYPE_ALLOWLIST_REJECT));
});

test('Phase 8: datatype allowlist - accepts allowed datatype', () => {
  const schema: any = {
    rules: [ { path: '$.id', constraints: { datatype: 'user-id' } } ],
    datatype_allowlist: [ 'product-id', 'user-id' ]
  };
  const ctx = createDiagContext();
  buildRuleIndex(schema, ctx as any);
  const codes = ctx.errors.map(e => e.code);
  assert.equal(codes.includes(ErrorCodes.DATATYPE_ALLOWLIST_REJECT), false);
});
