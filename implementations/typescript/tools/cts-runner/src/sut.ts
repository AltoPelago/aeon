/**
 * @aeos/cts-runner - SUT Invoker
 *
 * Invokes the System Under Test via CLI protocol.
 */

import { spawn } from 'node:child_process';
import type { AESEvent, ResultEnvelope, SchemaV1 } from './types.js';

export interface SUTInvokeOptions {
    strict: boolean;
    mode?: 'v1';
    [k: string]: unknown;
}

export interface SUTResult {
    code: number | null;
    stdout: string;
    stderr: string;
    parsed: ResultEnvelope | undefined;
}

/**
 * Invoke SUT with CTS protocol
 *
 * @param sutPath - Path to SUT executable
 * @param aes - AES events to validate
 * @param schema - Schema to validate against
 * @param options - Options to pass to SUT
 */
export async function invokeSUT(
    sutPath: string,
    aes: AESEvent[],
    schema: SchemaV1,
    options: SUTInvokeOptions
): Promise<SUTResult> {
    const isJavaScriptEntrypoint = sutPath.endsWith('.js') || sutPath.endsWith('.mjs') || sutPath.endsWith('.cjs');
    const command = isJavaScriptEntrypoint ? process.execPath : sutPath;
    const args = isJavaScriptEntrypoint ? [sutPath, '--cts-validate'] : ['--cts-validate'];

    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const payload = JSON.stringify({ aes, schema, options });
    child.stdin.write(payload);
    child.stdin.end();

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    child.stdout.on('data', (d) => stdoutChunks.push(new Uint8Array(d)));
    child.stderr.on('data', (d) => stderrChunks.push(new Uint8Array(d)));

    const code: number | null = await new Promise((resolve) => {
        child.on('close', resolve);
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    let parsed: ResultEnvelope | undefined;
    try {
        parsed = stdout ? (JSON.parse(stdout) as ResultEnvelope) : undefined;
    } catch {
        // leave undefined; runner will treat as error
    }

    return { code, stdout, stderr, parsed };
}
