import type { Span } from '@aeon/lexer';
import type { Document, Binding, Value, ObjectNode, ListNode } from '@aeon/parser';

/**
 * Canonical path to a binding
 */
export interface CanonicalPath {
    readonly segments: readonly PathSegment[];
}

/**
 * Path segment
 */
export type PathSegment =
    | { readonly type: 'root' }
    | { readonly type: 'member'; readonly key: string }
    | { readonly type: 'index'; readonly index: number };

/**
 * Create a root path ($)
 */
export function createRootPath(): CanonicalPath {
    return { segments: [{ type: 'root' }] };
}

/**
 * Extend a path with a member key
 */
export function extendPath(parent: CanonicalPath, key: string): CanonicalPath {
    return {
        segments: [...parent.segments, { type: 'member', key }],
    };
}

/**
 * Extend a path with an index segment
 */
export function extendPathIndex(parent: CanonicalPath, index: number): CanonicalPath {
    return {
        segments: [...parent.segments, { type: 'index', index }],
    };
}

/**
 * Format a canonical path as a string (e.g., "$.foo.bar")
 */
export function formatPath(path: CanonicalPath): string {
    let result = '';
    for (const segment of path.segments) {
        switch (segment.type) {
            case 'root':
                result = '$';
                break;
            case 'member':
                // Check if key needs escaping
                if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)) {
                    result += `.${segment.key}`;
                } else {
                    result += `.[${JSON.stringify(segment.key)}]`;
                }
                break;
            case 'index':
                result += `[${segment.index}]`;
                break;
        }
    }
    return result;
}

/**
 * Format a canonical path as a normalized wildcard path
 * (e.g., "$.contacts[3].email" -> "contacts[*].email").
 */
export function formatNormalizedPath(path: CanonicalPath): string {
    let result = '';
    for (const segment of path.segments) {
        switch (segment.type) {
            case 'root':
                // Normalized paths omit root marker.
                break;
            case 'member':
                if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)) {
                    result += result === '' ? segment.key : `.${segment.key}`;
                } else {
                    const quoted = `[${JSON.stringify(segment.key)}]`;
                    result += result === '' ? quoted : `.${quoted}`;
                }
                break;
            case 'index':
                result += '[*]';
                break;
        }
    }
    return result;
}

/**
 * A binding with its resolved canonical path
 */
export interface CanonicalBinding {
    readonly path: CanonicalPath;
    readonly binding: Binding;
    readonly span: Span;
}

/**
 * Path resolution error - base class
 */
export class PathResolutionError extends Error {
    readonly span: Span;
    readonly code: string;

    constructor(message: string, span: Span, code: string = 'PATH_ERROR') {
        super(message);
        this.name = 'PathResolutionError';
        this.span = span;
        this.code = code;
    }
}

/**
 * Duplicate canonical path error
 */
export class DuplicateCanonicalPathError extends PathResolutionError {
    readonly path: string;
    readonly firstOccurrence: Span;

    constructor(path: string, span: Span, firstOccurrence: Span) {
        super(`Duplicate canonical path: '${path}'`, span, 'DUPLICATE_CANONICAL_PATH');
        this.name = 'DuplicateCanonicalPathError';
        this.path = path;
        this.firstOccurrence = firstOccurrence;
    }
}

/**
 * Path resolution result
 */
export interface PathResolutionResult {
    readonly bindings: readonly CanonicalBinding[];
    readonly errors: readonly PathResolutionError[];
}

export interface PathResolutionOptions {
    /** Enable indexed addressing for list/tuple elements. */
    readonly indexedPaths?: boolean;
}

/**
 * Resolve canonical paths for all bindings in a document
 */
export function resolvePaths(document: Document, options: PathResolutionOptions = {}): PathResolutionResult {
    const resolver = new PathResolver(options);
    return resolver.resolve(document);
}

/**
 * Path resolver - walks AST and assigns canonical paths to bindings
 */
class PathResolver {
    private readonly bindings: CanonicalBinding[] = [];
    private readonly errors: PathResolutionError[] = [];
    private readonly pathRegistry: Map<string, Span> = new Map();

    constructor(private readonly options: PathResolutionOptions = {}) { }

