/**
 * @aeos/cts-runner - Types
 */

export type Span = [number, number] | null;

export interface AESEventValue {
    type: string;
    raw?: string;
    span?: Span;
    [k: string]: unknown;
}

export interface AESEvent {
    path: unknown;
    value: AESEventValue;
    key?: string;
    span?: Span;
    [k: string]: unknown;
}

export interface SchemaRule {
    path: string;
    constraints: Record<string, unknown>;
}

export interface SchemaV1 {
    rules: SchemaRule[];
}

export interface ResultError {
    path: string;
    span: Span;
    message: string;
    phase: string;
    code: string;
}

export interface ResultEnvelope {
    ok: boolean;
    errors: ResultError[];
    warnings: ResultError[];
    guarantees: Record<string, string[]>;
    [k: string]: unknown;
}

export interface CTSTest {
    id: string;
    description: string;
    input: {
        aes: AESEvent[];
        schema: SchemaV1;
        options?: {
            strict?: boolean;
            mode?: 'v1';
            trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';
            [k: string]: unknown;
        };
    };
    expected: {
        ok: boolean;
        errors: Array<{ path: string; code: string; phase: string; span: Span }>;
        warnings: Array<{ path: string; code: string; phase: string; span: Span }>;
        guarantees: Record<string, string[]>;
    };
    assert?: {
        no_mutation?: boolean;
        no_extra_errors?: boolean;
        no_unlisted_guarantee_paths?: boolean;
        guarantees_may_include?: Record<string, string[]>;
    };
}

export interface CTSSuite {
    id: string;
    title: string;
    description?: string;
    tests?: CTSTest[];
    file?: string;
}

export interface CTSFile {
    meta: Record<string, unknown>;
    requirements?: Record<string, unknown>;
    suites: CTSSuite[];
}

export interface RunnerOptions {
    strict: boolean;
    sutPath: string;
    ctsPath: string;
}
