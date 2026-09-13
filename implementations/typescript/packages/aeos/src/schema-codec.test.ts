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

    it('round-trips bounded declaration labels and descriptions', () => {
        const source = schemaToAeon({
            rules: [{
                declaration_id: 'contact-email',
                label: 'Email address',
                description: 'Primary address used for direct communication with the contact.',
                selector: '$.contacts.*.email',
                constraints: { type: 'StringLiteral', datatype: 'email' },
            }],
        });
        assert.match(source, /label:string = "Email address"/);
        assert.match(source, /description:string = "Primary address/);
        assert.deepStrictEqual(parseSchemaSource(source).rules[0], {
            declaration_id: 'contact-email',
            label: 'Email address',
            description: 'Primary address used for direct communication with the contact.',
            selector: '$.contacts.*.email',
            constraints: { type: 'StringLiteral', datatype: 'email' },
        });
        assert.throws(() => schemaToAeon({
            rules: [{ label: ' padded ', path: '$.value', constraints: {} }],
        }), /must be trimmed/);
        assert.throws(() => schemaToAeon({
            rules: [{ description: '', path: '$.value', constraints: {} }],
        }), /non-empty/);
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

    it('authors numeric bounds as AEON numbers while retaining exact portable lexemes', () => {
        const schema = parseSchemaSource(`
aeos:schema = {
  rules:list<object> = [
    {
      path:sansa = $.measurement
      constraints:object = {
        type:string = "NumberLiteral"
        min_value:number = -0.100_000_000_000_000_000_000_000_000_000_000_1
        max_value:number = 9_007_199_254_740_993
      }
    }
  ]
}
`);

        assert.deepStrictEqual(schema.rules[0]?.constraints, {
            type: 'NumberLiteral',
            min_value: '-0.1000000000000000000000000000000001',
            max_value: '9007199254740993',
        });

        const rendered = schemaToAeon(schema);
        assert.match(rendered, /min_value:number = -0\.1000000000000000000000000000000001/u);
        assert.match(rendered, /max_value:number = 9007199254740993/u);
        assert.doesNotMatch(rendered, /(?:min_value|max_value):string/u);
        assert.deepStrictEqual(parseSchemaSource(rendered), schema);
    });

    it('rejects quoted and malformed numeric bounds', () => {
        assert.throws(() => parseSchemaSource(`
aeos:schema = {
  rules:list<object> = [
    {
      path:sansa = $.value
      constraints:object = { min_value:string = "1" }
    }
  ]
}
`), /must be an AEON number literal, not a string/u);

        assert.throws(() => normalizeSchemaObject({
            rules: [{ path: '$.value', constraints: { max_value: 'not-a-number' } }],
        }), /must be a valid finite AEON number literal/u);
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
