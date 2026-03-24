/**
 * AEON 52-Cards Failure Minimizer
 *
 * When a failure is detected, attempts to reduce the document to a
 * minimal reproduction by stripping feature fragments one at a time.
 */

import { readAeon } from '@aeon/sdk-internal';
import { compile } from '@aeon/core';

/**
 * Attempt to minimize a failing document source.
 *
 * Strategy: the source is a header + body of bindings.
 * We split the body into individual lines/blocks and try removing
 * each one to find the minimal set that still triggers the failure.
 *
 * @param {string} source — the full AEON document source
 * @param {function(string): boolean} failsCheck — returns true if the source still triggers the failure
 * @returns {{ minimized: string, linesRemoved: number }}
 */
export function minimizeSource(source, failsCheck) {
    const lines = source.split('\n');

    // Find header end (closing brace of aeon:header block)
    let headerEnd = 0;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('{')) braceDepth++;
        if (lines[i].includes('}')) braceDepth--;
        if (braceDepth === 0 && i > 0) {
            headerEnd = i;
            break;
        }
    }

    const headerLines = lines.slice(0, headerEnd + 1);
    const bodyLines = lines.slice(headerEnd + 1).filter((l) => l.trim().length > 0);

    // Group body lines into logical blocks (bindings or multi-line structures)
    const blocks = groupIntoBlocks(bodyLines);

    // Delta debugging: try removing each block
    let currentBlocks = [...blocks];
    let totalRemoved = 0;

    for (let i = currentBlocks.length - 1; i >= 0; i--) {
        if (currentBlocks.length <= 1) break;

        const candidate = [...currentBlocks.slice(0, i), ...currentBlocks.slice(i + 1)];
        const candidateSource = [
            ...headerLines,
            ...candidate.flatMap((b) => b),
            '',
        ].join('\n');

        if (failsCheck(candidateSource)) {
            currentBlocks = candidate;
            totalRemoved++;
        }
    }

    const minimized = [
        ...headerLines,
        ...currentBlocks.flatMap((b) => b),
        '',
    ].join('\n');

    return { minimized, linesRemoved: totalRemoved };
}

/**
 * Group lines into logical blocks. A block is a sequence of lines
 * that belong together (e.g., a multi-line object or list).
 */
function groupIntoBlocks(lines) {
    const blocks = [];
    let current = [];
    let depth = 0;

    for (const line of lines) {
        current.push(line);

        // Track brace/bracket/paren depth
        for (const ch of line) {
            if (ch === '{' || ch === '[' || ch === '(') depth++;
            if (ch === '}' || ch === ']' || ch === ')') depth--;
        }

        if (depth <= 0) {
            blocks.push(current);
            current = [];
            depth = 0;
        }
    }

    if (current.length > 0) {
        blocks.push(current);
    }

    return blocks;
}

/**
 * Create a fail-check function for a specific invariant type.
 */
export function makeParseFailCheck(expectPass, options = {}) {
    const maxSepDepth = options.maxSepDepth ?? 8;
    const maxAttrDepth = options.maxAttrDepth ?? 1;
    const maxGenericDepth = options.maxGenericDepth ?? 1;

    return (source) => {
        try {
            const result = readAeon(source, {
                compile: {
                    maxSeparatorDepth: maxSepDepth,
                    maxAttributeDepth: maxAttrDepth,
                    maxGenericDepth,
                },
                finalize: { mode: 'strict' },
            });
            const compileErrors = result.compile.errors.length;
            const finalizeErrors = result.finalized.meta?.errors?.length ?? 0;
            const passed = compileErrors === 0 && finalizeErrors === 0;
            // The "failure" is: expectPass doesn't match actual result
            return passed !== expectPass;
        } catch {
            return true; // crash is always a failure
        }
    };
}
