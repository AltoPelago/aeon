import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { compile, formatPath, type CompileResult, type AEONError } from '@aeon/core';
import { finalizeJson, finalizeMap, type FinalizeMeta, type FinalizeOptions } from '@aeon/finalize';
import { computeCanonicalHash, generateEd25519KeyPair, signStringPayload } from '@aeon/integrity';
import { runTypedRuntime } from './runtime-bind.js';
import type { SchemaV1 } from '@aeos/core';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, 'main.js');
const fixture = (name: string) => path.resolve(__dirname, '../tests/fixtures', name);
const baselineContractsSampleText = () => [
    'aeon:mode = "strict"',
    'aeon:profile = "aeon.gp.profile.v1"',
    'aeon:schema = "aeon.gp.schema.v1"',
    '',
    'app:object = {',
    '  name:string = "AEON"',
    '  port:int32 = 8080',
    '}',
].join('\n');

const normalize = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
            env: {
                ...process.env,
                ...env,
            },
        });
        return { code: 0, stdout, stderr };
    } catch (err) {
        const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; exitCode?: unknown };
        const code =
            (typeof e.exitCode === 'number' ? e.exitCode : undefined) ??
            (typeof e.code === 'number' ? e.code : undefined) ??
            1;
        return {
            code,
            stdout: typeof e.stdout === 'string' ? e.stdout : '',
            stderr: typeof e.stderr === 'string' ? e.stderr : '',
        };
    }
}

function createDefaultSpecsRootFixture(): { specsRoot: string; registryPath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-specs-root-'));
    const contractsDir = path.join(tmpDir, 'aeon', 'v1', 'drafts', 'contracts');
    fs.mkdirSync(contractsDir, { recursive: true });

    const schemaArtifact = `${schemaContractAeonText('aeon.gp.schema.v1')}\n`;
    const profileArtifact = 'profile_id = "aeon.gp.profile.v1"\nprofile_version = "1.0.0"\n';
    fs.writeFileSync(path.join(contractsDir, 'schema.aeon'), schemaArtifact, 'utf-8');
    fs.writeFileSync(path.join(contractsDir, 'profile.aeon'), profileArtifact, 'utf-8');

    const registry = {
        contracts: [
            {
                id: 'aeon.gp.profile.v1',
                kind: 'profile',
                version: '1.0.0',
                path: 'profile.aeon',
                sha256: sha256Hex(profileArtifact),
                status: 'active',
            },
            {
                id: 'aeon.gp.schema.v1',
                kind: 'schema',
                version: '1.0.0',
                path: 'schema.aeon',
                sha256: sha256Hex(schemaArtifact),
                status: 'active',
            },
        ],
    };

    const registryPath = path.join(contractsDir, 'registry.json');
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
    return { specsRoot: tmpDir, registryPath };
}

async function runCliWithStdin(args: string[], input: string) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cliPath, ...args], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });

        child.stdin.end(input);
    });
}

function sha256Hex(input: string | Buffer): string {
    return createHash('sha256').update(input).digest('hex');
}

function schemaContractAeonText(schemaId: string = 'aeon.gp.schema.v1'): string {
    return [
        `schema_id = "${schemaId}"`,
        'schema_version = "1.0.0"',
        'rules = [',
        '  { path = "$.app.name", constraints = { type = "StringLiteral", required = true } }',
        '  { path = "$.app.port", constraints = { type = "NumberLiteral", required = true } }',
        ']',
    ].join('\n');
}

function schemaContractWithGpDatatypeRulesAeonText(schemaId: string = 'aeon.gp.schema.v1'): string {
    return [
        `schema_id = "${schemaId}"`,
        'schema_version = "1.0.0"',
        'rules = []',
        'datatype_rules = {',
        '  uint = { type = "IntegerLiteral", sign = "unsigned" }',
        '}',
    ].join('\n');
}

function toCliJson(result: CompileResult) {
    const visibleEvents = result.events.filter(e => !e.key.startsWith('aeon:'));
    return {
        events: visibleEvents.map(event => ({
            path: formatPath(event.path),
            key: event.key,
            datatype: event.datatype ?? null,
            span: event.span,
            value: jsonSafe(event.value),
        })),
        errors: result.errors.map(error => ({
            code: (error as { code?: string }).code,
            path: getErrorPath(error) ?? '$',
            span: (error as { span?: unknown }).span,
            message: error.message,
        })),
    };
}

function jsonSafe(value: unknown): unknown {
    if (value instanceof Map) {
        return Object.fromEntries(
            Array.from(value.entries(), ([key, entry]) => [String(key), jsonSafe(entry)]),
        );
    }
    if (Array.isArray(value)) {
        return value.map(jsonSafe);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
        );
    }
    return value;
}

function toFinalizeCliJson(result: CompileResult, options: FinalizeOptions = { mode: 'strict' }) {
    const finalized = finalizeJson(result.events, {
        ...options,
        ...(result.header ? { header: result.header } : {}),
    });
    const meta = mergeDiagnostics(finalized, result.errors);
    return Object.keys(meta).length > 0
        ? { document: finalized.document, meta }
        : { document: finalized.document };
}

function toFinalizeMapCliJson(result: CompileResult, options: FinalizeOptions = { mode: 'strict' }) {
    const finalized = finalizeMap(result.events, {
        ...options,
        ...(result.header ? { header: result.header } : {}),
    });
    const meta = mergeDiagnostics(finalized, result.errors);
    const entries = Array.from(finalized.document.entries.values()).map(entry => ({
        path: entry.path,
        value: entry.value,
        span: entry.span,
        ...(entry.datatype ? { datatype: entry.datatype } : {}),
        ...(entry.annotations ? { annotations: mapAnnotations(entry.annotations) } : {}),
    }));
    const document = { entries };
    return Object.keys(meta).length > 0
        ? { document, meta }
        : { document };
}

function formatSpan(span: unknown): string {
    if (!span || typeof span !== 'object') return '?:?-?:?';
    const start = (span as { start?: unknown }).start;
    const end = (span as { end?: unknown }).end;
    if (!start || !end || typeof start !== 'object' || typeof end !== 'object') return '?:?-?:?';
    const sl = (start as { line?: unknown }).line;
    const sc = (start as { column?: unknown }).column;
    const el = (end as { line?: unknown }).line;
    const ec = (end as { column?: unknown }).column;
    if ([sl, sc, el, ec].some(v => typeof v !== 'number')) return '?:?-?:?';
    return `${sl}:${sc}-${el}:${ec}`;
}

function getErrorPath(error: AEONError): string | undefined {
    const candidate = (error as unknown as { path?: unknown }).path;
    if (typeof candidate === 'string') {
        return candidate;
    }
    if (candidate && typeof candidate === 'object' && 'segments' in (candidate as Record<string, unknown>)) {
        return formatPath(candidate as Parameters<typeof formatPath>[0]);
    }
    return undefined;
}

function formatErrorLine(error: AEONError): string {
    const code = (error as { code?: string }).code ?? 'UNKNOWN';
    const errPath = getErrorPath(error) ?? '$';
    const span = formatSpan((error as { span?: unknown }).span);
    const message = String(error.message).replace(/[\r\n]+/g, ' ');
    const phaseLabel = getPhaseLabel(error as { code?: string; phase?: unknown });
    const prefix = phaseLabel ? `${phaseLabel}: ` : '';
    return `${prefix}${message} [${code}] path=${errPath} span=${span}`;
}

function phaseNumberLabel(phase: number | undefined): string | undefined {
    switch (phase) {
        case 0:
            return 'Input Validation';
        case 5:
            return 'Profile Compilation';
        case 6:
            return 'Schema Validation';
        case 7:
            return 'Reference Resolution';
        case 8:
            return 'Finalization';
        default:
            return undefined;
    }
}

