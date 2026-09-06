import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaV1 } from './types/schema.js';
import { validateTelex } from './telex.js';

const numberSchema: SchemaV1 = {
    rules: [{ path: '$.answer', constraints: { required: true, type: 'NumberLiteral' } }],
};

describe('AEOS Telex validation', () => {
    it('validates a complete Telex stream directly', () => {
        const result = validateTelex(
            'telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n',
            numberSchema,
        );
        assert.equal(result.ok, true);
        assert.deepEqual(result.guarantees['$.answer'], ['present', 'integer-representable', 'float-representable']);
    });

    it('reports AES profile failures before schema validation', () => {
        const result = validateTelex(
            'telex.aes=0\n\npath=$.nested.answer\nkind=NumberLiteral\nvalue=42\n',
            numberSchema,
        );
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((error) => error.code === 'AES_MISSING_PARENT'));
    });

    it('hydrates flat attribute events for nested constraints without using identities as paths', () => {
        const schema: SchemaV1 = {
            rules: [{
                path: '$.value',
                constraints: {
                    type: 'NumberLiteral',
                    attributes: {
                        settings: {
                            required: true,
                            type: 'StringLiteral',
                            attributes: {
                                unit: { required: true, type: 'StringLiteral' },
                            },
                            closed_attributes: true,
                        },
                    },
                    closed_attributes: true,
                },
            }],
        };
        const result = validateTelex(
            'telex.aes=0\n\npath=$.value\nkind=NumberLiteral\nidentity=BINDING\nvalue=3\n\npath=$.value.@.settings\nkind=StringLiteral\nidentity=SETTINGS\nvalue=display\n\npath=$.value.@.settings.@.unit\nkind=StringLiteral\nidentity=UNIT\nvalue=ms\n',
            schema,
        );
        assert.equal(result.ok, true, JSON.stringify(result.errors));
    });

    it('recombines portable datatype components before applying AEOS rules', () => {
        const result = validateTelex(
            'telex.aes=0\n\npath=$.items\nkind=ListNode\ndatatype=list<int>\n\npath=$.items[0]\nkind=NumberLiteral\ndatatype=int\nvalue=2\n',
            {
                rules: [
                    { path: '$.items', constraints: { type: 'ListNode', datatype: 'list<int>' } },
                    { path: '$.items[0]', constraints: { type: 'NumberLiteral', datatype: 'int' } },
                ],
            },
        );
        assert.equal(result.ok, true, JSON.stringify(result.errors));
    });

    it('counts node contents beneath the explicit node head', () => {
        const wire = 'telex.aes=0\n\npath=$.node\nkind=NodeLiteral\n\npath=$.node[0]\nkind=NodeHead\nvalue=tag\n\npath=$.node[0][0]\nkind=StringLiteral\nvalue=one\n\npath=$.node[0][1]\nkind=StringLiteral\nvalue=two\n';
        const passing = validateTelex(wire, {
            rules: [{ path: '$.node', constraints: { type: 'NodeLiteral', min_children: 2, max_children: 2 } }],
        });
        assert.equal(passing.ok, true, JSON.stringify(passing.errors));

        const failing = validateTelex(wire, {
            rules: [{ path: '$.node', constraints: { type: 'NodeLiteral', max_children: 1 } }],
        });
        assert.equal(failing.ok, false);
        assert.ok(failing.errors.some((error) => error.code === 'container_cardinality_mismatch'));
    });
});
