#!/usr/bin/env node

import { lintManifest } from './lint.js';

type ParsedArgs = {
    command: 'lint' | 'help';
    target: string | undefined;
    json: boolean;
};

function parseArgs(args: string[]): ParsedArgs {
    const command = args[0];
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        return { command: 'help', target: undefined, json: false };
    }
    return {
        command: command === 'lint' ? 'lint' : 'help',
        target: args.find((arg, index) => index > 0 && !arg.startsWith('--')),
        json: args.includes('--json'),
    };
}

function printHelp(): void {
    console.log(`
AEON CTS Author Utilities

Usage:
  aeon-cts-author lint <manifest.json> [--json]

Commands:
  lint     Validate CTS manifest and referenced suite fixtures
  help     Show this help
`.trim());
}

function formatIssue(issue: { level: string; file: string; message: string }): string {
    return `${issue.level.toUpperCase()} file=${issue.file} message=${issue.message}`;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'help') {
        printHelp();
        process.exit(0);
    }
    if (!args.target) {
        console.error('Error: Missing CTS manifest path');
        printHelp();
        process.exit(2);
    }

    const result = lintManifest(args.target);
    if (args.json) {
        console.log(JSON.stringify(result, null, 2));
    } else if (result.issues.length === 0) {
        console.log('OK');
    } else {
        for (const issue of result.issues) {
            console.log(formatIssue(issue));
        }
    }

    process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(3);
});
