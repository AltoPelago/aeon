#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { minimizeIncrementalCase } from './incremental-fuzz/minimizer.js';
import type { SyntaxGroup } from './incremental-fuzz/types.js';

function main(): void {
    const args = process.argv.slice(2);
    const group = getRequiredOption(args, '--group') as SyntaxGroup;
    const sourceFile = getOption(args, '--source-file', null);
    const sourceInline = getOption(args, '--source', null);

    if (!['attributes', 'nodes', 'separators', 'numbers', 'interactions'].includes(group)) {
        throw new Error("Unsupported group. Use one of: attributes, nodes, separators, numbers, interactions.");
    }

    const source = sourceInline ?? (sourceFile ? readFileSync(sourceFile, 'utf8') : null);
    if (source === null) {
        throw new Error('Provide either --source-file <path> or --source <text>.');
    }

    const result = minimizeIncrementalCase(source, {
        id: 'manual',
        group,
        source,
        expected: 'invalid',
        tags: ['manual'],
        hotspots: [],
    });

    console.log(JSON.stringify({
        group,
        changed: result.changed,
        passes: result.passes,
        source,
        minimized: result.source,
    }, null, 2));
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

main();

