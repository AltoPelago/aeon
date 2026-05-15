#!/usr/bin/env node
/**
 * gen-oracle.mjs
 *
 * Captures a compile-oracle.v1.json corpus from the positive snippet files
 * using the TypeScript reference implementation as ground truth.
 *
 * Each snippet is compiled with @altopelago/aeon-core, and the resulting paths and
 * datatypes are recorded as the oracle baseline.  This corpus can be consumed
 * by any implementation's test runner to verify conformance against TS output.
 *
 * Usage (from repo root):
 *   node stress-tests/tools/gen-oracle.mjs
 *   node stress-tests/tools/gen-oracle.mjs --output stress-tests/oracle/canonical-positive-oracle.v1.json
 *   node stress-tests/tools/gen-oracle.mjs --dry-run
 *
 * Requires the TypeScript packages to be built first:
 *   npm --prefix implementations/typescript run build
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flagValue(flag) {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
}

const outputPath = flagValue('--output')
    ?? resolve(repoRoot, 'stress-tests/oracle/canonical-positive-oracle.v1.json');
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Load compiled @altopelago/aeon-core
// ---------------------------------------------------------------------------

const coreDistPath = resolve(
    repoRoot,
    'implementations/typescript/packages/core/dist/index.js',
);

if (!existsSync(coreDistPath)) {
    console.error(`Error: @altopelago/aeon-core not built. Run: npm --prefix implementations/typescript run build`);
    process.exit(1);
}

const { compile, formatPath } = await import(coreDistPath);

// ---------------------------------------------------------------------------
// Snippet parsing
// ---------------------------------------------------------------------------

/** @param {string} content @returns {string[]} */
function splitCases(content) {
    return content
        .split(/^---\s*$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Mode files
// ---------------------------------------------------------------------------

const modeFiles = [
    { mode: 'strict',    file: 'positive-strict.aeon-cases' },
    { mode: 'transport', file: 'positive-transport.aeon-cases' },
    { mode: 'custom',    file: 'positive-custom.aeon-cases' },
];

const cases = [];
let skipped = 0;
let compileErrors = 0;

for (const { mode, file } of modeFiles) {
    const filePath = resolve(repoRoot, 'stress-tests/snippets', file);

    if (!existsSync(filePath)) {
        console.warn(`Warning: snippet file not found, skipping: ${filePath}`);
        continue;
    }

    const content = readFileSync(filePath, 'utf8');
    const snippets = splitCases(content);

    for (let idx = 0; idx < snippets.length; idx++) {
        const source = snippets[idx];
        const caseNumber = idx + 1;
        const id = `canonical-${mode}-${String(caseNumber).padStart(4, '0')}`;

        /** @type {import('../../implementations/typescript/packages/core/dist/index.js').CompileOptions} */
        const compileOptions = {
            mode,
            indexedPaths: true,
            includeNewlines: false,
        };

        let result;
        try {
            result = compile(source, compileOptions);
        } catch (e) {
            console.warn(`Warning: exception compiling [${id}]: ${e?.message}`);
            skipped++;
            continue;
        }

        if (result.errors.length > 0) {
            const codes = result.errors.map((e) => e.code ?? String(e));
            console.warn(`Warning: [${id}] positive snippet produced errors: ${codes.join(', ')} — skipping`);
            compileErrors++;
            skipped++;
            continue;
        }

        const paths = result.events.map((e) => formatPath(e.path));
        const datatypes = /** @type {Record<string, string|null>} */ ({});
        for (const event of result.events) {
            datatypes[formatPath(event.path)] = event.datatype ?? null;
        }

        cases.push({
            id,
            kind: 'compile',
            source,
            mode,
            source_ref: file,
            options: {
                indexedPaths: true,
                includeNewlines: false,
            },
            expected: {
                ok: true,
                paths,
                datatypes,
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Assemble payload
// ---------------------------------------------------------------------------

const payload = {
    schema_version: 'compile-oracle.v1',
    source: {
        origin: 'stress-tests/snippets (positive-*.aeon-cases)',
        implementation: 'typescript',
        captured_by: 'stress-tests/tools/gen-oracle.mjs',
        snapshot: new Date().toISOString(),
    },
    cases,
};

const encoded = JSON.stringify(payload, null, 2) + '\n';
const total = cases.length;

console.log(`Captured ${total} cases (${skipped} skipped, ${compileErrors} had compile errors)`);

if (dryRun) {
    console.log(`[dry-run] Would write to: ${outputPath}`);
    process.exit(0);
}

const outDir = dirname(outputPath);
if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
}

writeFileSync(outputPath, encoded, 'utf8');
console.log(`Wrote to: ${outputPath}`);
