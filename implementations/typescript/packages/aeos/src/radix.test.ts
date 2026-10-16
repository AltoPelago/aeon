import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/radix-bases.json' with { type: 'json' };
import { validateTelex } from './telex.js';
import { validate } from './validate.js';
import type { AES } from './types/aes.js';

for (const { literal, base } of fixtures.filter(f => f.testSource)) {
    test(`AEOS resolves exact radix declaration ${literal}`, () => {
        for (const allow_unspecified_radix of [false, true]) {
            const schema = { rules: [{ path: '$.mask', constraints: { radix: base ?? 2, allow_unspecified_radix } }] };
            const legacy = [{ path: { segments: [{ type: 'root' }, { type: 'member', key: 'mask' }] }, key: 'mask', datatype: `radix[${literal}]`, value: { type: 'RadixLiteral', raw: '%1', value: '1' }, span: [0, 1] }] as unknown as AES;
            const result = validate(legacy, schema);
            const portable = validateTelex(`telex.aes=1\n\npath=$.mask\nkind=RadixLiteral\ndatatype=radix[${literal}]\nvalue=1\n`, schema);
            assert.equal(result.ok, base !== null);
            assert.equal(portable.ok, result.ok);
            for (const diagnostic of [...result.errors, ...portable.errors]) assert.equal(diagnostic.code, 'numeric_form_violation');
            if (base !== null) assert.equal(validate(legacy, { rules: [{ path: '$.mask', constraints: { radix: base === 2 ? 3 : 2, allow_unspecified_radix } }] }).ok, false);
        }
    });
}

test('allow_unspecified_radix applies only to genuinely absent bases', () => {
    for (const datatype of ['radix', 'radix["2"]']) {
        const schema = { rules: [{ path: '$.mask', constraints: { radix: 2, allow_unspecified_radix: true } }] };
        const result = validateTelex(`telex.aes=1\n\npath=$.mask\nkind=RadixLiteral\ndatatype=${datatype}\nvalue=1\n`, schema, { maxClarifierValues: 2 });
        assert.equal(result.ok, datatype === 'radix');
    }
    const multiple = [{ path: { segments: [{ type: 'root' }, { type: 'member', key: 'mask' }] }, key: 'mask', datatype: 'radix[2, 10]', value: { type: 'RadixLiteral', raw: '%1', value: '1' }, span: [0, 1] }] as unknown as AES;
    assert.equal(validate(multiple, { rules: [{ path: '$.mask', constraints: { radix: 2, allow_unspecified_radix: true } }] }).ok, false);
});

test('attribute and any_of radix constraints use the same exact interpretation', () => {
    for (const literal of ['2.00', '2e0', '2.0000000000000001']) {
        const constraints = { type: 'RadixLiteral', radix: 2, allow_unspecified_radix: true };
        const scalar = `path=$.mask\nkind=RadixLiteral\ndatatype=radix[${literal}]\nvalue=1\n`;
        const attribute = `telex.aes=1\n\npath=$.x\nkind=NumberLiteral\nvalue=0\n\n${scalar.replace('$.mask', '$.x.@.mask')}`;
        const attrs = validateTelex(attribute, { rules: [{ path: '$.x', constraints: { attributes: { mask: constraints } } }] });
        const branch = validateTelex(`telex.aes=1\n\n${scalar}`, { rules: [{ path: '$.mask', constraints: { any_of: [constraints] } }] });
        assert.equal(attrs.ok, literal !== '2.0000000000000001');
        assert.equal(branch.ok, attrs.ok);
    }
});
