import { formatPath, type AssignmentEvent } from '@aeon/aes';
import type { AnnotationRecord } from '@aeon/annotation-stream';
import type { TonicInput } from './tonic.js';

export type MatterKind = 'object' | 'list' | 'scalar' | 'reference' | 'node';
export type MatterSpan = AssignmentEvent['span'];

export interface MatterAnnotation {
    readonly kind: AnnotationRecord['kind'];
    readonly form: AnnotationRecord['form'];
    readonly raw: string;
    readonly target: AnnotationRecord['target'];
    readonly subtype?: AnnotationRecord['subtype'];
}

export interface MatterReferenceValue {
    readonly __aeonRef: string;
}

export type MatterScalarValue = string | number | boolean | null;
export type MatterInput =
    | MatterScalarValue
    | MatterReferenceValue
    | { readonly [key: string]: MatterInput }
    | readonly MatterInput[];

export interface MatterNode {
    readonly kind: MatterKind;
    readonly address: string;
    readonly parent: MatterAnyNode | null;
    readonly span: MatterSpan | undefined;
    annotations(): readonly MatterAnnotation[];
    inspect(): string;
    remove(): void;
}

export interface MatterObject extends MatterNode {
    readonly kind: 'object';
    keys(): readonly string[];
    entries(): readonly [string, MatterAnyNode][];
    get(key: string): MatterAnyNode | undefined;
    set(key: string, value: MatterInput): MatterAnyNode;
    delete(key: string): void;
}

export interface MatterList extends MatterNode {
    readonly kind: 'list';
    length(): number;
    items(): readonly MatterAnyNode[];
    get(index: number): MatterAnyNode | undefined;
    set(index: number, value: MatterInput): MatterAnyNode;
    append(value: MatterInput): MatterAnyNode;
    insert(index: number, value: MatterInput): MatterAnyNode;
    delete(index: number): void;
}

export interface MatterScalar extends MatterNode {
    readonly kind: 'scalar';
    get(): MatterScalarValue;
    set(value: MatterScalarValue): MatterScalar;
}

export interface MatterReference extends MatterNode {
    readonly kind: 'reference';
    target(): string;
}

export interface MatterElementNode extends MatterNode {
    readonly kind: 'node';
    tag(): string;
    attributes(): ReadonlyMap<string, MatterScalarValue>;
    children(): readonly MatterAnyNode[];
}

export type MatterAnyNode = MatterObject | MatterList | MatterScalar | MatterReference | MatterElementNode;

export interface AeonMatter {
    readonly root: MatterObject | MatterList;
    at(address: string): MatterAnyNode | undefined;
    has(address: string): boolean;
    inspect(address?: string): string;
    serialize(): string;
    toSchema(): unknown;
}

export interface MatterTonicResult {
    readonly aes: readonly AssignmentEvent[];
    readonly annotations?: readonly AnnotationRecord[];
    readonly document?: AeonMatter;
    readonly meta?: {
        readonly errors?: readonly { readonly message: string; readonly code?: string }[];
        readonly warnings?: readonly { readonly message: string; readonly code?: string }[];
    };
}

type Diagnostic = { readonly message: string; readonly code?: string };
type AnnotationMap = ReadonlyMap<string, readonly MatterAnnotation[]>;
type Value = AssignmentEvent['value'];
type ReferencePathSegment = Extract<Value, { type: 'CloneReference' | 'PointerReference' }>['path'][number];

abstract class BaseMatterNode implements MatterNode {
    private _address = '$';
    private _parent: MatterAnyNode | null = null;

    constructor(
        public owner: AeonMatterDocument,
        public readonly span: MatterSpan | undefined = undefined,
    ) { }

    abstract readonly kind: MatterKind;

    get address(): string {
        return this._address;
    }

    get parent(): MatterAnyNode | null {
        return this._parent;
    }

    setAddress(address: string): void {
        this._address = address;
    }

