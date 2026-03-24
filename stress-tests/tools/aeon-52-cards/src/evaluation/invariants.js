/**
 * AEON 52-Cards Invariant Checks
 *
 * Each function validates a specific language invariant against
 * a generated AEON document. Returns { passed, invariant, details }.
 */

import { readAeon } from '@aeon/sdk-internal';
import { compile } from '@aeon/core';
import { canonicalize } from '@aeon/canonical';

// ── Helpers ──────────────────────────────────────────────────────────

function pathOf(event) {
    return event.path.segments
        .filter((s) => s.type === 'member' || s.type === 'index')
        .map((s) => (s.type === 'member' ? s.key : `[${s.index}]`))
        .join('.');
}

function valueSignature(value) {
    switch (value.type) {
        case 'StringLiteral':
            return `StringLiteral:${JSON.stringify(value.value)}`;
        case 'NumberLiteral':
            return `NumberLiteral:${value.raw ?? value.value}`;
        case 'BooleanLiteral':
            return `BooleanLiteral:${value.value}`;
        case 'SwitchLiteral':
            return `SwitchLiteral:${value.value}`;
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
            return `${value.type}:${value.raw ?? value.value}`;
        case 'CloneReference':
            return `CloneReference:${referencePathSignature(value.path)}`;
        case 'PointerReference':
            return `PointerReference:${referencePathSignature(value.path)}`;
        case 'ObjectNode':
            return `ObjectNode:${value.bindings.length}`;
        case 'ListNode':
            return `ListNode:${value.elements.length}`;
        case 'TupleLiteral':
            return `TupleLiteral:${value.elements.length}`;
        case 'NodeLiteral':
            return `NodeLiteral:${value.tag}:${value.children.length}`;
        default:
            return value.type;
    }
}

function referencePathSignature(path) {
    return path.map((segment) => {
        if (typeof segment === 'string') return `m:${segment}`;
        if (typeof segment === 'number') return `i:${segment}`;
        if (segment && typeof segment === 'object' && segment.type === 'attr') return `a:${segment.key}`;
        return '?';
    }).join('/');
}

