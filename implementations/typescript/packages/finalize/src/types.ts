import type { AssignmentEvent } from '@aeon/aes';

type Span = AssignmentEvent['span'];
type Value = AssignmentEvent['value'];
type AnnotationMap = NonNullable<AssignmentEvent['annotations']>;
type AnnotationEntry = AnnotationMap extends ReadonlyMap<string, infer T>
    ? T
    : { value: Value; datatype?: string };

export type DiagnosticLevel = 'error' | 'warning';

export interface Diagnostic {
    readonly level: DiagnosticLevel;
    readonly message: string;
    readonly code?: string;
    readonly span?: Span;
    readonly path?: string;
}

export interface FinalizedEntry {
    readonly path: string;
    readonly value: Value;
    readonly span: Span;
    readonly datatype?: string;
    readonly annotations?: ReadonlyMap<string, AnnotationEntry>;
}

export interface FinalizedMap {
    readonly entries: ReadonlyMap<string, FinalizedEntry>;
}

export interface FinalizeOptions {
    readonly mode?: 'strict' | 'loose';
    readonly materialization?: 'all' | 'projected';
    readonly includePaths?: readonly string[];
    readonly scope?: FinalizeScope;
    readonly header?: FinalizeHeader;
    readonly maxMaterializedWeight?: number;
}

export type FinalizeScope = 'full' | 'header' | 'payload';

export interface FinalizeHeader {
    readonly fields: ReadonlyMap<string, Value>;
    readonly span?: Span;
    readonly form?: 'structured' | 'shorthand';
}

export interface FinalizeMeta {
    readonly errors?: readonly Diagnostic[];
    readonly warnings?: readonly Diagnostic[];
}

export interface FinalizeResult {
    readonly document: FinalizedMap;
    readonly meta?: FinalizeMeta;
}

export type FinalizeInput = readonly AssignmentEvent[];

export type JsonPrimitive = null | boolean | number | string;

export interface JsonObject {
    [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface FinalizeJsonResult {
    readonly document: JsonObject;
    readonly meta?: FinalizeMeta;
}

export type FinalizedNode =
    | FinalizedObjectNode
    | FinalizedListNode
    | FinalizedScalarNode
    | FinalizedReferenceNode;

export interface FinalizedNodeBase {
    readonly span: Span;
    readonly datatype?: string;
    readonly annotations?: ReadonlyMap<string, AnnotationEntry>;
}

export interface FinalizedObjectNode extends FinalizedNodeBase {
    readonly type: 'Object';
    readonly entries: ReadonlyMap<string, FinalizedNode>;
}

export interface FinalizedListNode extends FinalizedNodeBase {
    readonly type: 'List';
    readonly items: readonly FinalizedNode[];
}

export interface FinalizedScalarNode extends FinalizedNodeBase {
    readonly type:
        | 'String'
        | 'Number'
        | 'Boolean'
        | 'Switch'
        | 'Hex'
        | 'Radix'
        | 'Encoding'
        | 'Separator'
        | 'Date'
        | 'DateTime'
        | 'Time';
    readonly value: string | number | boolean;
    readonly raw: string;
}

export interface FinalizedReferenceNode extends FinalizedNodeBase {
    readonly type: 'Reference';
    readonly kind: 'clone' | 'pointer';
    readonly path: readonly (string | number | { readonly type: 'attr'; readonly key: string })[];
    readonly token: string;
}

export interface FinalizedNodeDocument {
    readonly root: FinalizedObjectNode;
}

export interface FinalizeNodeResult {
    readonly document: FinalizedNodeDocument;
    readonly meta?: FinalizeMeta;
}

export interface NodeTransformContext {
    readonly path: readonly string[];
}

export interface NodeTransform {
    enter?(node: FinalizedNode, ctx: NodeTransformContext): FinalizedNode | void;
    leave?(node: FinalizedNode, ctx: NodeTransformContext): FinalizedNode | void;
}

export interface OutputProfile<TDocument> {
    readonly id: string;
    finalize(aes: FinalizeInput, options?: FinalizeOptions): { document: TDocument; meta?: FinalizeMeta };
}

export type OutputProfileRef<TDocument> = string | OutputProfile<TDocument>;

export interface OutputRegistry {
    register<TDocument>(profile: OutputProfile<TDocument>): OutputRegistry;
    get(id: string): OutputProfile<unknown> | undefined;
    has(id: string): boolean;
    list(): readonly OutputProfile<unknown>[];
}

export interface FinalizeWithProfileOptions<TDocument> {
    readonly profile: OutputProfileRef<TDocument>;
    readonly registry?: OutputRegistry;
    readonly mode?: 'strict' | 'loose';
}