    setParent(parent: MatterAnyNode | null): void {
        this._parent = parent;
    }

    annotations(): readonly MatterAnnotation[] {
        return this.owner.annotationMap.get(this.address) ?? [];
    }

    inspect(): string {
        return `${this.kind} ${this.address} = ${serializeNode(this as unknown as MatterAnyNode)}`;
    }

    remove(): void {
        if (!this.parent) {
            throw new Error('Cannot remove root node.');
        }
        this.owner.removeNode(this as unknown as MatterAnyNode);
    }
}

class MatterObjectNode extends BaseMatterNode implements MatterObject {
    readonly kind = 'object' as const;
    private readonly fields = new Map<string, MatterAnyNode>();

    keys(): readonly string[] {
        return [...this.fields.keys()];
    }

    entries(): readonly [string, MatterAnyNode][] {
        return [...this.fields.entries()];
    }

    get(key: string): MatterAnyNode | undefined {
        return this.fields.get(key);
    }

    set(key: string, value: MatterInput): MatterAnyNode {
        const node = this.owner.createInputNode(value);
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.fields.set(key, node);
        this.owner.reindex();
        return node;
    }

    delete(key: string): void {
        if (this.fields.delete(key)) {
            this.owner.reindex();
        }
    }

    attach(key: string, node: MatterAnyNode): void {
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.fields.set(key, node);
    }

    detachNode(target: MatterAnyNode): boolean {
        for (const [key, value] of this.fields) {
            if (value === target) {
                this.fields.delete(key);
                return true;
            }
        }
        return false;
    }
}

class MatterListNode extends BaseMatterNode implements MatterList {
    readonly kind = 'list' as const;
    private readonly elements: MatterAnyNode[] = [];

    length(): number {
        return this.elements.length;
    }

    items(): readonly MatterAnyNode[] {
        return [...this.elements];
    }

    get(index: number): MatterAnyNode | undefined {
        return this.elements[index];
    }

    set(index: number, value: MatterInput): MatterAnyNode {
        if (!Number.isInteger(index) || index < 0 || index >= this.elements.length) {
            throw new Error(`List index out of range: ${index}`);
        }
        const node = this.owner.createInputNode(value);
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.elements[index] = node;
        this.owner.reindex();
        return node;
    }

    append(value: MatterInput): MatterAnyNode {
        const node = this.owner.createInputNode(value);
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.elements.push(node);
        this.owner.reindex();
        return node;
    }

    insert(index: number, value: MatterInput): MatterAnyNode {
        if (!Number.isInteger(index) || index < 0 || index > this.elements.length) {
            throw new Error(`List index out of range: ${index}`);
        }
        const node = this.owner.createInputNode(value);
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.elements.splice(index, 0, node);
        this.owner.reindex();
        return node;
    }

    delete(index: number): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.elements.length) {
            throw new Error(`List index out of range: ${index}`);
        }
        this.elements.splice(index, 1);
        this.owner.reindex();
    }

    attach(node: MatterAnyNode): void {
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.elements.push(node);
    }

    detachNode(target: MatterAnyNode): boolean {
        const index = this.elements.indexOf(target);
        if (index < 0) return false;
        this.elements.splice(index, 1);
        return true;
    }
}

class MatterScalarNode extends BaseMatterNode implements MatterScalar {
    readonly kind = 'scalar' as const;

    constructor(
        owner: AeonMatterDocument,
        private value: MatterScalarValue,
        span?: MatterSpan,
    ) {
        super(owner, span);
    }

    get(): MatterScalarValue {
        return this.value;
    }

    set(value: MatterScalarValue): MatterScalar {
        this.value = value;
        this.owner.reindex();
        return this as unknown as MatterScalar;
    }
}

class MatterReferenceNode extends BaseMatterNode implements MatterReference {
    readonly kind = 'reference' as const;

    constructor(
        owner: AeonMatterDocument,
        private readonly refTarget: string,
        span?: MatterSpan,
    ) {
        super(owner, span);
    }

