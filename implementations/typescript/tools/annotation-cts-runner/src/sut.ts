import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AnnotationRecord } from './types.js';

interface InvokeInspectOptions {
    readonly sortAnnotations: boolean;
}

interface InvokeInspectResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly annotations?: readonly AnnotationRecord[];
}

export async function invokeInspectAnnotations(
    sutPath: string,
    source: string,
    options: InvokeInspectOptions,
): Promise<InvokeInspectResult> {
    const tempDir = await mkdtemp(join(tmpdir(), 'aeon-annotations-cts-'));
    const tempFile = join(tempDir, 'input.aeon');

    try {
        await writeFile(tempFile, source, 'utf8');

        const isJavaScriptEntrypoint = sutPath.endsWith('.js') || sutPath.endsWith('.mjs') || sutPath.endsWith('.cjs');
        const command = isJavaScriptEntrypoint ? process.execPath : sutPath;
        const args = isJavaScriptEntrypoint
            ? [sutPath, 'inspect', tempFile, '--json', '--annotations-only']
            : ['inspect', tempFile, '--json', '--annotations-only'];

        if (options.sortAnnotations) {
            args.push('--sort-annotations');
        }

        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];

        child.stdout.on('data', (chunk) => stdoutChunks.push(new Uint8Array(chunk)));
        child.stderr.on('data', (chunk) => stderrChunks.push(new Uint8Array(chunk)));

        const code: number | null = await new Promise((resolve) => {
            child.on('close', resolve);
        });

        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        let annotations: readonly AnnotationRecord[] | undefined;
        try {
            const parsed = JSON.parse(stdout) as { annotations?: unknown };
            if (Array.isArray(parsed.annotations)) {
                annotations = parsed.annotations as AnnotationRecord[];
            }
        } catch {
            annotations = undefined;
        }

        return annotations
            ? { code, stdout, stderr, annotations }
            : { code, stdout, stderr };
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

export async function invokeInspectTargetsOnly(
    sutPath: string,
    source: string,
    options: InvokeInspectOptions,
): Promise<ReadonlyArray<{ kind: string; path?: string; reason?: string }>> {
    const result = await invokeInspectAnnotations(sutPath, source, options);
    const records = result.annotations ?? [];
    return records.map((record) => {
        if (record.target.kind === 'path') {
            return { kind: 'path', path: record.target.path };
        }
        if (record.target.kind === 'unbound') {
            return { kind: 'unbound', reason: record.target.reason };
        }
        return { kind: 'span' };
    });
}

export async function readStdInIfProvided(): Promise<string | null> {
    if (process.stdin.isTTY) {
        return null;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(new Uint8Array(chunk));
    }
    if (chunks.length === 0) {
        return null;
    }
    return Buffer.concat(chunks).toString('utf8');
}

export async function loadTextFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
}
