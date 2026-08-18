import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    diffSchemaSources,
    inferSchemaFromAeon,
    SchemaInferenceError,
    validateSchemaEvolutionSources,
} from './schema-tools.js';

describe('schema tools', () => {
    it('derives an open-world editable candidate from bootstrap AEON', () => {
        const result = inferSchemaFromAeon(`
contacts = [
  { name:string = "Alice", active:boolean = true }
]
`);

        assert.strictEqual(result.schema.world, 'open');
        assert.strictEqual(result.observedEventCount, 4);
        assert.deepStrictEqual(result.schema.rules, [
            {
                declaration_id: 'rule:path:%24.contacts',
                lineage_id: 'rule:path:%24.contacts',
                path: '$.contacts',
                constraints: { required: true, type: 'ListNode' },
            },
            {
                declaration_id: 'rule:path:%24.contacts%5B0%5D',
                lineage_id: 'rule:path:%24.contacts%5B0%5D',
                path: '$.contacts[0]',
                constraints: { required: true, type: 'ObjectNode' },
            },
            {
                declaration_id: 'rule:path:%24.contacts%5B0%5D.name',
                lineage_id: 'rule:path:%24.contacts%5B0%5D.name',
                path: '$.contacts[0].name',
                constraints: { required: true, type: 'StringLiteral', datatype: 'string' },
            },
            {
                declaration_id: 'rule:path:%24.contacts%5B0%5D.active',
                lineage_id: 'rule:path:%24.contacts%5B0%5D.active',
                path: '$.contacts[0].active',
                constraints: { required: true, type: 'BooleanLiteral', datatype: 'boolean' },
            },
        ]);
        assert.match(result.source, /world:string = "open"/);
        assert.match(result.source, /path:sansa = \$\.contacts\[0\]\.name/);
        assert.ok(result.assumptions.some((item) => item.includes('optionality')));
    });

    it('preserves recursively nested semantic attributes', () => {
        const result = inferSchemaFromAeon('name@{label@{locale:string = "en"}:string = "Public"}:string = "Alice"', {
            compileOptions: { maxAttributeDepth: 8 },
        });
        assert.deepStrictEqual(result.schema.rules[0]?.constraints.attributes, {
            label: {
                required: true,
                type: 'StringLiteral',
                datatype: 'string',
                attributes: {
                    locale: { required: true, type: 'StringLiteral', datatype: 'string' },
                },
            },
        });
    });

    it('fails closed when bootstrap source is invalid', () => {
        assert.throws(() => inferSchemaFromAeon('broken = {'), SchemaInferenceError);
    });

    it('reports settings, additions, removals, and constraint changes', () => {
        const diff = diffSchemaSources(`
aeos:schema = {
  world:string = "open"
  rules:list<object> = [
    { path:sansa = $.person.name, constraints:object = { required:boolean = true, type:string = "StringLiteral" } }
    { path:sansa = $.person.age, constraints:object = { type:string = "IntegerLiteral" } }
  ]
}
`, `
aeos:schema = {
  world:string = "closed"
  rules:list<object> = [
    { path:sansa = $.person.displayName, constraints:object = { required:boolean = true, type:string = "StringLiteral" } }
    { path:sansa = $.person.age, constraints:object = { required:boolean = true, type:string = "IntegerLiteral" } }
  ]
}
`);

        assert.strictEqual(diff.equal, false);
        assert.ok(diff.changes.some((change) => change.kind === 'setting-changed' && change.setting === 'world'));
        assert.ok(diff.changes.some((change) => change.kind === 'rule-removed'));
        assert.ok(diff.changes.some((change) => change.kind === 'rule-added'));
        const changed = diff.changes.find((change) => change.kind === 'rule-changed');
        assert.deepStrictEqual(changed && changed.kind === 'rule-changed' ? changed.constraintPaths : [], ['constraints.required']);
        assert.deepStrictEqual(diff.possibleRuleMoves, [
            { from: 'path:$.person.name', to: 'path:$.person.displayName', reason: 'identical-constraints' },
        ]);
    });

    it('treats reordered object keys as semantically equal', () => {
        const diff = diffSchemaSources(`
schema = { rules = [{ path:sansa = $.value, constraints = { required = true, type = "StringLiteral" } }] }
`, `
schema = { rules = [{ path:sansa = $.value, constraints = { type = "StringLiteral", required = true } }] }
`);
        assert.deepStrictEqual(diff, { equal: true, changes: [], possibleRuleMoves: [] });
    });

    it('uses stable declaration identity as relocation evidence without admitting a rename', () => {
        const diff = diffSchemaSources(`
schema = { rules = [{ declaration_id = "person-name", lineage_id = "person-name", path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`, `
schema = { rules = [{ declaration_id = "person-name", lineage_id = "person-name", path:sansa = $.person.displayName, constraints = { type = "StringLiteral", max_length = 80 } }] }
`);

        assert.deepStrictEqual(diff.changes, [{
            kind: 'rule-relocated',
            identity: 'declaration:person-name',
            before: {
                declaration_id: 'person-name', lineage_id: 'person-name', path: '$.person.name',
                constraints: { type: 'StringLiteral' },
            },
            after: {
                declaration_id: 'person-name', lineage_id: 'person-name', path: '$.person.displayName',
                constraints: { type: 'StringLiteral', max_length: 80 },
            },
            constraintPaths: ['constraints.max_length'],
            evidence: 'shared-declaration-id',
        }]);
        assert.deepStrictEqual(diff.possibleRuleMoves, []);
    });

    it('uses lineage only for an unambiguous move hint', () => {
        const unique = diffSchemaSources(`
schema = { rules = [{ declaration_id = "old", lineage_id = "person-name", path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`, `
schema = { rules = [{ declaration_id = "new", lineage_id = "person-name", path:sansa = $.person.displayName, constraints = { type = "StringLiteral", max_length = 80 } }] }
`);
        assert.deepStrictEqual(unique.possibleRuleMoves, [{
            from: 'path:$.person.name', to: 'path:$.person.displayName', reason: 'shared-lineage-id',
        }]);

        const split = diffSchemaSources(`
schema = { rules = [{ declaration_id = "old", lineage_id = "person-name", path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`, `
schema = { rules = [
  { declaration_id = "first", lineage_id = "person-name", path:sansa = $.person.firstName, constraints = { type = "StringLiteral" } }
  { declaration_id = "last", lineage_id = "person-name", path:sansa = $.person.lastName, constraints = { type = "StringLiteral" } }
] }
`);
        assert.deepStrictEqual(split.possibleRuleMoves, []);

        const ambiguousConstraints = diffSchemaSources(`
schema = { rules = [
  { path:sansa = $.person.first, constraints = { type = "StringLiteral" } }
  { path:sansa = $.person.last, constraints = { type = "StringLiteral" } }
] }
`, `
schema = { rules = [{ path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`);
        assert.deepStrictEqual(ambiguousConstraints.possibleRuleMoves, []);
    });

    it('supports incremental identity adoption but treats explicit identity replacement as semantic change', () => {
        const adopted = diffSchemaSources(`
schema = { rules = [{ path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`, `
schema = { rules = [{ declaration_id = "person-name", lineage_id = "person-name", path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`);
        assert.deepStrictEqual(adopted.changes, [{
            kind: 'rule-changed',
            identity: 'path:$.person.name',
            before: { path: '$.person.name', constraints: { type: 'StringLiteral' } },
            after: {
                declaration_id: 'person-name', lineage_id: 'person-name', path: '$.person.name',
                constraints: { type: 'StringLiteral' },
            },
            constraintPaths: [],
            metadataPaths: ['declaration_id', 'lineage_id'],
        }]);

        const replaced = diffSchemaSources(`
schema = { rules = [{ declaration_id = "old-meaning", path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`, `
schema = { rules = [{ declaration_id = "new-meaning", path:sansa = $.person.name, constraints = { type = "StringLiteral" } }] }
`);
        assert.deepStrictEqual(replaced.changes.map((change) => change.kind), ['rule-removed', 'rule-added']);
    });

    it('validates temporal rename, add, and remove intent against both schema states', () => {
        const source = `
schema = { rules = [
  { declaration_id = "name", path:sansa = $.contact.name, constraints = { type = "StringLiteral" } }
  { declaration_id = "legacy", path:sansa = $.contact.legacy, constraints = { type = "StringLiteral" } }
] }
`;
        const target = `
schema = {
  evolution = [
    { change_id = "rename-name", kind = "rename", from_declarations = ["name"], to_declarations = ["name"] }
    { change_id = "add-active", kind = "add", from_declarations = [], to_declarations = ["active"] }
    { change_id = "remove-legacy", kind = "remove", from_declarations = ["legacy"], to_declarations = [] }
  ]
  rules = [
    { declaration_id = "name", path:sansa = $.contact.displayName, constraints = { type = "StringLiteral" } }
    { declaration_id = "active", path:sansa = $.contact.active, constraints = { type = "ToggleLiteral" } }
  ]
}
`;

        assert.deepStrictEqual(validateSchemaEvolutionSources(source, target), []);
    });

    it('reports temporal intent that contradicts the schema states', () => {
        const source = `schema = { rules = [
          { declaration_id = "name", path:sansa = $.contact.name, constraints = { type = "StringLiteral" } }
        ] }`;
        const target = `schema = {
          evolution = [{ change_id = "wrong", kind = "move", from_declarations = ["name"], to_declarations = ["name"] }]
          rules = [{ declaration_id = "name", path:sansa = $.contact.displayName, constraints = { type = "StringLiteral" } }]
        }`;

        assert.deepStrictEqual(validateSchemaEvolutionSources(source, target), [{
            changeId: 'wrong',
            code: 'TEMPORAL_KIND_MISMATCH',
            message: "The declared 'move' intent does not match the source and target schema states.",
        }]);
    });
});