    target(): string {
        return this.refTarget;
    }
}

class MatterElementRuntimeNode extends BaseMatterNode implements MatterElementNode {
    readonly kind = 'node' as const;
    private readonly attrs = new Map<string, MatterScalarValue>();
    private readonly childNodes: MatterAnyNode[] = [];

    constructor(
        owner: AeonMatterDocument,
        private readonly tagName: string,
        span?: MatterSpan,
    ) {
        super(owner, span);
    }

    tag(): string {
        return this.tagName;
    }

    attributes(): ReadonlyMap<string, MatterScalarValue> {
        return this.attrs;
    }

    children(): readonly MatterAnyNode[] {
        return [...this.childNodes];
    }

    setAttribute(key: string, value: MatterScalarValue): void {
        this.attrs.set(key, value);
    }

    appendChild(node: MatterAnyNode): void {
        (node as unknown as BaseMatterNode).setParent(this as unknown as MatterAnyNode);
        this.childNodes.push(node);
    }

    detachNode(target: MatterAnyNode): boolean {
        const index = this.childNodes.indexOf(target);
        if (index < 0) return false;
        this.childNodes.splice(index, 1);
        return true;
    }
}

class AeonMatterDocument implements AeonMatter {
    readonly root: MatterObjectNode | MatterListNode;
    readonly annotationMap: AnnotationMap;
    private readonly nodesByAddress = new Map<string, MatterAnyNode>();

    constructor(root: MatterObjectNode | MatterListNode, annotationMap: AnnotationMap) {
        this.root = root;
        this.annotationMap = annotationMap;
        this.reindex();
    }

    at(address: string): MatterAnyNode | undefined {
        return this.nodesByAddress.get(address);
    }

    has(address: string): boolean {
        return this.nodesByAddress.has(address);
    }

    inspect(address?: string): string {
        const node = address ? this.at(address) : this.root;
        if (!node) {
            throw new Error(`Unknown matter address: ${address}`);
        }
        return node.inspect();
    }

    serialize(): string {
        if (this.root.kind === 'object') {
            return serializeRootObject(this.root);
        }
        return serializeNode(this.root);
    }

    toSchema(): unknown {
        return deriveSchema(this.root);
    }

    removeNode(node: MatterAnyNode): void {
        const parent = node.parent;
        if (!parent) {
            throw new Error('Cannot remove root node.');
        }
        if (parent instanceof MatterObjectNode) {
            parent.detachNode(node);
        } else if (parent instanceof MatterListNode) {
            parent.detachNode(node);
        } else if (parent instanceof MatterElementRuntimeNode) {
            parent.detachNode(node);
        }
        this.reindex();
    }

    createInputNode(value: MatterInput): MatterAnyNode {
        if (Array.isArray(value)) {
            const list = new MatterListNode(this);
            for (const entry of value) {
                list.attach(this.createInputNode(entry));
            }
            return list;
        }
        if (isReferenceValue(value)) {
            return new MatterReferenceNode(this, value.__aeonRef);
        }
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return new MatterScalarNode(this, value);
        }
        const objectNode = new MatterObjectNode(this);
        for (const [key, child] of Object.entries(value)) {
            objectNode.attach(key, this.createInputNode(child));
        }
        return objectNode;
    }

    reindex(): void {
        this.nodesByAddress.clear();
        assignAddresses(this.root, '$', this.nodesByAddress);
    }
}

