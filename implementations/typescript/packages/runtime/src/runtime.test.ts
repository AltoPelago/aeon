import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypedRuntimeBinder, runRuntime, runTypedRuntime } from './index.js';
import type { SchemaV1 } from '@aeos/core';

test('runs compile -> schema -> resolve -> finalize in strict mode', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.copy', constraints: { type: 'CloneReference' } },
        ],
    };

    const result = runRuntime('name = "AEON"\ncopy = ~name', {
        schema,
        mode: 'strict',
        output: 'json',
    });

    assert.equal(result.meta.errors.length, 0);
    assert.equal((result.document as Record<string, unknown>).name, 'AEON');
    assert.equal((result.document as Record<string, unknown>).copy, 'AEON');
});

test('strict mode stops after schema errors', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.missing', constraints: { required: true } },
        ],
    };

    const result = runRuntime('name = "AEON"', {
        schema,
        mode: 'strict',
    });

    assert.ok(result.aes.length > 0);
    assert.equal(result.document, undefined);
    assert.ok(result.meta.errors.some((diag) => diag.phase === 6));
});

test('runtime rejects inputs that exceed maxInputBytes', () => {
    const result = runRuntime('name = "AEON"', {
        mode: 'strict',
        maxInputBytes: 4,
    });

    assert.equal(result.aes.length, 0);
    assert.equal(result.document, undefined);
    assert.ok(result.meta.errors.some((diag) => diag.code === 'INPUT_SIZE_EXCEEDED' && diag.phase === 5));
});

test('loose mode continues after schema errors', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.missing', constraints: { required: true } },
        ],
    };

    const result = runRuntime('name = "AEON"', {
        schema,
        mode: 'loose',
        output: 'json',
    });

    assert.ok(result.meta.errors.some((diag) => diag.phase === 6));
    assert.ok(result.document);
    assert.equal((result.document as Record<string, unknown>).name, 'AEON');
});

test('runtime supports linked-json pointer aliases as live getters and setters', () => {
    const result = runRuntime('a = 2\nb = ~>a', {
        mode: 'strict',
        output: 'linked-json',
    });

    assert.equal(result.meta.errors.length, 0);
    const document = result.document as Record<string, unknown>;
    assert.equal(document.a, 2);
    assert.equal(document.b, 2);

    document.a = 5;
    assert.equal(document.b, 5);

    document.b = 9;
    assert.equal(document.a, 9);
});

test('skips in-profile processors to preserve phase ordering', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.copy', constraints: { type: 'CloneReference' } },
        ],
    };

    const result = runRuntime('name = "AEON"\ncopy = ~name', {
        profile: 'json',
        schema,
        mode: 'strict',
        output: 'json',
    });

    assert.equal(result.meta.errors.length, 0);
    assert.ok(result.meta.warnings.some((diag) => diag.code === 'PROFILE_PROCESSORS_SKIPPED'));
    assert.equal((result.document as Record<string, unknown>).copy, 'AEON');
});

test('typed runtime returns typed document', () => {
    interface AppConfig {
        name: string;
        port: number;
    }

    const schema: SchemaV1 = {
        rules: [
            { path: '$.name', constraints: { type: 'StringLiteral', required: true } },
            { path: '$.port', constraints: { type: 'NumberLiteral', required: true } },
        ],
    };

    const result = runTypedRuntime<AppConfig>('name = "AEON"\nport = 8080', { schema });

    assert.equal(result.meta.errors.length, 0);
    assert.equal(result.document?.name, 'AEON');
    assert.equal(result.document?.port, 8080);
});

test('typed runtime guard fails closed in strict mode', () => {
    interface EnabledDoc {
        enabled: true;
    }

    const schema: SchemaV1 = {
        rules: [
            { path: '$.enabled', constraints: { type: 'BooleanLiteral', required: true } },
        ],
    };

    const result = runTypedRuntime<EnabledDoc>('enabled = false', {
        schema,
        mode: 'strict',
        guard(value: unknown): value is EnabledDoc {
            if (!value || typeof value !== 'object') return false;
            return (value as { enabled?: unknown }).enabled === true;
        },
    });

    assert.equal(result.document, undefined);
    assert.ok(result.meta.errors.some((d) => d.code === 'TYPE_GUARD_FAILED' && d.phase === 8));
});

test('typed runtime guard warns in loose mode and keeps output', () => {
    interface EnabledDoc {
        enabled: true;
    }

    const schema: SchemaV1 = {
        rules: [
            { path: '$.enabled', constraints: { type: 'BooleanLiteral', required: true } },
        ],
    };

    const result = runTypedRuntime<EnabledDoc>('enabled = false', {
        schema,
        mode: 'loose',
        guard(value: unknown): value is EnabledDoc {
            if (!value || typeof value !== 'object') return false;
            return (value as { enabled?: unknown }).enabled === true;
        },
    });

    assert.equal((result.document as { enabled: boolean }).enabled, false);
    assert.ok(result.meta.warnings.some((d) => d.code === 'TYPE_GUARD_FAILED' && d.phase === 8));
});

test('typed runtime binder reuses schema', () => {
    interface NameDoc {
        name: string;
    }

    const schema: SchemaV1 = {
        rules: [
            { path: '$.name', constraints: { type: 'StringLiteral', required: true } },
        ],
    };

    const bind = createTypedRuntimeBinder<NameDoc>(schema);
    const result = bind('name = "AEON"');

    assert.equal(result.meta.errors.length, 0);
    assert.equal(result.document?.name, 'AEON');
});