    resolve(document: Document): PathResolutionResult {
        // Resolve all top-level bindings under root path
        const rootPath = createRootPath();

        // Resolve header fields first (source order: header precedes body)
        if (document.header) {
            for (const binding of document.header.bindings) {
                const syntheticBinding: Binding = {
                    ...binding,
                    key: `aeon:${binding.key}`,
                };
                this.resolveBinding(syntheticBinding, rootPath);
            }
        }

        for (const binding of document.bindings) {
            this.resolveBinding(binding, rootPath);
        }

        return {
            bindings: this.bindings,
            errors: this.errors,
        };
    }

    private resolveBinding(binding: Binding, parentPath: CanonicalPath): void {
        // Create path for this binding
        const path = extendPath(parentPath, binding.key);
        const pathString = formatPath(path);

        // Check for duplicate path
        const existingSpan = this.pathRegistry.get(pathString);
        if (existingSpan) {
            this.errors.push(new DuplicateCanonicalPathError(
                pathString,
                binding.span,
                existingSpan
            ));
            // Do not register or traverse duplicate bindings; first occurrence wins.
            return;
        }

        this.pathRegistry.set(pathString, binding.span);

        // Register this binding
        this.bindings.push({
            path,
            binding,
            span: binding.span,
        });

        // Recursively resolve bindings in value (if object or list containing objects)
        this.resolveValue(binding.value, path);
    }

    private resolveValue(value: Value, parentPath: CanonicalPath): void {
        switch (value.type) {
            case 'ObjectNode':
                this.resolveObject(value, parentPath);
                break;

            case 'ListNode':
                this.resolveList(value, parentPath);
                break;

            case 'TupleLiteral':
                this.resolveTuple(value, parentPath);
                break;

            // All other value types do NOT produce paths
            // (literals, references, etc.)
            default:
                // No paths for non-container values
                break;
        }
    }

    private resolveObject(obj: ObjectNode, parentPath: CanonicalPath): void {
        // Object bindings extend the parent path
        for (const binding of obj.bindings) {
            this.resolveBinding(binding, parentPath);
        }
    }

    private resolveList(list: ListNode, parentPath: CanonicalPath): void {
        // Core v1: list elements introduce indexed canonical paths.
        if (this.options.indexedPaths) {
            for (let index = 0; index < list.elements.length; index++) {
                const element = list.elements[index]!;
                const indexedPath = extendPathIndex(parentPath, index);
                this.registerSyntheticValueBinding(String(index), element, indexedPath);
                this.resolveValue(element, indexedPath);
            }
            return;
        }

        // Compatibility mode behavior: objects in lists extend parent path without indexes.
        for (const element of list.elements) {
            if (element.type === 'ObjectNode') {
                this.resolveObject(element, parentPath);
            } else if (element.type === 'ListNode') {
                this.resolveList(element, parentPath);
            } else if (element.type === 'TupleLiteral') {
                this.resolveTuple(element, parentPath);
            }
        }
    }

    private resolveTuple(tuple: Extract<Value, { type: 'TupleLiteral' }>, parentPath: CanonicalPath): void {
        if (!this.options.indexedPaths) {
            // Compatibility gate: tuples should not be emitted into AES path space.
            return;
        }

        for (let index = 0; index < tuple.elements.length; index++) {
            const element = tuple.elements[index]!;
            const indexedPath = extendPathIndex(parentPath, index);
            this.registerSyntheticValueBinding(String(index), element, indexedPath);
            this.resolveValue(element, indexedPath);
        }
    }

    private registerSyntheticValueBinding(key: string, value: Value, path: CanonicalPath): void {
        const pathString = formatPath(path);
        const existingSpan = this.pathRegistry.get(pathString);
        if (existingSpan) {
            this.errors.push(new DuplicateCanonicalPathError(pathString, value.span, existingSpan));
            return;
        }

        this.pathRegistry.set(pathString, value.span);
        const syntheticBinding: Binding = {
            type: 'Binding',
            key,
            value,
            datatype: null,
            attributes: [],
            span: value.span,
        };
        this.bindings.push({
            path,
            binding: syntheticBinding,
            span: value.span,
        });
    }
}
