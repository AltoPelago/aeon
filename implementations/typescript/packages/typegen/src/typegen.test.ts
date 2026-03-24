import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTypes } from './index.js';
import type { SchemaV1 } from '@aeos/core';

test('generates nested interface with required and optional fields', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.name', constraints: { type: 'StringLiteral', required: true } },
            { path: '$.age', constraints: { type: 'NumberLiteral' } },
            { path: '$.config', constraints: { type: 'ObjectNode', required: true } },
            { path: '$.config.port', constraints: { type: 'NumberLiteral', required: true } },
            { path: '$.config.host', constraints: { type: 'StringLiteral' } },
        ],
    };

    const result = generateTypes(schema, { rootName: 'ConfigDoc' });

    assert.equal(result.diagnostics.length, 0);
    assert.equal(
        result.code,
        [
            'export interface ConfigDoc {',
            '  age?: number;',
            '  config: {',
            '    host?: string;',
            '    port: number;',
            '  };',
            '  name: string;',
            '}',
            '',
        ].join('\n')
    );
});

test('supports bracket segments and datatype mapping', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$["api-key"]', constraints: { datatype: 'uuid' } },
        ],
    };

    const result = generateTypes(schema, {
        datatypeMap: {
            uuid: 'string & { readonly __brand: "uuid" }',
        },
    });

    assert.equal(result.diagnostics.length, 0);
    assert.match(result.code, /"api-key"\?: string & \{ readonly __brand: "uuid" \};/);
});

test('maps infinity literals to the finalized string union', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.limit', constraints: { type: 'InfinityLiteral', required: true } },
        ],
    };

    const result = generateTypes(schema, { rootName: 'LimitsDoc' });

    assert.equal(result.diagnostics.length, 0);
    assert.equal(
        result.code,
        [
            'export interface LimitsDoc {',
            "  limit: 'Infinity' | '-Infinity';",
            '}',
            '',
        ].join('\n')
    );
});

test('reports invalid schema paths', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: 'name', constraints: { type: 'StringLiteral' } },
        ],
    };

    const result = generateTypes(schema);

    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, 'INVALID_SCHEMA_PATH');
    assert.equal(result.code, 'export interface AeonDocument {\n}\n');
});

test('warns on scalar/object conflict and prefers object shape', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.a', constraints: { type: 'StringLiteral' } },
            { path: '$.a.b', constraints: { type: 'NumberLiteral' } },
        ],
    };

    const result = generateTypes(schema);

    assert.ok(result.diagnostics.some((d) => d.code === 'PATH_TYPE_CONFLICT'));
    assert.match(result.code, /a\?: \{/);
    assert.match(result.code, /b\?: number;/);
});

test('emits runtime binder helper when requested', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.name', constraints: { type: 'StringLiteral', required: true } },
        ],
    };

    const result = generateTypes(schema, {
        rootName: 'AppConfig',
        emitRuntimeBinder: true,
    });

    assert.equal(result.diagnostics.length, 0);
    assert.match(result.code, /import \{ createTypedRuntimeBinder, type TypedBinderOptions, type TypedRuntimeResult \} from '@aeon\/runtime';/);
    assert.match(result.code, /export const AppConfigSchema: SchemaV1 = \{/);
    assert.match(result.code, /export function bindAppConfig\(options: TypedBinderOptions<AppConfig> = \{\}\): \(input: string\) => TypedRuntimeResult<AppConfig> \{/);
});

test('falls back invalid binder identifiers with diagnostics', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.name', constraints: { type: 'StringLiteral' } },
        ],
    };

    const result = generateTypes(schema, {
        rootName: 'ConfigDoc',
        emitRuntimeBinder: true,
        schemaConstName: 'schema-name',
        binderName: 'bind-config',
    });

    assert.ok(result.diagnostics.some((d) => d.code === 'INVALID_SCHEMA_CONST_NAME'));
    assert.ok(result.diagnostics.some((d) => d.code === 'INVALID_BINDER_NAME'));
    assert.match(result.code, /export const ConfigDocSchema: SchemaV1 = \{/);
    assert.match(result.code, /export function bindConfigDoc\(/);
});