export function materializeMatter(input: TonicInput): MatterTonicResult {
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    const annotationMap = buildAnnotationMap(input.annotations);
    const topLevel = input.aes.filter((event) => event.path.segments.length === 2 && event.path.segments[0]?.type === 'root');

    const root = new MatterObjectNode(undefined as unknown as AeonMatterDocument);
    const document = new AeonMatterDocument(root, annotationMap);
    root.owner = document;

    for (const event of topLevel) {
        const segment = event.path.segments[1];
        if (!segment || segment.type !== 'member') {
            errors.push({
                code: 'MATTER_UNSUPPORTED_ROOT',
                message: `Unsupported top-level path for AEON Matter: ${formatPath(event.path)}`,
            });
            continue;
        }
        const node = valueToMatterNode(document, event.value, errors);
        if (node) {
            root.attach(segment.key, node);
        }
    }

    if (errors.length > 0) {
        return {
            aes: input.aes,
            ...(input.annotations ? { annotations: input.annotations } : {}),
            meta: {
                errors,
                ...(warnings.length > 0 ? { warnings } : {}),
            },
        };
    }

    document.reindex();
    return {
        aes: input.aes,
        ...(input.annotations ? { annotations: input.annotations } : {}),
        document,
        ...(warnings.length > 0 ? { meta: { warnings } } : {}),
    };
}

function valueToMatterNode(
    owner: AeonMatterDocument,
    value: Value,
    errors: Diagnostic[],
): MatterAnyNode | null {
    switch (value.type) {
        case 'StringLiteral':
            return new MatterScalarNode(owner, value.value, value.span);
        case 'NumberLiteral':
            return new MatterScalarNode(owner, parseNumericString(value.value), value.span);
        case 'InfinityLiteral':
            return new MatterScalarNode(owner, value.value, value.span);
        case 'BooleanLiteral':
            return new MatterScalarNode(owner, value.value, value.span);
        case 'SwitchLiteral':
            return new MatterScalarNode(owner, value.value === 'yes' || value.value === 'on', value.span);
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return new MatterScalarNode(owner, value.value, value.span);
        case 'CloneReference':
        case 'PointerReference':
            return new MatterReferenceNode(owner, formatReference(value.path, value.type === 'PointerReference'), value.span);
        case 'ObjectNode': {
            const objectNode = new MatterObjectNode(owner, value.span);
            for (const binding of value.bindings) {
                const childNode = valueToMatterNode(owner, binding.value, errors);
                if (childNode) {
                    objectNode.attach(binding.key, childNode);
                }
            }
            return objectNode;
        }
        case 'ListNode': {
            const listNode = new MatterListNode(owner, value.span);
            for (const element of value.elements) {
                const childNode = valueToMatterNode(owner, element, errors);
                if (childNode) {
                    listNode.attach(childNode);
                }
            }
            return listNode;
        }
        case 'NodeLiteral': {
            const node = new MatterElementRuntimeNode(owner, value.tag, value.span);
            for (const attribute of value.attributes) {
                for (const [key, entry] of attribute.entries) {
                    const attrValue = scalarValueFromValue(entry.value);
                    if (attrValue !== undefined) {
                        node.setAttribute(key, attrValue);
                    }
                }
            }
            for (const child of value.children) {
                const childNode = valueToMatterNode(owner, child, errors);
                if (childNode) {
                    node.appendChild(childNode);
                }
            }
            return node;
        }
        case 'TupleLiteral':
            errors.push({
                code: 'MATTER_UNSUPPORTED_TUPLE',
                message: 'AEON Matter v1 does not support tuple runtime semantics.',
            });
            return null;
        default: {
            const exhaustive: never = value;
            return exhaustive;
        }
    }
}

function buildAnnotationMap(annotations: readonly AnnotationRecord[] | undefined): AnnotationMap {
    const map = new Map<string, MatterAnnotation[]>();
    for (const record of annotations ?? []) {
        if (record.target.kind !== 'path') continue;
        const bucket = map.get(record.target.path) ?? [];
        bucket.push({
            kind: record.kind,
            form: record.form,
            raw: record.raw,
            target: record.target,
            ...(record.subtype ? { subtype: record.subtype } : {}),
        });
        map.set(record.target.path, bucket);
    }
    return map;
}

