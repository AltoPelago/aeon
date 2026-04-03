#!/usr/bin/env node

import { readFileSync } from 'node:fs';

type Lane = 'lexer' | 'parser' | 'incremental';
type IncrementalGroup = 'attributes' | 'nodes' | 'separators' | 'numbers' | 'interactions';

function main(): void {
    const args = process.argv.slice(2);
    const lane = getRequiredOption(args, '--lane') as Lane;
    const id = getRequiredOption(args, '--id');
    const sourceFile = getOption(args, '--source-file', null);
    const sourceInline = getOption(args, '--source', null);

    if (lane !== 'lexer' && lane !== 'parser' && lane !== 'incremental') {
        throw new Error(`Unsupported lane '${lane}'. Use 'lexer', 'parser', or 'incremental'.`);
    }

    const source = sourceInline ?? (sourceFile ? readFileSync(sourceFile, 'utf8') : null);
    if (source === null) {
        throw new Error('Provide either --source-file <path> or --source <text>.');
    }

    const group = getOption(args, '--group', null) as IncrementalGroup | null;
    const expected = getOption(args, '--expected', 'either');
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
