#!/usr/bin/env node

import { readFileSync } from 'node:fs';

type Lane = 'lexer' | 'parser';

function main(): void {
    const args = process.argv.slice(2);
    const lane = getRequiredOption(args, '--lane') as Lane;
    const id = getRequiredOption(args, '--id');
    const note = getRequiredOption(args, '--note');
    const sourceFile = getOption(args, '--source-file', null);
    const sourceInline = getOption(args, '--source', null);

    if (lane !== 'lexer' && lane !== 'parser') {
        throw new Error(`Unsupported lane '${lane}'. Use 'lexer' or 'parser'.`);
    }

    const source = sourceInline ?? (sourceFile ? readFileSync(sourceFile, 'utf8') : null);
    if (source === null) {
        throw new Error('Provide either --source-file <path> or --source <text>.');
    }

    const entry = [
        '{',
        `    id: ${quote(id)},`,
        `    source: ${quote(source)},`,
        `    note: ${quote(note)},`,
        '}',
    ].join('\n');

    console.log(`Target: ${lane === 'lexer' ? 'LEXER_REGRESSION_CASES' : 'PARSER_REGRESSION_CASES'}`);
    console.log('');
    console.log(entry);
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
