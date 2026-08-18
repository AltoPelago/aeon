import { describe, it } from 'node:test';
import assert from 'node:assert';
import { diffSchemaSources, inferSchemaFromAeon, SchemaInferenceError } from './schema-tools.js';

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
            { path: '$.contacts', constraints: { required: true, type: 'ListNode' } },
            { path: '$.contacts[0]', constraints: { required: true, type: 'ObjectNode' } },
            { path: '$.contacts[0].name', constraints: { required: true, type: 'StringLiteral', datatype: 'string' } },
            { path: '$.contacts[0].active', constraints: { required: true, type: 'BooleanLiteral', datatype: 'boolean' } },
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
});