function annotationSignature(annotations) {
    if (!annotations) return '';
    return Array.from(annotations.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${key}:${entry.datatype ?? ''}:${valueSignature(entry.value)}`)
        .join('|');
}

function eventSignature(event) {
    return [
        `path=${pathOf(event)}`,
        `key=${event.key}`,
        `datatype=${event.datatype ?? ''}`,
        `value=${valueSignature(event.value)}`,
        `annotations=${annotationSignature(event.annotations)}`,
    ].join(';');
}

function buildCompileOptions(options = {}) {
    const maxSepDepth = options.maxSepDepth ?? 8;
    const maxAttrDepth = options.maxAttrDepth ?? 1;
    const maxGenericDepth = options.maxGenericDepth ?? 1;
    const needsCustomDatatypes = options.needsCustomDatatypes ?? false;

    const compileOpts = {
        maxSeparatorDepth: maxSepDepth,
        maxAttributeDepth: maxAttrDepth,
        maxGenericDepth,
    };
    if (needsCustomDatatypes) {
        compileOpts.datatypePolicy = 'allow_custom';
    }

    return compileOpts;
}

/**
 * Build readAeon options appropriate for a document's characteristics.
 */
function buildReadOptions(options = {}) {
    const needsTransport = options.needsTransport ?? false;

    return {
        compile: buildCompileOptions(options),
        finalize: { mode: needsTransport ? 'loose' : 'strict' },
    };
}

// ── Invariant: Core Parse Stability ──────────────────────────────────

/**
 * Valid docs must compile without Core errors.
 * Invalid docs must produce deterministic Core error codes (no crashes).
 */
export function checkCoreParseStability(source, expectPass, options = {}) {
    const invariant = 'core-parse-stability';

    try {
        const result = compile(source, buildCompileOptions(options));
        const compileErrors = result.errors.length;
        const passed = compileErrors === 0;

        if (expectPass && !passed) {
            return {
                passed: false,
                invariant,
                details: {
                    reason: 'expected-pass-got-fail',
                    compileErrors,
                    firstError: result.errors[0]?.code ?? '',
                },
            };
        }

        if (!expectPass && passed) {
            return {
                passed: false,
                invariant,
                details: {
                    reason: 'expected-fail-got-pass',
                    events: result.events.length,
                },
            };
        }

        // For invalid cases, verify we got a proper error code (not a crash)
        if (!expectPass) {
            const hasCode = result.errors.some((e) => e.code);
            if (!hasCode) {
                return {
                    passed: false,
                    invariant,
                    details: { reason: 'no-error-code-produced' },
                };
            }
        }

        return { passed: true, invariant, details: { compileErrors } };
    } catch (error) {
        return {
            passed: false,
            invariant,
            details: { reason: 'crash', error: error.message },
        };
    }
}

// ── Invariant: SDK Finalize Stability ────────────────────────────────

/**
 * For Core-valid documents, SDK read/finalize should not introduce errors.
 * This is an implementation-layer check, not a Core v1 conformance check.
 */
export function checkSdkFinalizeStability(source, options = {}) {
    const invariant = 'sdk-finalize-stability';

    try {
        const readOpts = buildReadOptions(options);
        const result = readAeon(source, readOpts);

        if (result.compile.errors.length > 0) {
            return { passed: true, invariant, details: { skipped: true, reason: 'source-has-core-errors' } };
        }

        const finalizeErrors = result.finalized.meta?.errors?.length ?? 0;
        if (finalizeErrors > 0) {
            return {
                passed: false,
                invariant,
                details: {
                    reason: 'sdk-finalize-errors',
                    finalizeErrors,
                    firstError: result.finalized.meta?.errors?.[0]?.message ?? '',
                },
            };
        }

        return { passed: true, invariant, details: { finalizeErrors } };
    } catch (error) {
        return {
            passed: false,
            invariant,
            details: { reason: 'crash', error: error.message },
        };
    }
}

// ── Invariant: Canonical Idempotency ────────────────────────────────

/**
 * Canonicalization must be idempotent on documents it can successfully process.
 *
 * Canonicalization must respect the same parser budget metadata used by the
 * other invariants, so depth-tree cases can exercise nested attributes and
 * generics without being misclassified as canonicalizer failures.
 */
export function checkCanonicalIdempotency(source, options = {}) {
    const invariant = 'canonical-idempotency';

    try {
        const c1 = canonicalize(source, buildCompileOptions(options));
        if (c1.errors.length > 0) {
            return { passed: true, invariant, details: { skipped: true, reason: 'source-has-canon-errors' } };
        }

        // Canonicalize the already-canonical output — should be idempotent
        const c2 = canonicalize(c1.text, buildCompileOptions(options));
        if (c2.errors.length > 0) {
            if (!c1.text || c1.text.trim().length === 0) {
                return { passed: true, invariant, details: { skipped: true, reason: 'empty-canonical-output' } };
            }
            return {
                passed: false,
                invariant,
                details: { reason: 'canonical-output-fails-reparse', errors: c2.errors.map((e) => e.code) },
            };
        }

        if (c1.text !== c2.text) {
            return {
                passed: false,
                invariant,
                details: {
                    reason: 'canonical-not-idempotent',
                    firstLength: c1.text.length,
                    secondLength: c2.text.length,
                },
            };
        }

        return { passed: true, invariant, details: { canonicalLength: c1.text.length } };
    } catch (error) {
        return {
            passed: false,
            invariant,
            details: { reason: 'crash', error: error.message },
        };
    }
}

// ── Invariant: Annotation Isolation ──────────────────────────────────

/**
 * Stripping annotations must not change the Assignment Event Stream.
 * We compare events from source-with-annotations vs source-without.
 */
export function checkAnnotationIsolation(source, options = {}) {
    const invariant = 'annotation-isolation';

    try {
        const readOpts = buildReadOptions(options);

        // Parse with annotations
        const withAnn = readAeon(source, {
            compile: { ...readOpts.compile, emitAnnotations: true },
            finalize: readOpts.finalize,
        });

        if (withAnn.compile.errors.length > 0) {
            return { passed: true, invariant, details: { skipped: true, reason: 'source-has-errors' } };
        }

        // Parse without annotations
        const withoutAnn = readAeon(source, {
            compile: { ...readOpts.compile, emitAnnotations: false },
            finalize: readOpts.finalize,
        });

        if (withoutAnn.compile.errors.length > 0) {
            return {
                passed: false,
                invariant,
                details: { reason: 'annotation-toggle-changes-errors' },
            };
        }

        // Compare a stable projection of the event stream, not just paths.
        const eventsA = withAnn.compile.events.map(eventSignature).join('\n');
        const eventsB = withoutAnn.compile.events.map(eventSignature).join('\n');

        if (eventsA !== eventsB) {
            return {
                passed: false,
                invariant,
                details: {
                    reason: 'annotation-toggle-changes-event-stream',
                    withAnnotations: withAnn.compile.events.length,
                    withoutAnnotations: withoutAnn.compile.events.length,
                },
            };
        }

        return {
            passed: true,
            invariant,
            details: {
                events: withAnn.compile.events.length,
                annotations: withAnn.compile.annotations?.length ?? 0,
            },
        };
    } catch (error) {
        return {
            passed: false,
            invariant,
            details: { reason: 'crash', error: error.message },
        };
    }
}

// ── Invariant: Structural Integrity ──────────────────────────────────

/**
 * Events must have deterministic paths.
 * No duplicate canonical paths (unless in recovery mode).
 */
export function checkStructuralIntegrity(source, options = {}) {
    const invariant = 'structural-integrity';

    try {
        const result = compile(source, buildCompileOptions(options));

        if (result.errors.length > 0) {
            return { passed: true, invariant, details: { skipped: true, reason: 'compile-has-errors' } };
        }

        // Check all events have paths
        for (const event of result.events) {
            if (!event.path || !event.path.segments) {
                return {
                    passed: false,
                    invariant,
                    details: { reason: 'event-missing-path' },
                };
            }
        }

        // Check no duplicate canonical paths
        const pathStrings = result.events.map(pathOf);
        const seen = new Set();
        for (const p of pathStrings) {
            if (seen.has(p)) {
                return {
                    passed: false,
                    invariant,
                    details: { reason: 'duplicate-canonical-path', path: p },
                };
            }
            seen.add(p);
        }

        return { passed: true, invariant, details: { events: result.events.length } };
    } catch (error) {
        return {
            passed: false,
            invariant,
            details: { reason: 'crash', error: error.message },
        };
    }
}

// ── Invariant: Resource Limits ───────────────────────────────────────

/**
 * Documents exceeding configured depth limits must fail deterministically.
 * No stack overflow or crashes.
 */
export function checkResourceLimits(source, options = {}) {
    const invariant = 'resource-limits';

    try {
        const permissiveOptions = buildCompileOptions({
            ...options,
            maxSepDepth: Math.max(options.maxSepDepth ?? 1, 8),
            maxAttrDepth: Math.max(options.maxAttrDepth ?? 1, 8),
            maxGenericDepth: Math.max(options.maxGenericDepth ?? 1, 8),
        });

        // Test with restrictive limits
        const restrictive = compile(source, {
            maxSeparatorDepth: 1,
            maxAttributeDepth: 1,
            maxGenericDepth: 1,
        });

        // Test with permissive limits
        const permissive = compile(source, permissiveOptions);

        // If restrictive fails with depth errors, permissive should pass (or fail differently)
        const restrictiveCodes = restrictive.errors.map((e) => e.code);
        const hasDepthError =
            restrictiveCodes.includes('ATTRIBUTE_DEPTH_EXCEEDED') ||
            restrictiveCodes.includes('SEPARATOR_DEPTH_EXCEEDED') ||
            restrictiveCodes.includes('GENERIC_DEPTH_EXCEEDED');

        if (hasDepthError && permissive.errors.length === 0) {
            return { passed: true, invariant, details: { depthControlsWork: true } };
        }

        return {
            passed: true,
            invariant,
            details: {
                restrictiveErrors: restrictive.errors.length,
                permissiveErrors: permissive.errors.length,
            },
        };
    } catch (error) {
        return {
            passed: false,
            invariant,
            details: { reason: 'crash', error: error.message },
        };
    }
}