test('runtime supports projected materialization without rejecting extra fields', () => {
    const schema: SchemaV1 = {
        rules: [
            { path: '$.app.name', constraints: { type: 'StringLiteral', required: true } },
            { path: '$.app.port', constraints: { type: 'NumberLiteral', required: true } },
        ],
    };

    const result = runRuntime('app = { name = "AEON", port = 8080, debug = true }', {
        schema,
        mode: 'strict',
        output: 'json',
        materialization: 'projected',
        includePaths: ['$.app.name', '$.app.port'],
    });

    assert.equal(result.meta.errors.length, 0);
    assert.deepEqual(result.document, {
        app: {
            name: 'AEON',
            port: 8080,
        },
    });
});

test('runtime rejects extra fields when schema world is closed', () => {
    const schema: SchemaV1 = {
        world: 'closed',
        rules: [
            { path: '$.app.name', constraints: { type: 'StringLiteral', required: true } },
        ],
    };

    const result = runRuntime('app = { name = "AEON", debug = true }', {
        schema,
        mode: 'strict',
        output: 'json',
    });

    assert.ok(result.meta.errors.some((diag) => diag.code === 'unexpected_binding' && diag.phase === 6));
    assert.equal(result.document, undefined);
});

test('runtime optionally includes annotation stream records', () => {
    const result = runRuntime('//# docs\na = 1 //? required', {
        mode: 'strict',
        output: 'json',
        includeAnnotations: true,
    });

    assert.equal(result.meta.errors.length, 0);
    assert.ok(Array.isArray(result.annotations));
    assert.deepEqual(result.annotations?.map((entry) => entry.kind), ['doc', 'hint']);
});

test('runtime enforces maxSeparatorDepth and allows override', () => {
    const strictFail = runRuntime('a:grid[|][/] = ^1|2/3', {
        mode: 'strict',
        output: 'json',
    });

    assert.ok(strictFail.meta.errors.some((diag) => diag.code === 'SEPARATOR_DEPTH_EXCEEDED'));
    assert.equal(strictFail.document, undefined);

    const strictPass = runRuntime('a:grid[|][/] = ^1|2/3', {
        mode: 'strict',
        output: 'json',
        maxSeparatorDepth: 8,
    });

    assert.equal(strictPass.meta.errors.length, 0);
    assert.equal((strictPass.document as Record<string, unknown>).a, '1|2/3');
});

test('runtime forwards trailing separator delimiter policy into schema validation', () => {
    const schema: SchemaV1 = { rules: [] };
    const input = 'line:set[|] = ^0|0|0|';

    const warned = runRuntime(input, {
        schema,
        mode: 'strict',
        output: 'json',
        maxSeparatorDepth: 8,
        trailingSeparatorDelimiterPolicy: 'warn',
    });
    assert.equal(warned.meta.errors.length, 0);
    assert.ok(warned.meta.warnings.some((diag) => diag.code === 'trailing_separator_delimiter' && diag.phase === 6));
    assert.ok(warned.document);

    const errored = runRuntime(input, {
        schema,
        mode: 'strict',
        output: 'json',
        maxSeparatorDepth: 8,
        trailingSeparatorDelimiterPolicy: 'error',
    });
    assert.ok(errored.meta.errors.some((diag) => diag.code === 'trailing_separator_delimiter' && diag.phase === 6));
    assert.equal(errored.document, undefined);
});

test('runtime supports header and full finalization scopes', () => {
    const input = 'aeon:mode = "strict"\naeon:profile = "aeon.gp.profile.v1"\nname:string = "AEON"';

    const headerOnly = runRuntime(input, {
        mode: 'strict',
        output: 'json',
        scope: 'header',
    });
    assert.deepEqual(headerOnly.document, {
        mode: 'strict',
        profile: 'aeon.gp.profile.v1',
    });

    const full = runRuntime(input, {
        mode: 'strict',
        output: 'json',
        scope: 'full',
    });
    assert.deepEqual(full.document, {
        header: {
            mode: 'strict',
            profile: 'aeon.gp.profile.v1',
        },
        payload: {
            name: 'AEON',
        },
    });
});

test('runtime enforces datatypePolicy for strict header mode', () => {
    const input = 'aeon:mode = "strict"\nstroke:myColor = #ff00ff';

    const rejected = runRuntime(input, {
        mode: 'strict',
        output: 'json',
    });
    assert.ok(rejected.meta.errors.some((diag) => diag.code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
    assert.equal(rejected.document, undefined);

    const allowed = runRuntime(input, {
        mode: 'strict',
        datatypePolicy: 'allow_custom',
        output: 'json',
    });
    assert.equal(allowed.meta.errors.length, 0);
    assert.equal((allowed.document as Record<string, unknown>).stroke, 'ff00ff');
});

test('runtime preset rich enables allow_custom datatype policy', () => {
    const input = 'aeon:mode = "strict"\nstroke:myColor = #ff00ff';

    const result = runRuntime(input, {
        mode: 'strict',
        preset: 'rich',
        output: 'json',
    });

    assert.equal(result.meta.errors.length, 0);
    assert.equal((result.document as Record<string, unknown>).stroke, 'ff00ff');
});