function inferPhaseLabelFromCode(code: string | undefined): string | undefined {
    switch (code) {
        case 'INPUT_SIZE_EXCEEDED':
            return 'Input Validation';
        case 'UNEXPECTED_CHARACTER':
        case 'UNTERMINATED_BLOCK_COMMENT':
        case 'UNTERMINATED_STRING':
        case 'UNTERMINATED_TRIMTICK':
            return 'Lexical Analysis';
        case 'SYNTAX_ERROR':
        case 'INVALID_SEPARATOR_CHAR':
        case 'SEPARATOR_DEPTH_EXCEEDED':
        case 'GENERIC_DEPTH_EXCEEDED':
            return 'Parsing';
        case 'HEADER_CONFLICT':
        case 'DUPLICATE_CANONICAL_PATH':
        case 'DATATYPE_LITERAL_MISMATCH':
            return 'Core Validation';
        case 'MISSING_REFERENCE_TARGET':
        case 'FORWARD_REFERENCE':
        case 'SELF_REFERENCE':
        case 'ATTRIBUTE_DEPTH_EXCEEDED':
            return 'Reference Validation';
        case 'UNTYPED_SWITCH_LITERAL':
        case 'UNTYPED_VALUE_IN_STRICT_MODE':
        case 'CUSTOM_DATATYPE_NOT_ALLOWED':
        case 'INVALID_NODE_HEAD_DATATYPE':
            return 'Mode Enforcement';
        case 'PROFILE_NOT_FOUND':
        case 'PROFILE_PROCESSORS_SKIPPED':
            return 'Profile Compilation';
        case 'TYPE_GUARD_FAILED':
            return 'Finalization';
        default:
            return code?.startsWith('FINALIZE_') ? 'Finalization' : undefined;
    }
}

function getPhaseLabel(error: { code?: string; phase?: unknown }): string | undefined {
    const phase = typeof error.phase === 'number' ? error.phase : undefined;
    return phaseNumberLabel(phase) ?? inferPhaseLabelFromCode(error.code);
}

function mergeDiagnostics(finalized: { meta?: FinalizeMeta }, errors: readonly AEONError[]) {
    const mergedErrors = [
        ...(finalized.meta?.errors ?? []),
        ...errors.map(toDiagnosticFromError),
    ];
    const mergedWarnings = [
        ...(finalized.meta?.warnings ?? []),
    ];
    const meta: { errors?: unknown[]; warnings?: unknown[] } = {};
    if (mergedErrors.length > 0) meta.errors = mergedErrors;
    if (mergedWarnings.length > 0) meta.warnings = mergedWarnings;
    return meta;
}

function toDiagnosticFromError(error: AEONError) {
    const code = (error as { code?: string }).code;
    return {
        level: 'error',
        message: error.message,
        ...(code ? { code } : {}),
        ...(getErrorPath(error) ? { path: getErrorPath(error) } : {}),
        ...((error as { span?: unknown }).span ? { span: (error as { span?: unknown }).span } : {}),
        ...(getPhaseLabel(error as { code?: string; phase?: unknown })
            ? { phaseLabel: getPhaseLabel(error as { code?: string; phase?: unknown }) }
            : {}),
    };
}

function mapAnnotations(annotations: ReadonlyMap<string, { value: unknown; datatype?: string }>) {
    const entries: Record<string, { value: unknown; datatype?: string }> = {};
    for (const [key, value] of annotations.entries()) {
        entries[key] = {
            value: value.value,
            ...(value.datatype ? { datatype: value.datatype } : {}),
        };
    }
    return entries;
}