function assignAddresses(node: MatterAnyNode, address: string, registry: Map<string, MatterAnyNode>): void {
    (node as unknown as BaseMatterNode).setAddress(address);
    registry.set(address, node);
    if (node.kind === 'object') {
        for (const [key, child] of node.entries()) {
            assignAddresses(child, `${address}.${formatMemberKey(key)}`, registry);
        }
        return;
    }
    if (node.kind === 'list') {
        node.items().forEach((child, index) => {
            assignAddresses(child, `${address}[${index}]`, registry);
        });
        return;
    }
    if (node.kind === 'node') {
        node.children().forEach((child, index) => {
            assignAddresses(child, `${address}.$children[${index}]`, registry);
        });
    }
}

function serializeRootObject(node: MatterObjectNode): string {
    return node.entries()
        .map(([key, value]) => `${serializeKey(key)} = ${serializeNode(value)}`)
        .join('\n');
}

function serializeNode(node: MatterAnyNode): string {
    switch (node.kind) {
        case 'object':
            return `{ ${node.entries().map(([key, value]) => `${serializeKey(key)} = ${serializeNode(value)}`).join(', ')} }`;
        case 'list':
            return `[${node.items().map((entry) => serializeNode(entry)).join(', ')}]`;
        case 'scalar': {
            const value = node.get();
            if (typeof value === 'string') return JSON.stringify(value);
            if (value === null) return 'null';
            return String(value);
        }
        case 'reference':
            return node.target();
        case 'node': {
            const attrs = [...node.attributes().entries()]
                .map(([key, value]) => `${serializeKey(key)} = ${serializeScalarValue(value)}`)
                .join(', ');
            const children = node.children().map((entry) => serializeNode(entry)).join(', ');
            const attrPart = attrs.length > 0 ? `@{${attrs}}` : '';
            const childPart = children.length > 0 ? `(${children})` : '';
            return `<${node.tag()}${attrPart}${childPart}>`;
        }
    }
}

function deriveSchema(node: MatterAnyNode): unknown {
    switch (node.kind) {
        case 'object':
            return {
                type: 'object',
                properties: Object.fromEntries(node.entries().map(([key, value]) => [key, deriveSchema(value)])),
            };
        case 'list':
            return {
                type: 'list',
                elements: node.items().map((item) => deriveSchema(item)),
            };
        case 'scalar': {
            const value = node.get();
            return { type: value === null ? 'null' : typeof value };
        }
        case 'reference':
            return { type: 'reference' };
        case 'node':
            return {
                type: 'node',
                tag: node.tag(),
                attributes: Object.fromEntries(node.attributes()),
                children: node.children().map((item) => deriveSchema(item)),
            };
    }
}

function parseNumericString(value: string): number {
    const parsed = Number(value.replaceAll('_', ''));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function formatReference(path: readonly ReferencePathSegment[], pointer: boolean): string {
    const prefix = pointer ? '~>' : '~';
    const body = path.map((segment, index) => {
        if (typeof segment === 'string') {
            return index === 0 ? segment : `.${segment}`;
        }
        if (typeof segment === 'number') {
            return `[${segment}]`;
        }
        return `@${segment.key}`;
    }).join('');
    return `${prefix}${body}`;
}

function formatMemberKey(key: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `["${escapeString(key)}"]`;
}

function serializeKey(key: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}

function serializeScalarValue(value: MatterScalarValue): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null) return 'null';
    return String(value);
}

function escapeString(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function isReferenceValue(value: MatterInput): value is MatterReferenceValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && '__aeonRef' in value;
}

function scalarValueFromValue(value: Value): MatterScalarValue | undefined {
    switch (value.type) {
        case 'StringLiteral':
            return value.value;
        case 'NumberLiteral':
            return parseNumericString(value.value);
        case 'InfinityLiteral':
            return value.value;
        case 'BooleanLiteral':
            return value.value;
        case 'SwitchLiteral':
            return value.value === 'yes' || value.value === 'on';
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return value.value;
        default:
            return undefined;
    }
}
