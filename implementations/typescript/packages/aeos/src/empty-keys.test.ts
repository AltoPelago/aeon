import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, compileToTelex } from '@altopelago/aeon-core';
import { validate } from './validate.js';
import { validateTelex } from './telex.js';
import { normalizeSchemaObject, parseSchemaSource, schemaToAeon } from './schema-codec.js';

test('AEOS validates an empty-key property and preserves its diagnostic path', () => {
    const compiled = compile('"" = ""');
    assert.deepEqual(compiled.errors, []);
    const schema = normalizeSchemaObject({ rules: [{ path: '$.[""]', constraints: { type: 'StringLiteral' } }] });
    const roundTrip = parseSchemaSource(schemaToAeon(schema));
    assert.equal(validate(compiled.events, roundTrip).ok, true);
    assert.equal(validateTelex(compileToTelex('"" = ""').telex!, roundTrip).ok, true);
    const wrong = compile('"" = 1');
    const result = validate(wrong.events, roundTrip);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === '$.[""]'), JSON.stringify(result.errors));
});
