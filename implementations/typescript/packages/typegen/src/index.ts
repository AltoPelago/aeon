import type { ConstraintsV1, SchemaV1 } from '@aeos/core';

export interface TypegenOptions {
    readonly rootName?: string;
    readonly datatypeMap?: Readonly<Record<string, string>>;
    readonly emitRuntimeBinder?: boolean;
    readonly schemaConstName?: string;
    readonly binderName?: string;
    readonly runtimeModule?: string;
    readonly schemaModule?: string;
}

export interface TypegenDiagnostic {
    readonly level: 'error' | 'warning';
    readonly code: string;
    readonly message: string;
    readonly path?: string;
}

export interface TypegenResult {
    readonly code: string;
    readonly diagnostics: readonly TypegenDiagnostic[];
}

interface TreeNode {
    constraints?: ConstraintsV1;
    readonly children: Map<string, TreeNode>;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function createNode(): TreeNode {
    return { children: new Map<string, TreeNode>() };
}

function pathSegmentToCanonical(segment: string): string {
    if (IDENTIFIER_RE.test(segment)) return `.${segment}`;
    return `["${segment.replace(/"/g, '\\"')}"]`;
}

function formatPropertyName(segment: string): string {
    return IDENTIFIER_RE.test(segment) ? segment : JSON.stringify(segment);
}

function nodeIsRequired(node: TreeNode): boolean {
    if (node.constraints?.required === true) return true;
    for (const child of node.children.values()) {
        if (nodeIsRequired(child)) return true;
    }
    return false;
}

function parseCanonicalPath(path: string): { ok: true; segments: string[] } | { ok: false; reason: string } {
    if (!path.startsWith('$')) {
        return { ok: false, reason: 'Path must start with $' };
    }

    const segments: string[] = [];
    let i = 1;

    while (i < path.length) {
        if (path[i] === '.') {
            i += 1;
        }

        if (i >= path.length) {
            return { ok: false, reason: 'Unexpected end of path' };
        }

        if (path[i] === '[') {
            if (path.startsWith('["', i)) {
                const parsed = readQuotedSegment(path, i + 2);
                if (!parsed.ok) return parsed;
                segments.push(parsed.value);
                i = parsed.nextIndex;
                continue;
            }

            if (path.startsWith('[$"', i)) {
                const parsed = readQuotedSegment(path, i + 3);
                if (!parsed.ok) return parsed;
                segments.push(parsed.value);
                i = parsed.nextIndex;
                continue;
            }

            return { ok: false, reason: 'Unsupported bracket segment syntax' };
        }

        const start = i;
        while (i < path.length && path[i] !== '.' && path[i] !== '[') {
            i += 1;
        }
        const segment = path.slice(start, i);
        if (!segment) {
            return { ok: false, reason: 'Empty path segment' };
        }
        segments.push(segment);
    }

    return { ok: true, segments };
}

function readQuotedSegment(
    source: string,
    start: number
): { ok: true; value: string; nextIndex: number } | { ok: false; reason: string } {
    let i = start;
    let raw = '';

    while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') {
            if (i + 1 >= source.length) {
                return { ok: false, reason: 'Invalid escape sequence in bracket segment' };
            }
            raw += source[i + 1];
            i += 2;
            continue;
        }

        if (ch === '"') {
            if (source.startsWith('"]', i)) {
                return { ok: true, value: raw, nextIndex: i + 2 };
            }
            return { ok: false, reason: 'Quoted segment must terminate with "]' };
        }

        raw += ch;
        i += 1;
    }

    return { ok: false, reason: 'Unterminated quoted segment' };
}

function resolveScalarType(
    path: string,
    constraints: ConstraintsV1 | undefined,
    diagnostics: TypegenDiagnostic[],
    options: TypegenOptions
): string {
    if (constraints?.datatype && options.datatypeMap && options.datatypeMap[constraints.datatype]) {
        return options.datatypeMap[constraints.datatype] as string;
    }

    const type = constraints?.type;
    if (!type) return 'unknown';

    switch (type) {
        case 'StringLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'CloneReference':
        case 'PointerReference':
            return 'string';
        case 'NumberLiteral':
        case 'IntegerLiteral':
        case 'FloatLiteral':
            return 'number';
        case 'InfinityLiteral':
            return "'Infinity' | '-Infinity'";
        case 'BooleanLiteral':
            return 'boolean';
        case 'NullLiteral':
            return 'null';
        case 'ListNode':
            return 'unknown[]';
        case 'ObjectNode':
            return 'Record<string, unknown>';
        default:
            diagnostics.push({
                level: 'warning',
                code: 'UNKNOWN_CONSTRAINT_TYPE',
                message: `Unknown AEOS type '${type}' at '${path}', using unknown`,
                path,
            });
            return 'unknown';
    }
}

