import type { Document } from './ast.js';

/**
 * Compatibility shim for canonical path resolution.
 *
 * Path resolution is performed by `@aeon/aes` (`resolvePaths`) in the
 * production pipeline. This helper remains as a non-throwing passthrough to
 * avoid runtime footguns for legacy callers.
 */
export function resolveCanonicalPaths(doc: Document): Document {
    return doc;
}
