#!/usr/bin/env node
/**
 * @aeos/cts-runner - CLI Entry Point
 *
 * AEOS Conformance Test Suite Runner
 *
 * Usage:
 *   aeos-cts-runner --sut ./path/to/validator --cts ./path/to/cts.json [--strict]
 */

import fs from 'node:fs';
import path from 'node:path';
import { CTSRunner } from './runner.js';

interface ParsedArgs {
    sut: string | undefined;
    cts: string | undefined;
    strict: boolean;
    help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = {
        sut: undefined,
        cts: undefined,
        strict: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--sut' && i + 1 < args.length) {
            result.sut = args[++i];
        } else if (arg === '--cts' && i + 1 < args.length) {
            result.cts = args[++i];
        } else if (arg === '--strict') {
            result.strict = true;
        } else if (arg === '--help' || arg === '-h') {
            result.help = true;
        }
    }

    return result;
}

function printUsage(): void {
    console.log(`
AEOS CTS Runner

Usage:
    aeos-cts-runner --sut <path> --cts <path> [--strict]
    aeos-cts-runner --sut <path> [--strict]

Options:
  --sut <path>   Path to validator executable (SUT)
  --cts <path>   Path to CTS JSON file
  --strict       Enable strict mode
  --help, -h     Show this help

Exit Codes:
  0  All tests passed
  1  Functional test failures
  2  Conformance violations
  3  Runner/config/SUT error
`);
}

function resolveCTSPath(candidate: string | undefined): string {
    const envRoot = process.env.AEONITE_CTS_ROOT;

    if (candidate) {
        const resolved = path.resolve(process.cwd(), candidate);
        if (fs.existsSync(resolved)) return candidate;

        const normalized = candidate.replaceAll('\\', '/');
        const marker = '/cts/';
        const idx = normalized.lastIndexOf(marker);
        if (idx !== -1 && envRoot) {
            const remainder = normalized.slice(idx + marker.length);
            const envPath = path.resolve(envRoot, remainder);
            if (fs.existsSync(envPath)) return envPath;
        }
        return candidate;
    }

    return envRoot
        ? path.resolve(envRoot, 'aeos/v1/aeos-validator-cts.v1.json')
        : '../../cts/aeos/v1/aeos-validator-cts.v1.json';
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

    if (!ctsPath) {
        console.error('Error: --cts <path> is required');
        printUsage();
        process.exit(3);
    }

    const runner = new CTSRunner({
        sutPath: args.sut,
        ctsPath,
        strict: args.strict,
    });

    const code = await runner.run();
    process.exit(code);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(3);
});
