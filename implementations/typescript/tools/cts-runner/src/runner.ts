/**
 * @aeos/cts-runner - Runner
 *
 * CTS test execution and verification.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CTSFile, CTSTest, ResultEnvelope, RunnerOptions, Span } from './types.js';
import { deepCopy, deepEquals, isObject, normalizePath } from './util.js';
import { invokeSUT } from './sut.js';

type Verdict = 'pass' | 'fail' | 'skip';

export class CTSRunner {
    private pass = 0;
    private fail = 0;
    private skip = 0;

    constructor(private opts: RunnerOptions) { }

    async run(): Promise<number> {
        const cts = await this.loadCTS(this.opts.ctsPath);
        console.log(
            `Running CTS core-v1 (meta=${String(cts.meta?.version ?? 'unknown')}) against SUT: ${this.opts.sutPath}`
        );

        for (const suite of cts.suites) {
            const tests = Array.isArray(suite.tests) ? suite.tests : [];
            console.log(`\n--- Suite: ${suite.title} ---`);
            for (const test of tests) {
                const { verdict, exitClass } = await this.runTest(test, cts);
                if (verdict === 'pass') this.pass++;
                else if (verdict === 'fail') this.fail++;
                else this.skip++;

                if (exitClass === 2) {
                    // Conformance violation: stop immediately
                    this.printSummary();
                    return 2;
                }
                if (exitClass === 3) {
                    this.printSummary();
                    return 3;
                }
            }
        }

        this.printSummary();
        return this.fail > 0 ? 1 : 0;
    }

    private async loadCTS(path: string): Promise<CTSFile> {
        const fullPath = resolve(path);
        const raw = await readFile(fullPath, 'utf8');
        const parsed = JSON.parse(raw) as CTSFile;
        const baseDir = dirname(fullPath);

        const suites = await Promise.all((parsed.suites ?? []).map(async (suite) => {
            if (Array.isArray(suite.tests)) return suite;
            if (!suite.file) return { ...suite, tests: [] };
            const suitePath = resolve(baseDir, suite.file);
            const suiteRaw = await readFile(suitePath, 'utf8');
            const suiteFromFile = JSON.parse(suiteRaw) as { title?: string; tests?: CTSTest[] };
            return {
                ...suite,
                title: suite.title ?? suiteFromFile.title ?? suite.id,
                tests: Array.isArray(suiteFromFile.tests) ? suiteFromFile.tests : [],
            };
        }));

        return { ...parsed, suites };
    }

    private async runTest(test: CTSTest, _cts: CTSFile): Promise<{ verdict: Verdict; exitClass: 0 | 1 | 2 | 3 }> {
        const strict = this.opts.strict;

        const aesForSUT = deepCopy(test.input.aes);
        const schemaForSUT = deepCopy(test.input.schema);

        const aesSnapshot = deepCopy(aesForSUT);
        const schemaSnapshot = deepCopy(schemaForSUT);

        const mode = test.input.options?.mode ?? 'v1';
        if (mode !== 'v1') {
            console.error(`❌ ${test.id}: invalid mode '${String(mode)}' (expected v1).`);
            return { verdict: 'fail', exitClass: 3 };
        }
        const inv = await invokeSUT(this.opts.sutPath, aesForSUT, schemaForSUT, {
            ...(test.input.options ?? {}),
            strict,
            mode,
        });

        if (!inv.parsed) {
            console.error(`❌ ${test.id}: SUT did not return valid JSON envelope.`);
            if (inv.stderr) console.error(inv.stderr);
            return { verdict: 'fail', exitClass: 3 };
        }

        const actual = inv.parsed;

        // Phase 1: Envelope check
        const envelopeErr = this.checkEnvelope(actual);
        if (envelopeErr) {
            console.error(`❌ ${test.id}: Conformance violation: ${envelopeErr}`);
            return { verdict: 'fail', exitClass: 2 };
        }

        // Basic ok check
        const failures: string[] = [];
        if (actual.ok !== test.expected.ok) {
            failures.push(`Status mismatch: expected ok=${test.expected.ok}, got ok=${actual.ok}`);
        }

        // Expected errors subset check
        const errorDiff = this.compareErrors(test.expected.errors, actual.errors);
        failures.push(...errorDiff);
        const warningDiff = this.compareWarnings(test.expected.warnings, actual.warnings);
        failures.push(...warningDiff);

        // Optional: extra errors strictness
        if (strict && test.assert?.no_extra_errors) {
            if (actual.errors.length > test.expected.errors.length) {
                failures.push(`Unexpected extra errors: got ${actual.errors.length}, expected ${test.expected.errors.length}`);
            }
        }

        // Phase 2: Assertions
        if (test.assert?.no_mutation) {
            if (!deepEquals(aesForSUT, aesSnapshot)) failures.push('Violation: Input AES mutated in place');
            if (!deepEquals(schemaForSUT, schemaSnapshot)) failures.push('Violation: Input schema mutated in place');
            if ('aes' in actual) {
                failures.push('Violation: SUT emitted AES in output (forbidden)');
                console.error(`❌ ${test.id}: Conformance violation: AES in output.`);
                return { verdict: 'fail', exitClass: 2 };
            }
        }

        // Guarantees optional check
        const guaranteesAssert = test.assert?.guarantees_may_include ?? {};
        const noUnlisted = strict && !!test.assert?.no_unlisted_guarantee_paths;

        if (isObject(actual.guarantees)) {
            for (const [path, tags] of Object.entries(actual.guarantees as Record<string, unknown>)) {
                if (!Array.isArray(tags)) {
                    failures.push(`Guarantees for path ${path} must be an array`);
                    continue;
                }
                if (!(path in guaranteesAssert)) {
                    if (noUnlisted) failures.push(`Unexpected guarantee path: ${path}`);
                    continue;
                }
                const allowed = guaranteesAssert[path] ?? [];
                for (const t of tags) {
                    if (typeof t !== 'string') {
                        failures.push(`Guarantee tag must be string at ${path}`);
                    } else if (!allowed.includes(t)) {
                        failures.push(`Guarantee '${t}' on '${path}' is not in allowed list`);
                    }
                }
            }
        } else {
            failures.push('Envelope violation: guarantees must be an object');
            return { verdict: 'fail', exitClass: 2 };
        }

        if (failures.length > 0) {
            console.error(`❌ ${test.id}: FAIL`);
            for (const f of failures) console.error(`  - ${f}`);
            return { verdict: 'fail', exitClass: 1 };
        }

        console.log(`✅ ${test.id}: PASS`);
        return { verdict: 'pass', exitClass: 0 };
    }

    private checkEnvelope(actual: ResultEnvelope): string | null {
        const requiredKeys = ['ok', 'errors', 'warnings', 'guarantees'];
        for (const k of requiredKeys) {
            if (!(k in actual)) return `Output missing required envelope key '${k}'`;
        }
        if (typeof actual.ok !== 'boolean') return `'ok' must be boolean`;
        if (!Array.isArray(actual.errors)) return `'errors' must be array`;
        if (!Array.isArray(actual.warnings)) return `'warnings' must be array`;
        if (!isObject(actual.guarantees)) return `'guarantees' must be object`;
        if ('aes' in actual) return `Output MUST NOT contain 'aes'`;
        return null;
    }

    private compareErrors(
        expected: Array<{ path: string; code: string; phase: string; span: Span }>,
        actual: Array<{ path: string; code: string; phase: string; span: Span }>
    ): string[] {
        return this.compareDiagnostics('error', expected, actual);
    }

    private compareWarnings(
        expected: Array<{ path: string; code: string; phase: string; span: Span }>,
        actual: Array<{ path: string; code: string; phase: string; span: Span }>
    ): string[] {
        return this.compareDiagnostics('warning', expected, actual);
    }

    private compareDiagnostics(
        kind: 'error' | 'warning',
        expected: Array<{ path: string; code: string; phase: string; span: Span }>,
        actual: Array<{ path: string; code: string; phase: string; span: Span }>
    ): string[] {
        const failures: string[] = [];
        const used = new Set<number>();

        for (const exp of expected) {
            const idx = actual.findIndex((a, i) => {
                if (used.has(i)) return false;
                return normalizePath(a.path) === normalizePath(exp.path)
                    && a.code === exp.code
                    && a.phase === exp.phase;
            });

            if (idx === -1) {
                failures.push(`Missing expected ${kind}: ${exp.code} at ${exp.path}`);
                continue;
            }

            used.add(idx);
            const match = actual[idx];

            if (match && exp.span !== null) {
                if (match.span === null) {
                    failures.push(`Span mismatch for ${kind} ${exp.code} at ${exp.path}: expected ${JSON.stringify(exp.span)}, got null`);
                } else if (match.span[0] !== exp.span[0] || match.span[1] !== exp.span[1]) {
                    failures.push(`Span mismatch for ${kind} ${exp.code} at ${exp.path}: expected ${JSON.stringify(exp.span)}, got ${JSON.stringify(match.span)}`);
                }
            }
        }

        return failures;
    }

    private printSummary(): void {
        console.log(`\nSummary: pass=${this.pass} fail=${this.fail} skip=${this.skip}`);
    }
}
