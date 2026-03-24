#!/usr/bin/env node
/**
 * @aeos/core - CTS Validator Adapter
 *
 * CTS-compatible CLI entry point for the AEOS validator.
 *
 * Protocol (CLI Protocol v1):
 * - Invoked as: aeos-validator --cts-validate
 * - Reads JSON from stdin: { aes, schema, options }
 * - Writes JSON to stdout: ResultEnvelope
 * - Logs may go to stderr
 *
 * This adapter is READ-ONLY and does not alter validator behavior.
 */

import { validate } from '../index.js';
import type { AES } from '../types/aes.js';
import type { SchemaV1 } from '../types/schema.js';
import type { ResultEnvelope } from '../types/envelope.js';

interface CTSInput {
    aes: AES;
    schema: SchemaV1;
    options?: {
        strict?: boolean;
        trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';
        [k: string]: unknown;
    };
}

/**
 * Read all stdin as a string
 */
async function readStdin(): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(new Uint8Array(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Main CTS adapter entry point
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Check for --cts-validate flag
    if (!args.includes('--cts-validate')) {
        console.error('Usage: aeos-validator --cts-validate');
        console.error('Reads JSON from stdin, writes ResultEnvelope to stdout.');
        process.exit(1);
    }

    try {
        // Read input from stdin
        const input = await readStdin();
        if (!input.trim()) {
            console.error('Error: Empty input');
            process.exit(1);
        }

        // Parse input
        let parsed: CTSInput;
        try {
            parsed = JSON.parse(input) as CTSInput;
        } catch {
            console.error('Error: Invalid JSON input');
            process.exit(1);
        }

        // Validate required fields
        if (!parsed.aes || !Array.isArray(parsed.aes)) {
            console.error('Error: Missing or invalid "aes" field');
            process.exit(1);
        }
        if (!parsed.schema || typeof parsed.schema !== 'object') {
            console.error('Error: Missing or invalid "schema" field');
            process.exit(1);
        }

        // Run validation (read-only, does not mutate inputs)
        const result: ResultEnvelope = validate(
            parsed.aes,
            parsed.schema,
            parsed.options ?? {}
        );

        // Output result envelope to stdout
        // MUST NOT include 'aes' in output (enforced by validate())
        console.log(JSON.stringify(result));

    } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