describe('AEON CLI output contract', () => {
    describe('aeon check', () => {
        it('returns OK and exit 0 for a valid document', async () => {
            const { code, stdout, stderr } = await runCli(['check', fixture('valid.aeon')]);
            assert.strictEqual(code, 0);
            assert.strictEqual(normalize(stdout), 'OK');
            assert.strictEqual(stderr, '');
        });

        it('returns errors and exit 1 for invalid document', async () => {
            const input = fs.readFileSync(fixture('header-conflict.aeon'), 'utf-8');
            const expected = compile(input);
            const { code, stdout, stderr } = await runCli(['check', fixture('header-conflict.aeon')]);
            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const lines = normalize(stdout).split('\n');
            assert.strictEqual(lines.length, expected.errors.length);
            assert.deepStrictEqual(lines, expected.errors.map(formatErrorLine));
        });

        it('returns exit 2 and stderr for missing file', async () => {
            const { code, stdout, stderr } = await runCli(['check']);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('No file specified'));
        });

        it('fails closed when --max-input-bytes is exceeded', async () => {
            const { code, stdout, stderr } = await runCli([
                'check',
                fixture('valid.aeon'),
                '--max-input-bytes',
                '4',
            ]);
            assert.strictEqual(code, 1);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('exceeds configured limit'));
        });
    });

    describe('aeon doctor', () => {
        it('reports passing environment and registry checks by default', async () => {
            const { specsRoot } = createDefaultSpecsRootFixture();
            const { code, stdout, stderr } = await runCli(['doctor'], {
                AEONITE_SPECS_ROOT: specsRoot,
            });
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const out = normalize(stdout);
            assert.ok(out.includes('[PASS] node-version'));
            assert.ok(out.includes('[PASS] package-availability'));
            assert.ok(out.includes('[PASS] contract-registry'));
            assert.ok(out.includes('[PASS] policy-surface'));
        });

        it('emits JSON output when requested', async () => {
            const { specsRoot } = createDefaultSpecsRootFixture();
            const { code, stdout, stderr } = await runCli(['doctor', '--json'], {
                AEONITE_SPECS_ROOT: specsRoot,
            });
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as { ok: boolean; checks: Array<{ name: string; status: string }> };
            assert.strictEqual(parsed.ok, true);
            assert.ok(parsed.checks.some((check) => check.name === 'contract-registry' && check.status === 'pass'));
        });

        it('fails when the specified registry path is missing', async () => {
            const missing = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
            const { code, stdout, stderr } = await runCli(['doctor', '--contract-registry', missing]);
            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            assert.ok(normalize(stdout).includes('[FAIL] contract-registry'));
        });

        it('fails when a registry artifact hash is invalid', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-doctor-'));
            const contractPath = path.join(tmpDir, 'schema.aeon');
            fs.writeFileSync(contractPath, schemaContractAeonText('aeon.demo.schema.v1'), 'utf-8');
            const registryPath = path.join(tmpDir, 'registry.json');
            fs.writeFileSync(registryPath, JSON.stringify({
                contracts: [{
                    id: 'aeon.demo.schema.v1',
                    kind: 'schema',
                    version: '1.0.0',
                    path: './schema.aeon',
                    sha256: '0'.repeat(64),
                    status: 'active',
                }],
            }, null, 2), 'utf-8');

            const { code, stdout, stderr } = await runCli(['doctor', '--contract-registry', registryPath, '--json']);
            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                ok: boolean;
                checks: Array<{ name: string; status: string; details?: { entries?: Array<{ code?: string }> } }>;
            };
            assert.strictEqual(parsed.ok, false);
            const registryCheck = parsed.checks.find((check) => check.name === 'contract-registry');
            assert.ok(registryCheck);
            assert.strictEqual(registryCheck?.status, 'fail');
            assert.ok(registryCheck?.details?.entries?.some((entry) => entry.code === 'CONTRACT_ARTIFACT_HASH_MISMATCH'));
        });
    });

    describe('aeon fmt', () => {
        it('formats a file to stdout', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-fmt-'));
            const file = path.join(tmpDir, 'sample.aeon');
            fs.writeFileSync(file, 'b = 1\na = 2\n', 'utf-8');

            const { code, stdout, stderr } = await runCli(['fmt', file]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.strictEqual(normalize(stdout), normalize([
                'aeon:header = {',
                '  encoding = "utf-8"',
                '  mode = "transport"',
                '  profile = "core"',
                '  version = 1.0',
                '}',
                'a = 2',
                'b = 1',
            ].join('\n')));
            assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'b = 1\na = 2\n');
        });

        it('formats stdin to stdout when no file is provided', async () => {
            const { code, stdout, stderr } = await runCliWithStdin(['fmt'], 'b = 1\na = 2\n');
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.strictEqual(normalize(stdout), normalize([
                'aeon:header = {',
                '  encoding = "utf-8"',
                '  mode = "transport"',
                '  profile = "core"',
                '  version = 1.0',
                '}',
                'a = 2',
                'b = 1',
            ].join('\n')));
        });

        it('fails closed on invalid input', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-fmt-'));
            const file = path.join(tmpDir, 'invalid.aeon');
            fs.writeFileSync(file, 'a = {\n', 'utf-8');

            const { code, stdout, stderr } = await runCli(['fmt', file]);
            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const lines = normalize(stdout).split('\n');
            assert.ok(lines.length >= 1);
            assert.ok(lines.every((line) => line.includes('[') && line.includes('path=$')));
        });

        it('rejects structured headers that appear after body bindings', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-fmt-'));
            const file = path.join(tmpDir, 'late-header.aeon');
            fs.writeFileSync(file, [
                'app:object = {',
                '  name:string = "playground"',
                '}',
                'aeon:header = {',
                '  mode:string = "strict"',
                '}',
            ].join('\n'), 'utf-8');

            const { code, stdout, stderr } = await runCli(['fmt', file]);
            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            assert.ok(stdout.includes('[SYNTAX_ERROR]'));
            assert.ok(stdout.includes('Structured headers must precede body bindings'));
        });

        it('writes formatted output back to file and skips backup on second no-op run', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-fmt-'));
            const file = path.join(tmpDir, 'sample.aeon');
            fs.writeFileSync(file, 'b = 1\na = 2\n', 'utf-8');

            const first = await runCli(['fmt', file, '--write']);
            assert.strictEqual(first.code, 0);
            assert.strictEqual(first.stdout, '');
            assert.strictEqual(first.stderr, '');
            const formatted = fs.readFileSync(file, 'utf-8');
            assert.strictEqual(normalize(formatted), normalize([
                'aeon:header = {',
                '  encoding = "utf-8"',
                '  mode = "transport"',
                '  profile = "core"',
                '  version = 1.0',
                '}',
                'a = 2',
                'b = 1',
            ].join('\n')));
            assert.ok(fs.existsSync(`${file}.bak`));

            const second = await runCli(['fmt', file, '--write']);
            assert.strictEqual(second.code, 0);
            assert.strictEqual(second.stdout, '');
            assert.strictEqual(second.stderr, '');
            assert.ok(!fs.existsSync(`${file}.bak1`));
            assert.strictEqual(fs.readFileSync(file, 'utf-8'), formatted);
        });

        it('rejects --write without a file path', async () => {
            const { code, stdout, stderr } = await runCli(['fmt', '--write']);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('--write requires a file path'));
        });
    });

    describe('aeon inspect (markdown)', () => {
        it('renders summary and events for a valid document', async () => {
            const { code, stdout, stderr } = await runCli(['inspect', fixture('valid.aeon')]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const expected = normalize(`# AEON Inspect

## Summary
- File: valid.aeon
- Version: —
- Mode: transport
- Profile: —
- Schema: —
- Recovery: false
- Events: 2
- Errors: 0

## Assignment Events
- $.a :int32 = 1
- $.b = ~a

## References
- $.b = ~a
`);
            assert.strictEqual(normalize(stdout), expected);
        });

        it('is fail-closed (errors only, no events) when invalid', async () => {
            const { code, stdout } = await runCli(['inspect', fixture('duplicate-binding.aeon')]);
            assert.strictEqual(code, 1);
            const out = normalize(stdout);
            assert.ok(out.includes('## Errors'));
            assert.ok(!out.includes('## Assignment Events'));
        });

        it('shows recovery banner and partial events when --recovery is used', async () => {
            const { code, stdout } = await runCli(['inspect', fixture('recovery-duplicate-binding.aeon'), '--recovery']);
            assert.strictEqual(code, 1);
            const out = normalize(stdout);
            assert.ok(out.includes('# AEON Inspect'));
            assert.ok(out.includes('> WARNING: recovery mode enabled (tooling-only); output may be partial'));
            assert.ok(out.includes('Recovery: true'));
            assert.ok(out.includes('## Assignment Events'));
        });

        it('reports untyped switch literal in strict mode (fail-closed)', async () => {
            const { code, stdout } = await runCli(['inspect', fixture('untyped-switch-strict.aeon')]);
            assert.strictEqual(code, 1);
            const out = normalize(stdout);
            assert.ok(out.includes('[UNTYPED_SWITCH_LITERAL]'));
            assert.ok(!out.includes('## Assignment Events'));
        });

        it('accepts typed switch literal in strict mode', async () => {
            const { code, stdout, stderr } = await runCli(['inspect', fixture('typed-switch-strict.aeon')]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const out = normalize(stdout);
            assert.ok(out.includes('Mode: strict'));
            assert.ok(out.includes('Errors: 0'));
            assert.ok(out.includes('## Assignment Events'));
            assert.ok(out.includes(':switch'));
            assert.ok(out.includes('$.friend'));
        });

        it('keeps clone/pointer references symbolic (no resolution)', async () => {
            const { code, stdout, stderr } = await runCli(['inspect', fixture('references-symbolic.aeon')]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const out = normalize(stdout);
            assert.ok(out.includes('## Assignment Events'));
            assert.ok(out.includes('= ~target.x'));
            assert.ok(out.includes('= ~>target.x'));
            assert.ok(out.includes('## References'));
            assert.ok(out.includes('$.clone = ~target.x'));
            assert.ok(out.includes('$.ptr = ~>target.x'));
        });
    });

    describe('aeon inspect --json', () => {
        it('returns deterministic events+errors shape', async () => {
            const input = fs.readFileSync(fixture('valid.aeon'), 'utf-8');
            const expected = toCliJson(compile(input));
            const { code, stdout, stderr } = await runCli(['inspect', fixture('valid.aeon'), '--json']);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.deepStrictEqual(parsed, expected);
        });

        it('exits 2 and prints usage error on stderr when file missing', async () => {
            const { code, stdout, stderr } = await runCli(['inspect']);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('No file specified'));
        });

        it('includes annotation records when --annotations is provided', async () => {
            const { code, stdout, stderr } = await runCli([
                'inspect',
                fixture('inspect-annotations.aeon'),
                '--json',
                '--annotations',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                annotations?: Array<{
                    kind: string;
                    form: string;
                    target: { kind: string; path?: string };
                    raw: string;
                }>;
            };
            assert.ok(Array.isArray(parsed.annotations));
            assert.deepStrictEqual(parsed.annotations?.map((entry) => entry.kind), ['doc', 'hint', 'annotation']);
            assert.deepStrictEqual(parsed.annotations?.map((entry) => entry.target), [
                { kind: 'path', path: '$.a' },
                { kind: 'path', path: '$.a' },
                { kind: 'path', path: '$.b' },
            ]);
        });

        it('outputs only annotations when --annotations-only is provided', async () => {
            const { code, stdout, stderr } = await runCli([
                'inspect',
                fixture('inspect-annotations.aeon'),
                '--json',
                '--annotations-only',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                annotations: Array<{
                    kind: string;
                    form: string;
                    raw: string;
                }>;
                events?: unknown;
                errors?: unknown;
            };
            assert.ok(Array.isArray(parsed.annotations));
            assert.strictEqual(parsed.annotations.length, 3);
            assert.strictEqual('events' in parsed, false);
            assert.strictEqual('errors' in parsed, false);
        });

        it('serializes node attribute entry maps in JSON output', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cli-node-attrs-'));
            const file = path.join(dir, 'node-attrs.aeon');
            fs.writeFileSync(
                file,
                'content:node = <span@{id="text", class:string="dark"}("hello")>\n',
                'utf-8',
            );
            const { code, stdout, stderr } = await runCli(['inspect', file, '--json']);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                events: Array<{
                    value: {
                        type: string;
                        attributes?: Array<{
                            entries?: Record<string, {
                                datatype?: null | { type?: string; name?: string };
                                value?: { type?: string; value?: string; raw?: string; delimiter?: string };
                            }>;
                        }>;
                    };
                }>;
            };
            const node = parsed.events[0]?.value;
            assert.strictEqual(node?.type, 'NodeLiteral');
            assert.strictEqual(node?.attributes?.[0]?.entries?.id?.datatype, null);
            assert.strictEqual(node?.attributes?.[0]?.entries?.id?.value?.type, 'StringLiteral');
            assert.strictEqual(node?.attributes?.[0]?.entries?.id?.value?.value, 'text');
            assert.strictEqual(node?.attributes?.[0]?.entries?.id?.value?.raw, 'text');
            assert.strictEqual(node?.attributes?.[0]?.entries?.id?.value?.delimiter, '"');
            assert.strictEqual(node?.attributes?.[0]?.entries?.class?.datatype?.type, 'TypeAnnotation');
            assert.strictEqual(node?.attributes?.[0]?.entries?.class?.datatype?.name, 'string');
            assert.strictEqual(node?.attributes?.[0]?.entries?.class?.value?.type, 'StringLiteral');
            assert.strictEqual(node?.attributes?.[0]?.entries?.class?.value?.value, 'dark');
        });

        it('supports --sort-annotations with annotations-only JSON output', async () => {
            const { code, stdout, stderr } = await runCli([
                'inspect',
                fixture('inspect-annotations.aeon'),
                '--json',
                '--annotations-only',
                '--sort-annotations',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as { annotations: Array<{ span: { start: { offset: number } } }> };
            assert.ok(Array.isArray(parsed.annotations));
            for (let i = 1; i < parsed.annotations.length; i++) {
                const prev = parsed.annotations[i - 1]!.span.start.offset;
                const next = parsed.annotations[i]!.span.start.offset;
                assert.ok(prev <= next);
            }
        });
    });

    describe('aeon inspect --annotations (markdown)', () => {
        it('renders annotation records section when requested', async () => {
            const { code, stdout, stderr } = await runCli(['inspect', fixture('inspect-annotations.aeon'), '--annotations']);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const out = normalize(stdout);
            assert.ok(out.includes('- Annotations: 3'));
            assert.ok(out.includes('## Annotation Records'));
            assert.ok(out.includes('doc line -> $.a'));
            assert.ok(out.includes('hint line -> $.a'));
            assert.ok(out.includes('annotation line -> $.b'));
        });

        it('renders annotation-only markdown when --annotations-only is requested', async () => {
            const { code, stdout, stderr } = await runCli([
                'inspect',
                fixture('inspect-annotations.aeon'),
                '--annotations-only',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const out = normalize(stdout);
            assert.ok(out.startsWith('# AEON Annotations'));
            assert.ok(out.includes('- Count: 3'));
            assert.ok(out.includes('## Annotation Records'));
            assert.ok(!out.includes('## Assignment Events'));
            assert.ok(!out.includes('## Summary'));
        });

        it('supports --sort-annotations for markdown annotation section', async () => {
            const { code, stdout, stderr } = await runCli([
                'inspect',
                fixture('inspect-annotations.aeon'),
                '--annotations-only',
                '--sort-annotations',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const out = normalize(stdout);
            assert.ok(out.includes('# AEON Annotations'));
            assert.ok(out.includes('## Annotation Records'));
        });
    });

    describe('aeon finalize --json', () => {
        it('returns deterministic document shape', async () => {
            const input = fs.readFileSync(fixture('finalize-basic.aeon'), 'utf-8');
            const expected = toFinalizeCliJson(compile(input));
            const { code, stdout, stderr } = await runCli(['finalize', fixture('finalize-basic.aeon'), '--json']);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.deepStrictEqual(parsed, expected);
        });

        it('supports projected materialization with repeated --include-path flags', async () => {
            const input = fs.readFileSync(fixture('finalize-basic.aeon'), 'utf-8');
            const expected = toFinalizeCliJson(compile(input), {
                mode: 'strict',
                materialization: 'projected',
                includePaths: ['$.config.host', '$.flags[0]'],
            });
            const { code, stdout, stderr } = await runCli([
                'finalize',
                fixture('finalize-basic.aeon'),
                '--include-path',
                '$.config.host',
                '--include-path',
                '$.flags[0]',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.deepStrictEqual(parsed, expected);
        });

        it('supports full finalization scope', async () => {
            const input = 'aeon:mode = "strict"\naeon:profile = "aeon.gp.profile.v1"\nname:string = "AEON"\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-finalize-scope-'));
            const inputPath = path.join(tmpDir, 'input.aeon');
            fs.writeFileSync(inputPath, input, 'utf-8');

            const expected = toFinalizeCliJson(compile(input), {
                mode: 'strict',
                scope: 'full',
            });
            const { code, stdout, stderr } = await runCli(['finalize', inputPath, '--scope', 'full']);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.deepStrictEqual(JSON.parse(stdout), expected);
        });

        it('exits 2 and prints usage error on stderr when file missing', async () => {
            const { code, stdout, stderr } = await runCli(['finalize']);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('No file specified'));
        });

        it('rejects --projected without any include paths', async () => {
            const { code, stdout, stderr } = await runCli(['finalize', fixture('finalize-basic.aeon'), '--projected']);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('--projected requires at least one --include-path'));
        });
    });

    describe('aeon finalize --map', () => {
        it('returns deterministic map shape', async () => {
            const input = fs.readFileSync(fixture('finalize-basic.aeon'), 'utf-8');
            const expected = toFinalizeMapCliJson(compile(input));
            const { code, stdout, stderr } = await runCli(['finalize', fixture('finalize-basic.aeon'), '--map']);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.deepStrictEqual(parsed, expected);
        });
    });

    describe('aeon bind', () => {
        it('returns typed runtime output for valid input', async () => {
            const schema = JSON.parse(fs.readFileSync(fixture('bind-schema.json'), 'utf-8')) as SchemaV1;
            const input = fs.readFileSync(fixture('bind-valid.aeon'), 'utf-8');
            const expected = runTypedRuntime<unknown>(input, { schema, mode: 'strict' });

            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.deepStrictEqual(parsed, {
                document: expected.document,
                meta: expected.meta,
            });
        });

        it('supports header-only scope', async () => {
            const schema: SchemaV1 = {
                schema_id: 'aeon.test.schema.v1',
                schema_version: '1.0.0',
                rules: [
                    { path: '$.name', constraints: { type: 'StringLiteral', required: true } },
                    { path: '$.port', constraints: { type: 'NumberLiteral', required: true } },
                ],
            } as SchemaV1;
            const input = 'aeon:mode = "strict"\nname:string = "AEON"\nport:number = 8080\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bind-scope-'));
            const schemaPath = path.join(tmpDir, 'schema.json');
            const inputPath = path.join(tmpDir, 'input.aeon');
            fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf-8');
            fs.writeFileSync(inputPath, input, 'utf-8');

            const expected = runTypedRuntime<unknown>(input, {
                schema,
                mode: 'strict',
                scope: 'header',
            });

            const { code, stdout, stderr } = await runCli([
                'bind',
                inputPath,
                '--schema',
                schemaPath,
                '--scope',
                'header',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.deepStrictEqual(JSON.parse(stdout), {
                document: expected.document,
                meta: expected.meta,
            });
        });

        it('supports projected materialization without rejecting extra fields', async () => {
            const schema: SchemaV1 = {
                schema_id: 'aeon.test.schema.v1',
                schema_version: '1.0.0',
                rules: [
                    { path: '$.app.name', constraints: { type: 'StringLiteral', required: true } },
                    { path: '$.app.port', constraints: { type: 'NumberLiteral', required: true } },
                ],
            } as SchemaV1;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bind-projected-'));
            const schemaPath = path.join(tmpDir, 'schema.json');
            const inputPath = path.join(tmpDir, 'input.aeon');
            fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf-8');
            fs.writeFileSync(inputPath, 'app = { name = "AEON", port = 8080, debug = true }\n', 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                inputPath,
                '--schema',
                schemaPath,
                '--include-path',
                '$.app.name',
                '--include-path',
                '$.app.port',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as { document?: unknown; meta: { errors: unknown[] } };
            assert.deepStrictEqual(parsed.document, {
                app: {
                    name: 'AEON',
                    port: 8080,
                },
            });
            assert.deepStrictEqual(parsed.meta.errors, []);
        });

        it('strict mode fails when schema requirements are not met', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-missing.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--strict',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.equal(parsed.document, undefined);
            assert.ok(Array.isArray(parsed.meta.errors));
            assert.ok(parsed.meta.errors.some((err: { phase?: number }) => err.phase === 6));
            assert.ok(parsed.meta.errors.some((err: { phaseLabel?: string }) => err.phaseLabel === 'Schema Validation'));
        });

        it('fails closed when schema world is closed and unexpected fields are present', async () => {
            const schema: SchemaV1 = {
                schema_id: 'aeon.test.schema.v1',
                schema_version: '1.0.0',
                world: 'closed',
                rules: [
                    { path: '$.app.name', constraints: { type: 'StringLiteral', required: true } },
                ],
            } as SchemaV1;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bind-closed-'));
            const schemaPath = path.join(tmpDir, 'schema.json');
            const inputPath = path.join(tmpDir, 'input.aeon');
            fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf-8');
            fs.writeFileSync(inputPath, 'app = { name = "AEON", debug = true }\n', 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                inputPath,
                '--schema',
                schemaPath,
                '--strict',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: unknown;
                meta: { errors: Array<{ code?: string; phase?: number }> };
            };
            assert.equal(parsed.document, undefined);
            assert.ok(parsed.meta.errors.some((err) => err.code === 'unexpected_binding' && err.phase === 6));
        });

        it('loose mode keeps document but reports errors', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-missing.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--loose',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.ok(parsed.document);
            assert.ok(Array.isArray(parsed.meta.errors));
            assert.ok(parsed.meta.errors.some((err: { phase?: number }) => err.phase === 6));
        });

        it('accepts explicit profile and surfaces processor-skip warning when relevant', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--profile',
                'json',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.ok(parsed.document);
            assert.ok(parsed.meta.warnings.some((warn: { code?: string }) => warn.code === 'PROFILE_PROCESSORS_SKIPPED'));
        });

        it('includes annotations when --annotations is provided', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('inspect-annotations.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--annotations',
                '--loose',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                annotations?: Array<{ kind: string }>;
                meta: { errors: unknown[] };
            };
            assert.ok(Array.isArray(parsed.annotations));
            assert.deepStrictEqual(parsed.annotations?.map((entry) => entry.kind), ['doc', 'hint', 'annotation']);
            assert.ok(Array.isArray(parsed.meta.errors));
        });

        it('returns annotations in successful bind output', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-annotations-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--annotations',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: unknown;
                annotations?: Array<{ kind: string; target: { kind: string; path?: string } }>;
            };
            assert.ok(parsed.document);
            assert.ok(Array.isArray(parsed.annotations));
            assert.deepStrictEqual(parsed.annotations?.map((entry) => entry.kind), ['doc', 'hint', 'annotation']);
            assert.deepStrictEqual(parsed.annotations?.map((entry) => entry.target), [
                { kind: 'path', path: '$.app.name' },
                { kind: 'path', path: '$.app.name' },
                { kind: 'path', path: '$.app.port' },
            ]);
        });

        it('supports sorted bind annotations output', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-annotations-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--annotations',
                '--sort-annotations',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                annotations?: Array<{ span: { start: { offset: number } } }>;
            };
            assert.ok(Array.isArray(parsed.annotations));
            for (let i = 1; i < (parsed.annotations?.length ?? 0); i++) {
                const prev = parsed.annotations?.[i - 1]?.span.start.offset ?? 0;
                const next = parsed.annotations?.[i]?.span.start.offset ?? 0;
                assert.ok(prev <= next);
            }
        });

        it('supports trailing separator delimiter policy warn', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-separator-policy.aeon'),
                '--schema',
                fixture('bind-separator-policy.schema.json'),
                '--trailing-separator-delimiter-policy',
                'warn',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: unknown;
                meta: { errors: Array<{ code?: string }>; warnings: Array<{ code?: string; phase?: number }> };
            };
            assert.ok(parsed.document);
            assert.strictEqual(parsed.meta.errors.length, 0);
            assert.ok(parsed.meta.warnings.some((w) => w.code === 'trailing_separator_delimiter' && w.phase === 6));
        });

        it('supports trailing separator delimiter policy error', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-separator-policy.aeon'),
                '--schema',
                fixture('bind-separator-policy.schema.json'),
                '--trailing-separator-delimiter-policy',
                'error',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: unknown;
                meta: { errors: Array<{ code?: string; phase?: number }> };
            };
            assert.strictEqual(parsed.document, undefined);
            assert.ok(parsed.meta.errors.some((e) => e.code === 'trailing_separator_delimiter' && e.phase === 6));
        });

        it('enforces reserved_only datatype policy by default in strict mode', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-custom-datatype-strict.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--strict',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: unknown;
                meta: { errors: Array<{ code?: string }> };
            };
            assert.strictEqual(parsed.document, undefined);
            assert.ok(parsed.meta.errors.some((e) => e.code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
        });

        it('allows custom datatypes when --datatype-policy allow_custom is set', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-custom-datatype-strict.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--strict',
                '--datatype-policy',
                'allow_custom',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: { app?: { name?: string; port?: number } };
                meta: { errors: Array<{ code?: string }> };
            };
            assert.strictEqual(parsed.meta.errors.length, 0);
            assert.strictEqual(parsed.document?.app?.name, 'AEON');
            assert.strictEqual(parsed.document?.app?.port, 8080);
        });

        it('allows custom datatypes when --rich preset is set', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-custom-datatype-strict.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--strict',
                '--rich',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: { app?: { name?: string; port?: number } };
                meta: { errors: Array<{ code?: string }> };
            };
            assert.strictEqual(parsed.meta.errors.length, 0);
            assert.strictEqual(parsed.document?.app?.name, 'AEON');
            assert.strictEqual(parsed.document?.app?.port, 8080);
        });

        it('allows custom datatypes by default in custom mode', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bind-custom-mode-'));
            const docPath = path.join(tmpDir, 'bind-custom-mode.aeon');
            fs.writeFileSync(docPath, [
                'aeon:mode = "custom"',
                'app:myApp = {',
                '  name:string = "AEON"',
                '  port:int32 = 8080',
                '}',
            ].join('\n'), 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--schema',
                fixture('bind-schema.json'),
                '--strict',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: { app?: { name?: string; port?: number } };
                meta: { errors: Array<{ code?: string }> };
            };
            assert.strictEqual(parsed.meta.errors.length, 0);
            assert.strictEqual(parsed.document?.app?.name, 'AEON');
            assert.strictEqual(parsed.document?.app?.port, 8080);
        });

        it('returns usage error when schema flag is missing', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Missing required --schema'));
        });

        it('returns usage error when profile value is missing', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--profile',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Missing value for --profile'));
        });

        it('returns usage error when trailing separator policy value is missing', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--trailing-separator-delimiter-policy',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Missing value for --trailing-separator-delimiter-policy'));
        });

        it('returns usage error when trailing separator policy value is invalid', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--trailing-separator-delimiter-policy',
                'maybe',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Invalid value for --trailing-separator-delimiter-policy'));
        });

        it('returns usage error when datatype policy value is invalid', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--datatype-policy',
                'invalid',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Invalid value for --datatype-policy'));
        });

        it('returns usage error when --include-path value is missing', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--include-path',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Missing value for --include-path'));
        });

        it('returns usage error when --projected has no include paths', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--projected',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('--projected requires at least one --include-path'));
        });

        it('fails closed when direct schema JSON is missing schema_id', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-schema-json-'));
            const schemaPath = path.join(tmpDir, 'schema.json');
            fs.writeFileSync(schemaPath, JSON.stringify({
                schema_version: '1.0.0',
                rules: [],
            }, null, 2), 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                schemaPath,
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes("missing required string field 'schema_id'"));
        });

        it('fails closed when direct schema JSON uses non-canonical metadata keys', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-schema-json-'));
            const schemaPath = path.join(tmpDir, 'schema.json');
            fs.writeFileSync(schemaPath, JSON.stringify({
                schema_id: 'aeon.gp.schema.v1',
                schemaVersion: '1.0.0',
                rules: [],
            }, null, 2), 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                schemaPath,
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes("Unknown schema contract key 'schemaVersion'"));
        });

        it('resolves schema/profile from trusted contract registry and header IDs', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-'));
            const docPath = path.join(tmpDir, 'contract-bind.aeon');
            const schemaPath = path.join(tmpDir, 'schema.aeon');
            const profileArtifactPath = path.join(tmpDir, 'profile.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            const source = [
                'aeon:mode = "strict"',
                'aeon:profile = "aeon.gp.profile.v1"',
                'aeon:schema = "aeon.gp.schema.v1"',
                'app:object = {',
                '  name:string = "AEON"',
                '  port:int32 = 8080',
                '}',
            ].join('\n');
            fs.writeFileSync(docPath, source, 'utf-8');

            const schemaContract = schemaContractWithGpDatatypeRulesAeonText('aeon.gp.schema.v1');
            fs.writeFileSync(schemaPath, `${schemaContract}\n`, 'utf-8');

            const profileArtifact = 'profile_id = "aeon.gp.profile.v1"\nprofile_version = "1.0.0"\n';
            fs.writeFileSync(profileArtifactPath, profileArtifact, 'utf-8');

            const registry = {
                contracts: [
                    {
                        id: 'aeon.gp.profile.v1',
                        kind: 'profile',
                        version: '1.0.0',
                        path: 'profile.aeon',
                        sha256: sha256Hex(profileArtifact),
                        status: 'active',
                    },
                    {
                        id: 'aeon.gp.schema.v1',
                        kind: 'schema',
                        version: '1.0.0',
                        path: 'schema.aeon',
                        sha256: sha256Hex(`${schemaContract}\n`),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
                '--strict',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: { app?: { name?: string; port?: number } };
                meta: { errors: unknown[] };
            };
            assert.ok(parsed.document);
            assert.strictEqual(parsed.document?.app?.name, 'AEON');
            assert.strictEqual(parsed.document?.app?.port, 8080);
            assert.strictEqual(parsed.meta.errors.length, 0);
        });

        it('resolves schema/profile from repository baseline contracts registry', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-baseline-'));
            const docPath = path.join(tmpDir, 'sample-with-contracts.aeon');
            const schemaPath = path.join(tmpDir, 'schema.aeon');
            const profileArtifactPath = path.join(tmpDir, 'profile.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            fs.writeFileSync(docPath, baselineContractsSampleText(), 'utf-8');
            const schemaContract = schemaContractWithGpDatatypeRulesAeonText('aeon.gp.schema.v1');
            fs.writeFileSync(schemaPath, `${schemaContract}\n`, 'utf-8');

            const profileArtifact = 'profile_id = "aeon.gp.profile.v1"\nprofile_version = "1.0.0"\n';
            fs.writeFileSync(profileArtifactPath, profileArtifact, 'utf-8');

            const registry = {
                contracts: [
                    {
                        id: 'aeon.gp.profile.v1',
                        kind: 'profile',
                        version: '1.0.0',
                        path: 'profile.aeon',
                        sha256: sha256Hex(profileArtifact),
                        status: 'active',
                    },
                    {
                        id: 'aeon.gp.schema.v1',
                        kind: 'schema',
                        version: '1.0.0',
                        path: 'schema.aeon',
                        sha256: sha256Hex(`${schemaContract}\n`),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
                '--strict',
            ]);

            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: { app?: { name?: string; port?: number } };
                meta: { errors: unknown[] };
            };
            assert.ok(parsed.document);
            assert.strictEqual(parsed.document?.app?.name, 'AEON');
            assert.strictEqual(parsed.document?.app?.port, 8080);
            assert.strictEqual(parsed.meta.errors.length, 0);
        });

        it('enforces official GP datatype_rules from repository baseline contracts registry', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-gp-'));
            const docPath = path.join(tmpDir, 'gp-numeric-contracts.aeon');
            const schemaPath = path.join(tmpDir, 'schema.aeon');
            const profileArtifactPath = path.join(tmpDir, 'profile.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            const source = [
                'aeon:mode = "strict"',
                'aeon:profile = "aeon.gp.profile.v1"',
                'aeon:schema = "aeon.gp.schema.v1"',
                'value:uint = -1',
            ].join('\n');
            fs.writeFileSync(docPath, source, 'utf-8');

            const schemaContract = schemaContractWithGpDatatypeRulesAeonText('aeon.gp.schema.v1');
            fs.writeFileSync(schemaPath, `${schemaContract}\n`, 'utf-8');

            const profileArtifact = 'profile_id = "aeon.gp.profile.v1"\nprofile_version = "1.0.0"\n';
            fs.writeFileSync(profileArtifactPath, profileArtifact, 'utf-8');

            const registry = {
                contracts: [
                    {
                        id: 'aeon.gp.profile.v1',
                        kind: 'profile',
                        version: '1.0.0',
                        path: 'profile.aeon',
                        sha256: sha256Hex(profileArtifact),
                        status: 'active',
                    },
                    {
                        id: 'aeon.gp.schema.v1',
                        kind: 'schema',
                        version: '1.0.0',
                        path: 'schema.aeon',
                        sha256: sha256Hex(`${schemaContract}\n`),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
                '--strict',
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout) as {
                document?: { value?: number };
                meta: { errors: Array<{ code?: string; phase?: number; message?: string }> };
            };
            assert.strictEqual(parsed.document, undefined);
            assert.ok(Array.isArray(parsed.meta.errors));
            assert.ok(parsed.meta.errors.some((err) => err.phase === 6));
            assert.ok(parsed.meta.errors.some((err) => err.code === 'numeric_form_violation'));
        });

        it('fails closed when schema contract ID is unknown in trusted registry', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-'));
            const docPath = path.join(tmpDir, 'contract-bind-unknown.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            const source = [
                'aeon:mode = "strict"',
                'aeon:profile = "altopelago.core.v1"',
                'aeon:schema = "missing.schema.id"',
                'app:object = { name:string = "AEON" port:int32 = 8080 }',
            ].join('\n');
            fs.writeFileSync(docPath, source, 'utf-8');

            const profileArtifact = 'profile placeholder for hash verification';
            fs.writeFileSync(path.join(tmpDir, 'profile.aeon'), profileArtifact, 'utf-8');
            const registry = {
                contracts: [
                    {
                        id: 'altopelago.core.v1',
                        kind: 'profile',
                        version: '1.0.0',
                        path: 'profile.aeon',
                        sha256: sha256Hex(profileArtifact),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
            ]);

            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('CONTRACT_UNKNOWN_SCHEMA_ID'));
            assert.ok(stderr.includes('Unknown schema contract id in registry'));
        });

        it('fails closed when profile contract ID is unknown in trusted registry', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-'));
            const docPath = path.join(tmpDir, 'contract-bind-unknown-profile.aeon');
            const schemaPath = path.join(tmpDir, 'schema.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            const source = [
                'aeon:mode = "strict"',
                'aeon:profile = "missing.profile.id"',
                'aeon:schema = "aeon.gp.schema.v1"',
                'app:object = { name:string = "AEON" port:int32 = 8080 }',
            ].join('\n');
            fs.writeFileSync(docPath, source, 'utf-8');

            const schemaContract = schemaContractAeonText('aeon.gp.schema.v1');
            fs.writeFileSync(schemaPath, `${schemaContract}\n`, 'utf-8');

            const registry = {
                contracts: [
                    {
                        id: 'aeon.gp.schema.v1',
                        kind: 'schema',
                        version: '1.0.0',
                        path: 'schema.aeon',
                        sha256: sha256Hex(`${schemaContract}\n`),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
            ]);

            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('CONTRACT_UNKNOWN_PROFILE_ID'));
            assert.ok(stderr.includes('Unknown profile contract id in registry'));
        });

        it('fails closed on contract artifact hash mismatch', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-'));
            const docPath = path.join(tmpDir, 'contract-bind-hash.aeon');
            const schemaPath = path.join(tmpDir, 'schema.aeon');
            const profileArtifactPath = path.join(tmpDir, 'profile.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            const source = [
                'aeon:mode = "strict"',
                'aeon:profile = "altopelago.core.v1"',
                'aeon:schema = "aeon.gp.schema.v1"',
                'app:object = { name:string = "AEON" port:int32 = 8080 }',
            ].join('\n');
            fs.writeFileSync(docPath, source, 'utf-8');

            const schemaContract = schemaContractAeonText('aeon.gp.schema.v1');
            fs.writeFileSync(schemaPath, `${schemaContract}\n`, 'utf-8');

            const profileArtifact = 'profile_id = "altopelago.core.v1"\nprofile_version = "1.0.0"\n';
            fs.writeFileSync(profileArtifactPath, profileArtifact, 'utf-8');

            const registry = {
                contracts: [
                    {
                        id: 'altopelago.core.v1',
                        kind: 'profile',
                        version: '1.0.0',
                        path: 'profile.aeon',
                        sha256: sha256Hex(profileArtifact),
                        status: 'active',
                    },
                    {
                        id: 'aeon.gp.schema.v1',
                        kind: 'schema',
                        version: '1.0.0',
                        path: 'schema.aeon',
                        sha256: '0'.repeat(64),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
            ]);

            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('CONTRACT_ARTIFACT_HASH_MISMATCH'));
            assert.ok(stderr.includes('Contract artifact hash mismatch'));
        });

        it('fails closed when a contract artifact path is missing', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-contract-reg-'));
            const docPath = path.join(tmpDir, 'contract-bind-missing-artifact.aeon');
            const schemaPath = path.join(tmpDir, 'schema.aeon');
            const profileArtifactPath = path.join(tmpDir, 'profile.aeon');
            const registryPath = path.join(tmpDir, 'registry.json');

            const source = [
                'aeon:mode = "strict"',
                'aeon:profile = "altopelago.core.v1"',
                'aeon:schema = "aeon.gp.schema.v1"',
                'app:object = { name:string = "AEON" port:int32 = 8080 }',
            ].join('\n');
            fs.writeFileSync(docPath, source, 'utf-8');

            const schemaContract = schemaContractAeonText('aeon.gp.schema.v1');
            fs.writeFileSync(schemaPath, `${schemaContract}\n`, 'utf-8');

            const profileArtifact = 'profile_id = "altopelago.core.v1"\nprofile_version = "1.0.0"\n';
            fs.writeFileSync(profileArtifactPath, profileArtifact, 'utf-8');

            const registry = {
                contracts: [
                    {
                        id: 'altopelago.core.v1',
                        kind: 'profile',
                        version: '1.0.0',
                        path: 'profile.aeon',
                        sha256: sha256Hex(profileArtifact),
                        status: 'active',
                    },
                    {
                        id: 'aeon.gp.schema.v1',
                        kind: 'schema',
                        version: '1.0.0',
                        path: 'missing-schema.aeon',
                        sha256: '0'.repeat(64),
                        status: 'active',
                    },
                ],
            };
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'bind',
                docPath,
                '--contract-registry',
                registryPath,
            ]);

            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('CONTRACT_ARTIFACT_MISSING'));
            assert.ok(stderr.includes('Missing contract artifact'));
        });

        it('returns usage error when --rich conflicts with --datatype-policy reserved_only', async () => {
            const { code, stdout, stderr } = await runCli([
                'bind',
                fixture('bind-valid.aeon'),
                '--schema',
                fixture('bind-schema.json'),
                '--rich',
                '--datatype-policy',
                'reserved_only',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Invalid value for --datatype-policy'));
        });
    });

    describe('aeon integrity validate', () => {
        it('returns OK for a valid envelope', async () => {
            const { code, stdout, stderr } = await runCli(['integrity', 'validate', fixture('envelope-valid.aeon')]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.strictEqual(normalize(stdout), 'OK');
        });
    });

    describe('aeon integrity verify', () => {
        it('verifies canonical hash against envelope', async () => {
            const body = 'a = 1\n';
            const events = compile(body).events;
            const hash = computeCanonicalHash(events, { algorithm: 'sha-256' }).hash;
            const envelope = [
                'close:envelope = {',
                '  integrity:integrityBlock = {',
                '    alg:string = "sha-256"',
                `    hash:string = "${hash}"`,
                '  }',
                '}',
                '',
            ].join('\n');
            const contents = `${body}${envelope}`;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'envelope-verify.aeon');
            fs.writeFileSync(file, contents, 'utf-8');

            const { code, stdout, stderr } = await runCli(['integrity', 'verify', file]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.strictEqual(normalize(stdout), 'OK');
        });
    });

    describe('aeon integrity validate --json', () => {
        it('returns JSON diagnostics', async () => {
            const { code, stdout, stderr } = await runCli([
                'integrity',
                'validate',
                fixture('envelope-valid.aeon'),
                '--json',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.deepStrictEqual(parsed, {
                ok: true,
                errors: [],
                warnings: [],
            });
        });
    });

    describe('aeon integrity sign', () => {
        it('generates a signed envelope snippet', async () => {
            const body = 'a = 1\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign.aeon');
            fs.writeFileSync(file, body, 'utf-8');

            const { publicKey, privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--json',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.ok(parsed.receipt);
            assert.strictEqual(parsed.receipt.source.mediaType, 'text/aeon');
            assert.strictEqual(parsed.receipt.producer.implementation, 'aeon-cli-ts');
            assert.strictEqual(parsed.receipt.canonical.digestAlgorithm, 'sha-256');
            assert.match(parsed.receipt.generated.at, /^\d{4}-\d{2}-\d{2}T/);
            assert.ok(typeof parsed.receipt.canonical.payload === 'string');
            assert.strictEqual(parsed.envelope.integrity.alg, 'sha-256');
            assert.ok(typeof parsed.envelope.integrity.hash === 'string');
            assert.ok(typeof parsed.envelope.signatures[0].sig === 'string');
            assert.ok(parsed.envelope.signatures[0].sig.length > 0);
            assert.ok(typeof publicKey === 'string');
        });

        it('writes a signed envelope snippet to file', async () => {
            const body = 'a = 1\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign-write.aeon');
            fs.writeFileSync(file, body, 'utf-8');

            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--write',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const written = fs.readFileSync(file, 'utf-8');
            assert.ok(written.includes('close:envelope'));
            assert.ok(written.includes('conventions:conventionSet'));
            assert.ok(written.includes('"aeon.gp.security.v1"'));
            assert.ok(written.includes('"aeon.gp.integrity.v1"'));
            assert.ok(written.includes('"aeon.gp.signature.v1"'));
            assert.ok(fs.existsSync(`${file}.bak`));
            assert.ok(fs.existsSync(`${file}.receipt.json`));
            const receipt = JSON.parse(fs.readFileSync(`${file}.receipt.json`, 'utf-8'));
            assert.strictEqual(receipt.source.mediaType, 'text/aeon');
        });

        it('writes receipt sidecar to an explicit path override', async () => {
            const body = 'a = 1\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign-write-custom.aeon');
            const receiptPath = path.join(tmpDir, 'custom.receipt.json');
            fs.writeFileSync(file, body, 'utf-8');

            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--write',
                '--receipt',
                receiptPath,
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.ok(fs.existsSync(receiptPath));
            assert.ok(!fs.existsSync(`${file}.receipt.json`));
        });

        it('merges missing GP security conventions into an existing structured header', async () => {
            const body = [
                'aeon:header = {',
                '  mode = "strict"',
                '  conventions:conventionSet = [',
                '    "aeon.gp.security.v1"',
                '  ]',
                '}',
                '',
                'a:number = 1',
                '',
            ].join('\n');
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign-write-merge.aeon');
            fs.writeFileSync(file, body, 'utf-8');

            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--write',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const written = fs.readFileSync(file, 'utf-8');
            assert.ok(written.includes('"aeon.gp.security.v1"'));
            assert.ok(written.includes('"aeon.gp.integrity.v1"'));
            assert.ok(written.includes('"aeon.gp.signature.v1"'));
        });
    });

    describe('aeon integrity verify --public-key', () => {
        it('verifies signature with provided public key', async () => {
            const body = 'a = 1\n';
            const events = compile(body).events;
            const hash = computeCanonicalHash(events, { algorithm: 'sha-256' }).hash;
            const { publicKey, privateKey } = generateEd25519KeyPair();
            const signature = signStringPayload(hash, privateKey, { algorithm: 'ed25519' }).signature;
            const envelope = [
                'close:envelope = {',
                '  integrity:integrityBlock = {',
                '    alg:string = "sha-256"',
                `    hash:string = "${hash}"`,
                '  }',
                '  signatures:signatureSet = [',
                '    {',
                '      alg:string = "ed25519"',
                '      kid:string = "default"',
                `      sig:string = "${signature}"`,
                '    }',
                '  ]',
                '}',
                '',
            ].join('\n');
            const contents = `${body}${envelope}`;

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'verify-sig.aeon');
            fs.writeFileSync(file, contents, 'utf-8');

            const pubPath = path.join(tmpDir, 'aeon.pub');
            fs.writeFileSync(pubPath, publicKey, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'integrity',
                'verify',
                file,
                '--public-key',
                pubPath,
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            assert.strictEqual(normalize(stdout), 'OK');
        });
    });

    describe('aeon integrity verify --json', () => {
        it('returns verification metadata', async () => {
            const body = 'a = 1\n';
            const events = compile(body).events;
            const hash = computeCanonicalHash(events, { algorithm: 'sha-256' }).hash;
            const envelope = [
                'close:envelope = {',
                '  integrity:integrityBlock = {',
                '    alg:string = "sha-256"',
                `    hash:string = "${hash}"`,
                '  }',
                '}',
                '',
            ].join('\n');
            const contents = `${body}${envelope}`;

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'verify-json.aeon');
            fs.writeFileSync(file, contents, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'integrity',
                'verify',
                file,
                '--json',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.strictEqual(parsed.ok, true);
            assert.strictEqual(parsed.errors.length, 0);
            assert.ok(parsed.receipt);
            assert.strictEqual(parsed.receipt.source.mediaType, 'text/aeon');
            assert.strictEqual(parsed.receipt.producer.implementation, 'aeon-cli-ts');
            assert.match(parsed.receipt.generated.at, /^\d{4}-\d{2}-\d{2}T/);
            assert.strictEqual(parsed.receipt.canonical.digest, hash);
            assert.ok(parsed.verification);
            assert.strictEqual(parsed.verification.canonical.algorithm, 'sha-256');
            assert.strictEqual(parsed.verification.canonical.expected, hash);
            assert.strictEqual(typeof parsed.verification.canonical.computed, 'string');
            assert.strictEqual(typeof parsed.verification.canonicalStream.length, 'number');
            assert.strictEqual(parsed.verification.replay.performed, true);
            assert.strictEqual(parsed.verification.replay.status, 'match');
            assert.strictEqual(parsed.verification.bytes.present, false);
            assert.strictEqual(parsed.verification.checksum.present, false);
            assert.strictEqual(parsed.verification.signature.present, false);
        });

        it('prefers an explicit receipt sidecar when provided', async () => {
            const body = 'a = 1\n';
            const events = compile(body).events;
            const hash = computeCanonicalHash(events, { algorithm: 'sha-256' }).hash;
            const envelope = [
                'close:envelope = {',
                '  integrity:integrityBlock = {',
                '    alg:string = "sha-256"',
                `    hash:string = "${hash}"`,
                '  }',
                '}',
                '',
            ].join('\n');
            const contents = `${body}${envelope}`;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'verify-sidecar.aeon');
            const receiptPath = path.join(tmpDir, 'verify-sidecar.receipt.json');
            fs.writeFileSync(file, contents, 'utf-8');
            fs.writeFileSync(receiptPath, JSON.stringify({
                source: {
                    mediaType: 'text/aeon',
                    encoding: 'utf-8',
                    digestAlgorithm: 'sha-256',
                    digest: 'abc123',
                },
                canonical: {
                    format: 'aeon.canonical',
                    spec: 'AEON Core',
                    specRelease: 'v1',
                    mode: 'transport',
                    profile: 'custom',
                    outputEncoding: 'utf-8',
                    digestAlgorithm: 'sha-256',
                    digest: hash,
                    length: 6,
                },
                producer: {
                    implementation: 'test-receipt',
                    version: '1.0.0',
                },
                generated: {
                    at: '2026-03-17T13:21:00Z',
                },
            }, null, 2), 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'integrity',
                'verify',
                file,
                '--json',
                '--receipt',
                receiptPath,
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.strictEqual(parsed.receipt.producer.implementation, 'test-receipt');
            assert.strictEqual(parsed.receipt.canonical.profile, 'custom');
        });

        it('reports usage error when --receipt value is missing', async () => {
            const { code, stdout, stderr } = await runCli([
                'integrity',
                'verify',
                fixture('envelope-valid.aeon'),
                '--receipt',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Missing value for --receipt'));
        });
    });

    describe('aeon integrity sign --replace', () => {
        it('replaces an existing envelope when requested', async () => {
            const body = 'a = 1\n';
            const existing = [
                'close:envelope = {',
                '  integrity:integrityBlock = {',
                '    alg:string = "sha-256"',
                '    hash:string = "deadbeef"',
                '  }',
                '}',
                '',
            ].join('\n');
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign-replace.aeon');
            fs.writeFileSync(file, `${body}${existing}`, 'utf-8');

            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--write',
                '--replace',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const written = fs.readFileSync(file, 'utf-8');
            assert.ok(written.includes('close:envelope'));
            assert.ok(written.includes('signatures:signatureSet'));
        });
    });

    describe('aeon integrity sign --include-bytes', () => {
        it('includes bytes_hash fields in output', async () => {
            const body = 'a = 1\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign-bytes.aeon');
            fs.writeFileSync(file, body, 'utf-8');

            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--include-bytes',
                '--json',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.strictEqual(parsed.envelope.integrity.bytes_hash_alg, 'sha-256');
            assert.ok(typeof parsed.envelope.integrity.bytes_hash === 'string');
        });
    });

    describe('aeon integrity sign --include-checksum', () => {
        it('includes checksum fields in output', async () => {
            const body = 'a = 1\n';
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'sign-checksum.aeon');
            fs.writeFileSync(file, body, 'utf-8');

            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');

            const { code, stdout, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--include-checksum',
                '--json',
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(stderr, '');
            const parsed = JSON.parse(stdout);
            assert.strictEqual(parsed.envelope.integrity.checksum_alg, 'sha-256');
            assert.ok(typeof parsed.envelope.integrity.checksum_value === 'string');
        });

        it('reports usage error when sign --receipt value is missing', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-integrity-'));
            const file = path.join(tmpDir, 'missing-receipt.aeon');
            fs.writeFileSync(file, 'a = 1\n', 'utf-8');
            const { privateKey } = generateEd25519KeyPair();
            const keyPath = path.join(tmpDir, 'aeon.key');
            fs.writeFileSync(keyPath, privateKey, 'utf-8');
            const { code, stdout, stderr } = await runCli([
                'integrity',
                'sign',
                file,
                '--private-key',
                keyPath,
                '--receipt',
            ]);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('Missing value for --receipt'));
        });
    });
});
