/**
 * @altopelago/aeos-core - Schema codec tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeSchemaObject, parseSchemaSource, schemaToAeon, SchemaCodecError } from './schema-codec.js';

describe('schema codec', () => {
    it('parses AEON schema source with SANSA path and selector fields', () => {
        const schema = parseSchemaSource(`
aeos:schema = {
  world:string = "closed"
  rules:list<object> = [
    {
      path:sansa = $.contact.name
      constraints:object = {
        required:boolean = true
        type:string = "StringLiteral"
      }
    }
    {
      selector:sansa = $.contact.measurements.*
      constraints:object = {
        type:string = "NumberLiteral"
      }
    }
  ]
}
`);

        assert.strictEqual(schema.world, 'closed');
        assert.deepStrictEqual(schema.rules, [
            {
                path: '$.contact.name',
                constraints: { required: true, type: 'StringLiteral' },
            },
            {
                selector: '$.contact.measurements.*',
                constraints: { type: 'NumberLiteral' },
            },
        ]);
    });

    it('accepts legacy string address fields but normalizes through SANSA', () => {
        const schema = parseSchemaSource(`
schema:object = {
  rules:list<object> = [
    {
      path:string = "$.[\\"safe key\\"]"
      constraints:object = { required:boolean = true }
    }
  ]
}
`);

        assert.deepStrictEqual(schema.rules, [
            {
                path: '$.["safe key"]',
                constraints: { required: true },
            },
        ]);
    });

    it('rejects legacy indexed wildcard selectors', () => {
        assert.throws(
            () => parseSchemaSource(`
aeos:schema = {
  rules:list<object> = [
    { selector:string = "$.items[*]" constraints:object = { required:boolean = true } }
  ]
}
`),
            SchemaCodecError
        );
    });

    it('rejects wildcard selectors in exact path fields', () => {
        assert.throws(
            () => normalizeSchemaObject({
                rules: [
                    {
                        path: '$.items.*',
                        constraints: { required: true },
                    },
                ],
            }),
            /must be an exact SANSA address/
        );
    });

    it('prints schemas using path:sansa and selector:sansa', () => {
        const source = schemaToAeon({
            world: 'open',
            rules: [
                { path: '$.contact.name', constraints: { required: true, type: 'StringLiteral' } },
                { selector: '$.contact.measurements.*', constraints: { type: 'NumberLiteral' } },
            ],
        });

        assert.match(source, /path:sansa = \$\.contact\.name/);
        assert.match(source, /selector:sansa = \$\.contact\.measurements\.\*/);
        assert.match(source, /constraints:object = \{/);
    });

    it('round-trips schema evolution intent', () => {
        const source = schemaToAeon({
            rules: [
                {
                    declaration_id: 'contact-display-name',
                    path: '$.contact.displayName',
                    constraints: { type: 'StringLiteral' },
                },
            ],
            evolution: [
                {
                    change_id: 'rename-contact-name',
                    kind: 'rename',
                    from_declarations: ['contact-name'],
                    to_declarations: ['contact-display-name'],
                    from_contract: 'Contacts.v1',
                    note: 'Keep the public label stable.',
                },
            ],
        });

        assert.deepStrictEqual(parseSchemaSource(source).evolution, [
            {
                change_id: 'rename-contact-name',
                kind: 'rename',
                from_declarations: ['contact-name'],
                to_declarations: ['contact-display-name'],
                from_contract: 'Contacts.v1',
                note: 'Keep the public label stable.',
            },
        ]);
    });

    it('rejects invalid temporal intent cardinality and unknown target declarations', () => {
        assert.throws(() => normalizeSchemaObject({
            rules: [{ declaration_id: 'display-name', path: '$.displayName', constraints: {} }],
            evolution: [{
                change_id: 'bad-rename', kind: 'rename',
                from_declarations: [], to_declarations: ['display-name'],
            }],
        }), /invalid declaration cardinality/);

        assert.throws(() => normalizeSchemaObject({
            rules: [{ declaration_id: 'display-name', path: '$.displayName', constraints: {} }],
            evolution: [{
                change_id: 'bad-target', kind: 'add',
                from_declarations: [], to_declarations: ['missing'],
            }],
        }), /unknown target declaration/);
    });

    it('round-trips nested constraints through AEON source', () => {
        const source = schemaToAeon({
            rules: [
                {
                    path: '$.contact.name',
                    constraints: {
                        any_of: [
                            { type: 'StringLiteral', datatype: 'string' },
                            { type: 'NullLiteral', null_values: ['missing', 'unknown'] },
                        ],
                        attributes: {
                            label: {
                                required: true,
                                type: 'StringLiteral',
                            },
                        },
                    },
                },
            ],
        });

        assert.deepStrictEqual(parseSchemaSource(source).rules[0]?.constraints, {
            any_of: [
                { type: 'StringLiteral', datatype: 'string' },
                { type: 'NullLiteral', null_values: ['missing', 'unknown'] },
            ],
            attributes: {
                label: {
                    required: true,
                    type: 'StringLiteral',
                },
            },
        });
    });

    it('round-trips declaration and lineage identities', () => {
        const source = schemaToAeon({
            rules: [{
                declaration_id: 'contact-name',
                lineage_id: 'contact-name',
                path: '$.contact.name',
                constraints: { type: 'StringLiteral' },
            }],
        });
        assert.match(source, /declaration_id:string = "contact-name"/);
        assert.deepStrictEqual(parseSchemaSource(source).rules[0], {
            declaration_id: 'contact-name',
            lineage_id: 'contact-name',
            path: '$.contact.name',
            constraints: { type: 'StringLiteral' },
        });
    });

    it('rejects duplicate declaration identities', () => {
        assert.throws(() => normalizeSchemaObject({ rules: [
            { declaration_id: 'same', path: '$.a', constraints: {} },
            { declaration_id: 'same', path: '$.b', constraints: {} },
        ] }), /declaration_id 'same' must be unique/);
    });
});
