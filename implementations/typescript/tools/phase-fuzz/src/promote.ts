#!/usr/bin/env node

import { readFileSync } from 'node:fs';

type Lane = 'lexer' | 'parser' | 'incremental';
type IncrementalGroup = 'attributes' | 'nodes' | 'separators' | 'numbers' | 'interactions';
type IncrementalExpectation = 'valid' | 'invalid' | 'either';

interface IncrementalReportCase {
    readonly id: string;
    readonly group: IncrementalGroup;
    readonly accepted: boolean;
    readonly expectationMatch: boolean;
    readonly mutationTrail: readonly string[];
    readonly source?: string;
    readonly sourcePreview?: string;
}

interface IncrementalReportRun {
    readonly topCases: readonly IncrementalReportCase[];
}

interface IncrementalReportFile {
    readonly runs: readonly IncrementalReportRun[];
}

function main(): void {
    const args = process.argv.slice(2);
    const lane = getRequiredOption(args, '--lane') as Lane;
    const reportSource = lane === 'incremental' ? loadIncrementalReportCase(args) : null;
    const id = getOption(args, '--id', reportSource?.id ?? null);
    const sourceFile = getOption(args, '--source-file', null);
    const sourceInline = getOption(args, '--source', null);

    if (lane !== 'lexer' && lane !== 'parser' && lane !== 'incremental') {
        throw new Error(`Unsupported lane '${lane}'. Use 'lexer', 'parser', or 'incremental'.`);
    }

    if (id === null || id.length === 0) {
        throw new Error('Missing required option --id');
    }

    const source = sourceInline
        ?? (sourceFile ? readFileSync(sourceFile, 'utf8') : null)
        ?? reportSource?.source
        ?? reportSource?.sourcePreview
        ?? null;
    if (source === null) {
        throw new Error('Provide either --source-file <path>, --source <text>, or --report-file <path> with case selectors.');
    }

    const group = (getOption(args, '--group', reportSource?.group ?? null) as IncrementalGroup | null);
    const expected = getOption(args, '--expected', inferIncrementalExpectation(reportSource));
    const tags = getOption(args, '--tags', null);
    const note = lane === 'incremental' ? null : getRequiredOption(args, '--note');

    const entry = lane === 'incremental'
        ? renderIncrementalEntry(id, source, group, expected, tags)
        : renderRegressionEntry(id, source, note ?? '');

    console.log(`Target: ${lane === 'lexer' ? 'LEXER_REGRESSION_CASES' : lane === 'parser' ? 'PARSER_REGRESSION_CASES' : 'INCREMENTAL_REGRESSION_CASES'}`);
    console.log('');
    console.log(entry);
}

function renderRegressionEntry(id: string, source: string, note: string): string {
    return [
        '{',
        `    id: ${quote(id)},`,
        `    source: ${quote(source)},`,
        `    note: ${quote(note)},`,
        '}',
    ].join('\n');
}

function renderIncrementalEntry(id: string, source: string, group: IncrementalGroup | null, expected: string | null, tags: string | null): string {
    if (group === null) {
        throw new Error("Incremental promotion requires --group <attributes|nodes|separators|numbers|interactions>.");
    }
    const renderedTags = tags
        ? tags.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
        : ['regression'];
    return [
        '{',
        `    id: ${quote(id)},`,
        `    group: ${quote(group)},`,
        `    source: ${quote(source)},`,
        `    expected: ${quote(expected ?? 'either')},`,
        `    tags: ${JSON.stringify(renderedTags)},`,
        '}',
    ].join('\n');
}

function loadIncrementalReportCase(args: readonly string[]): IncrementalReportCase | null {
    const reportFile = getOption(args, '--report-file', null);
    if (reportFile === null) {
        return null;
    }

    const runIndex = parseIndex(getOption(args, '--run-index', '0'), '--run-index');
    const caseIndex = parseIndex(getOption(args, '--case-index', '0'), '--case-index');
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as IncrementalReportFile;
    const run = report.runs[runIndex];
    if (!run) {
        throw new Error(`No run at index ${runIndex} in report file ${reportFile}`);
    }
    const entry = run.topCases[caseIndex];
    if (!entry) {
        throw new Error(`No top case at index ${caseIndex} in run ${runIndex} of ${reportFile}`);
    }
    return entry;
}

function parseIndex(value: string | null, label: string): number {
    const parsed = Number(value ?? '0');
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return parsed;
}

function inferIncrementalExpectation(entry: IncrementalReportCase | null): IncrementalExpectation {
    if (entry === null) {
        return 'either';
    }
    if (!entry.expectationMatch) {
        return 'either';
    }
    return entry.accepted ? 'valid' : 'invalid';
}

function getOption(args: readonly string[], name: string, fallback: string | null): string | null {
    const index = args.indexOf(name);
    if (index === -1 || index + 1 >= args.length) {
        return fallback;
    }
    return args[index + 1] ?? fallback;
}

function getRequiredOption(args: readonly string[], name: string): string {
    const value = getOption(args, name, null);
    if (value === null || value.length === 0) {
        throw new Error(`Missing required option ${name}`);
    }
    return value;
}

function quote(value: string): string {
    return JSON.stringify(value);
}

main();