function renderNodeType(
    path: string,
    node: TreeNode,
    indent: string,
    diagnostics: TypegenDiagnostic[],
    options: TypegenOptions
): string {
    const hasChildren = node.children.size > 0;

    if (!hasChildren) {
        return resolveScalarType(path, node.constraints, diagnostics, options);
    }

    if (node.constraints?.type && node.constraints.type !== 'ObjectNode') {
        diagnostics.push({
            level: 'warning',
            code: 'PATH_TYPE_CONFLICT',
            message: `Path '${path}' has nested fields and scalar type '${node.constraints.type}'. Using object shape.`,
            path,
        });
    }

    const lines: string[] = ['{'];
    const keys = [...node.children.keys()].sort((a, b) => a.localeCompare(b));

    for (const key of keys) {
        const child = node.children.get(key);
        if (!child) continue;
        const childPath = `${path}${pathSegmentToCanonical(key)}`;
        const required = nodeIsRequired(child);
        const optionalMark = required ? '' : '?';
        const rendered = renderNodeType(childPath, child, `${indent}  `, diagnostics, options);
        lines.push(`${indent}  ${formatPropertyName(key)}${optionalMark}: ${rendered};`);
    }

    lines.push(`${indent}}`);
    return lines.join('\n');
}

function resolveIdentifier(
    maybeIdentifier: string | undefined,
    fallback: string,
    diagnostics: TypegenDiagnostic[],
    code: string,
    label: string
): string {
    if (!maybeIdentifier) return fallback;
    if (IDENTIFIER_RE.test(maybeIdentifier)) return maybeIdentifier;
    diagnostics.push({
        level: 'warning',
        code,
        message: `Invalid ${label} '${maybeIdentifier}', falling back to '${fallback}'.`,
    });
    return fallback;
}

function buildRuntimeBinderBlock(
    schema: SchemaV1,
    documentTypeName: string,
    options: TypegenOptions,
    diagnostics: TypegenDiagnostic[]
): string {
    const runtimeModule = options.runtimeModule ?? '@aeon/runtime';
    const schemaModule = options.schemaModule ?? '@aeos/core';
    const schemaConstName = resolveIdentifier(
        options.schemaConstName,
        `${documentTypeName}Schema`,
        diagnostics,
        'INVALID_SCHEMA_CONST_NAME',
        'schemaConstName'
    );
    const binderName = resolveIdentifier(
        options.binderName,
        `bind${documentTypeName}`,
        diagnostics,
        'INVALID_BINDER_NAME',
        'binderName'
    );
    const schemaLiteral = JSON.stringify(schema, null, 2);

    return [
        `import { createTypedRuntimeBinder, type TypedBinderOptions, type TypedRuntimeResult } from '${runtimeModule}';`,
        `import type { SchemaV1 } from '${schemaModule}';`,
        '',
        `export const ${schemaConstName}: SchemaV1 = ${schemaLiteral};`,
        '',
        `export function ${binderName}(options: TypedBinderOptions<${documentTypeName}> = {}): (input: string) => TypedRuntimeResult<${documentTypeName}> {`,
        `  return createTypedRuntimeBinder<${documentTypeName}>(${schemaConstName}, options);`,
        '}',
    ].join('\n');
}

export function generateTypes(schema: SchemaV1, options: TypegenOptions = {}): TypegenResult {
    const diagnostics: TypegenDiagnostic[] = [];
    const root = createNode();

    for (const rule of schema.rules) {
        const parsed = parseCanonicalPath(rule.path);
        if (!parsed.ok) {
            diagnostics.push({
                level: 'error',
                code: 'INVALID_SCHEMA_PATH',
                message: `Invalid schema path '${rule.path}': ${parsed.reason}`,
                path: rule.path,
            });
            continue;
        }

        let current = root;
        for (const segment of parsed.segments) {
            let next = current.children.get(segment);
            if (!next) {
                next = createNode();
                current.children.set(segment, next);
            }
            current = next;
        }

        if (current.constraints) {
            diagnostics.push({
                level: 'warning',
                code: 'DUPLICATE_RULE_PATH',
                message: `Duplicate schema rule path '${rule.path}' encountered. Last rule wins.`,
                path: rule.path,
            });
        }
        current.constraints = rule.constraints;
    }

    const name = resolveIdentifier(
        options.rootName,
        'AeonDocument',
        diagnostics,
        'INVALID_ROOT_NAME',
        'rootName'
    );

    const body = root.children.size === 0
        ? '{\n}'
        : renderNodeType('$', root, '', diagnostics, options);

    const blocks: string[] = [];
    blocks.push(`export interface ${name} ${body}`);

    if (options.emitRuntimeBinder) {
        blocks.push(buildRuntimeBinderBlock(schema, name, options, diagnostics));
    }

    return {
        code: `${blocks.join('\n\n')}\n`,
        diagnostics,
    };
}
