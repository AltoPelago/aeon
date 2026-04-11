#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { AnnotationCTSRunner } from './runner.js';

interface ParsedArgs {
    sut: string | undefined;
    cts: string | undefined;
    strictSpans: boolean;
    help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = {
        sut: undefined,
        cts: undefined,
        strictSpans: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--sut' && i + 1 < args.length) {
            result.sut = args[++i]!;
        } else if (arg === '--cts' && i + 1 < args.length) {
            result.cts = args[++i]!;
        } else if (arg === '--strict-spans') {
            result.strictSpans = true;
        } else if (arg === '--help' || arg === '-h') {
            result.help = true;
        }
    }

    return result;
}

function printUsage(): void {
    console.log(`
AEON Annotation CTS Runner

Usage:
  aeon-annotation-cts-runner --sut <path> [--cts <path>] [--strict-spans]

Options:
  --sut <path>      Path to aeon CLI executable (SUT)
  --cts <path>      Path to annotation CTS JSON file
  --strict-spans    Require exact span equality for tests that provide expected spans
  --help, -h        Show help

Exit Codes:
  0  All tests passed
  1  Functional test failures
  3  Runner/config/SUT error
`);
}

function resolveCTSPath(candidate: string | undefined): string {
    const envRoot = process.env.AEONITE_CTS_ROOT;

    if (candidate) {
        const resolved = path.resolve(process.cwd(), candidate);
        if (fs.existsSync(resolved)) return candidate;

        const parts = candidate.replaceAll('\\', '/').split('/');
        const ctsIndex = parts.lastIndexOf('cts');
        if (ctsIndex !== -1 && envRoot) {
            const remainder = parts.slice(ctsIndex + 1).join('/');
            const envPath = path.resolve(envRoot, remainder);
            if (fs.existsSync(envPath)) return envPath;
        }
        return candidate;
    }

    return envRoot
        ? path.resolve(envRoot, 'annotations/v1/annotation-stream-cts.v1.json')
        : '../../cts/annotations/v1/annotation-stream-cts.v1.json';
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        printUsage();
        process.exit(0);
    }

    if (!args.sut) {
        console.error('Error: --sut <path> is required');
        printUsage();
        process.exit(3);
    }

    const ctsPath = resolveCTSPath(args.cts);

    const runner = new AnnotationCTSRunner({
        sutPath: args.sut,
        ctsPath,
        strictSpans: args.strictSpans,
    });

    const code = await runner.run();
    process.exit(code);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(3);
});
