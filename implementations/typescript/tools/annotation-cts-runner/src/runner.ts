import { readFile } from 'node:fs/promises';
import type { AnnotationCTSFile, AnnotationCTSTest, AnnotationRecord, RunnerOptions, Span } from './types.js';
import { invokeInspectAnnotations, invokeInspectTargetsOnly } from './sut.js';

type ExitClass = 0 | 1 | 3;

export class AnnotationCTSRunner {
    private pass = 0;
    private fail = 0;

    constructor(private readonly opts: RunnerOptions) { }

    async run(): Promise<number> {
        const cts = await this.loadCTS(this.opts.ctsPath);
        console.log(`Running Annotation CTS (meta=${String(cts.meta?.version ?? 'unknown')}) against SUT: ${this.opts.sutPath}`);

        for (const suite of cts.suites) {
            console.log(`\n--- Suite: ${suite.title} ---`);
            for (const test of suite.tests) {
                const exitClass = await this.runTest(test);
                if (exitClass === 0) this.pass += 1;
                else this.fail += 1;

                if (exitClass === 3) {
                    this.printSummary();
                    return 3;
                }
            }
        }

        this.printSummary();
        return this.fail > 0 ? 1 : 0;
    }

    private async loadCTS(path: string): Promise<AnnotationCTSFile> {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw) as AnnotationCTSFile;
    }

    private async runTest(test: AnnotationCTSTest): Promise<ExitClass> {
        const sortAnnotations = test.input.options?.sort_annotations ?? false;
        const strictSpans = test.assert?.strict_spans ?? this.opts.strictSpans;
        const stableOrder = test.assert?.stable_order ?? true;
        const noExtraAnnotations = test.assert?.no_extra_annotations ?? true;

        const firstRun = await invokeInspectAnnotations(this.opts.sutPath, test.input.source, { sortAnnotations });
        if (!firstRun.annotations) {
            console.error(`❌ ${test.id}: SUT did not return parseable annotations-only JSON.`);
            if (firstRun.stderr) console.error(firstRun.stderr);
            return 3;
        }

        const failures: string[] = [];
        const records = firstRun.annotations;

        failures.push(...this.validateRequiredFields(records));
        failures.push(...this.validateExpected(test, records, { noExtraAnnotations, strictSpans }));
        failures.push(...this.validateMonotonicSpanOrdering(records));

        if (stableOrder) {
            const secondRun = await invokeInspectAnnotations(this.opts.sutPath, test.input.source, { sortAnnotations });
            if (!secondRun.annotations) {
                console.error(`❌ ${test.id}: second pass failed to parse annotations.`);
                if (secondRun.stderr) console.error(secondRun.stderr);
                return 3;
            }
            if (JSON.stringify(records) !== JSON.stringify(secondRun.annotations)) {
                failures.push('Non-deterministic annotation output across repeated runs');
            }
        }

        if (test.assert?.targets_invariant_whitespace_variant && test.input.whitespace_variant) {
            const a = await invokeInspectTargetsOnly(this.opts.sutPath, test.input.source, { sortAnnotations });
            const b = await invokeInspectTargetsOnly(this.opts.sutPath, test.input.whitespace_variant, { sortAnnotations });
            if (JSON.stringify(a) !== JSON.stringify(b)) {
                failures.push('Annotation targets changed after whitespace-only variant');
            }
        }

        if (failures.length > 0) {
            console.error(`❌ ${test.id}: FAIL`);
            for (const failure of failures) {
                console.error(`  - ${failure}`);
            }
            return 1;
        }

        console.log(`✅ ${test.id}: PASS`);
        return 0;
    }

    private validateRequiredFields(records: readonly AnnotationRecord[]): string[] {
        const failures: string[] = [];
        records.forEach((record, index) => {
            const prefix = `record[${index}]`;
            if (!record.kind) failures.push(`${prefix} missing 'kind'`);
            if (!record.form) failures.push(`${prefix} missing 'form'`);
            if (typeof record.raw !== 'string') failures.push(`${prefix} missing/invalid 'raw'`);
            if (!record.target || typeof record.target !== 'object') {
                failures.push(`${prefix} missing 'target'`);
                return;
            }
            if (record.target.kind === 'path') {
                if (typeof record.target.path !== 'string') {
                    failures.push(`${prefix} target.kind=path must include string path`);
                }
            } else if (record.target.kind === 'unbound') {
                if (record.target.reason !== 'eof' && record.target.reason !== 'no_bindable') {
                    failures.push(`${prefix} target.kind=unbound must include valid reason`);
                }
            } else if (record.target.kind === 'span') {
                if (!this.isSpan(record.target.span)) {
                    failures.push(`${prefix} target.kind=span must include span object`);
                }
            } else {
                failures.push(`${prefix} unknown target.kind`);
            }
        });

        return failures;
    }

    private validateExpected(
        test: AnnotationCTSTest,
        records: readonly AnnotationRecord[],
        options: { noExtraAnnotations: boolean; strictSpans: boolean },
    ): string[] {
        const failures: string[] = [];
        const expected = test.expectedAnnotations;

        if (records.length < expected.length) {
            failures.push(`Missing annotations: expected ${expected.length}, got ${records.length}`);
            return failures;
        }
        if (options.noExtraAnnotations && records.length > expected.length) {
            failures.push(`Unexpected extra annotations: expected ${expected.length}, got ${records.length}`);
        }

        for (let i = 0; i < expected.length; i++) {
            const exp = expected[i];
            const got = records[i];
            if (!exp || !got) {
                failures.push(`Missing record at index ${i}`);
                continue;
            }

            if (got.kind !== exp.kind) failures.push(`Index ${i}: kind mismatch expected=${exp.kind} got=${got.kind}`);
            if (got.form !== exp.form) failures.push(`Index ${i}: form mismatch expected=${exp.form} got=${got.form}`);
            if (got.raw !== exp.raw) failures.push(`Index ${i}: raw mismatch expected=${JSON.stringify(exp.raw)} got=${JSON.stringify(got.raw)}`);
            if (got.target.kind !== exp.target.kind) {
                failures.push(`Index ${i}: target.kind mismatch expected=${exp.target.kind} got=${got.target.kind}`);
            } else if (exp.target.kind === 'path') {
                const gotPath = got.target.kind === 'path' ? got.target.path : undefined;
                if (exp.target.path !== gotPath) {
                    failures.push(`Index ${i}: target.path mismatch expected=${exp.target.path ?? 'undefined'} got=${gotPath ?? 'undefined'}`);
                }
            } else if (exp.target.kind === 'unbound') {
                const gotReason = got.target.kind === 'unbound' ? got.target.reason : undefined;
                if (exp.target.reason !== gotReason) {
                    failures.push(`Index ${i}: target.reason mismatch expected=${exp.target.reason ?? 'undefined'} got=${gotReason ?? 'undefined'}`);
                }
            }

            if (options.strictSpans && exp.span) {
                if (!this.sameSpan(got.span, exp.span)) {
                    failures.push(`Index ${i}: span mismatch under strict mode`);
                }
            }
        }

        return failures;
    }

    private validateMonotonicSpanOrdering(records: readonly AnnotationRecord[]): string[] {
        const failures: string[] = [];
        let previousStart = -1;
        let previousEnd = -1;

        records.forEach((record, index) => {
            if (!this.isSpan(record.span)) {
                failures.push(`record[${index}] missing/invalid span object`);
                return;
            }
            const currentStart = record.span.start.offset;
            const currentEnd = record.span.end.offset;

            if (currentStart < previousStart || (currentStart === previousStart && currentEnd < previousEnd)) {
                failures.push(`record[${index}] span ordering is not monotonic by source offset`);
            }
            previousStart = currentStart;
            previousEnd = currentEnd;
        });

        return failures;
    }

    private isSpan(value: unknown): value is Span {
        if (!value || typeof value !== 'object') return false;
        const start = (value as { start?: unknown }).start;
        const end = (value as { end?: unknown }).end;
        if (!start || typeof start !== 'object' || !end || typeof end !== 'object') return false;
        const so = (start as { offset?: unknown }).offset;
        const sl = (start as { line?: unknown }).line;
        const sc = (start as { column?: unknown }).column;
        const eo = (end as { offset?: unknown }).offset;
        const el = (end as { line?: unknown }).line;
        const ec = (end as { column?: unknown }).column;
        return [so, sl, sc, eo, el, ec].every((entry) => typeof entry === 'number');
    }

    private sameSpan(left: Span, right: Span): boolean {
        return left.start.offset === right.start.offset
            && left.start.line === right.start.line
            && left.start.column === right.start.column
            && left.end.offset === right.end.offset
            && left.end.line === right.end.line
            && left.end.column === right.end.column;
    }

    private printSummary(): void {
        console.log(`\nSummary: pass=${this.pass} fail=${this.fail}`);
    }
}
