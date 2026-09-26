import { aeonRadixBaseFromDatatype, formatPath, type CompileResult } from '@altopelago/aeon-core';
import type { SansaResolveBinding, SansaResolveNamespace } from '@altopelago/sansa';
import {
  indexEventsByPath,
  readAeon,
  type ReadAeonResult,
  type ReadAeonOptions,
} from './index.js';

export type AeonAssignmentEvent = CompileResult['events'][number];
type AeonValue = AeonAssignmentEvent['value'];
type UnwrappedAeonValue = Exclude<AeonValue, { readonly type: 'TypedValue' }>;
type AeonAttributeEntry = NonNullable<AeonAssignmentEvent['annotations']> extends ReadonlyMap<string, infer TEntry>
  ? TEntry
  : never;

export type AeonNamespaceScope = 'payload' | 'header' | 'full';
export type AeonNumericMaterialization = 'lossless' | 'native';

export interface CreateAeonNamespaceOptions {
  /** Select the AEON document plane exposed at the SANSA root. Defaults to `payload`. */
  readonly scope?: AeonNamespaceScope;
  /** Materialize finite numbers as canonical strings or JavaScript numbers. Defaults to `lossless`. */
  readonly numericMaterialization?: AeonNumericMaterialization;
}

export interface ReadAeonNamespaceOptions extends ReadAeonOptions {
  readonly namespace?: CreateAeonNamespaceOptions;
}

export interface AeonSansaBinding extends SansaResolveBinding {
  address: string;
  identity?: string;
  name?: string;
  index?: number;
  semanticType?: string;
  representationKind?: string;
  scalarKind?: string;
  nullReason?: string;
  numericLexeme?: string;
  radixBase?: number;
  value?: unknown;
  children: AeonSansaBinding[];
  attributeSpace?: AeonSansaBinding;
  nodeTag?: string;
  sourcePlane?: 'header' | 'body';
}

export type AeonSansaNamespace = SansaResolveNamespace<AeonSansaBinding> & {
  readonly root: AeonSansaBinding;
  readonly numericLexeme: (binding: AeonSansaBinding) => string | undefined;
  readonly radixBase: (binding: AeonSansaBinding) => number | undefined;
};

export interface ReadAeonNamespaceResult extends ReadAeonResult {
  readonly eventsByPath: ReadonlyMap<string, AeonAssignmentEvent>;
  readonly namespace: AeonSansaNamespace;
}

/**
 * Adapt compiled AEON assignment events into a queryable SANSA namespace.
 *
 * Scalar AST values are exposed without losing finite-number precision while
 * AEON datatype, representation, null, identity, and attribute metadata are
 * kept on the corresponding binding.
 */
export function createAeonNamespace(
  events: readonly AeonAssignmentEvent[],
  options: CreateAeonNamespaceOptions = {},
): AeonSansaNamespace {
  const scope = options.scope ?? 'payload';
  const numericMaterialization = options.numericMaterialization ?? 'lossless';
  const root: AeonSansaBinding = {
    address: '$',
    representationKind: 'object',
    children: [],
  };
  const byAddress = new Map<string, AeonSansaBinding>([['$', root]]);
  const parents = new Map<AeonSansaBinding, AeonSansaBinding | undefined>([[root, undefined]]);

  for (const event of events) {
    if (!eventIsInScope(event, scope)) continue;

    const address = formatPath(event.path);
    const parentAddress = parentPathAddress(event.path);
    const parent = byAddress.get(parentAddress);
    if (!parent) {
      throw new Error(`AEON event '${address}' has no parent binding '${parentAddress}' in the selected '${scope}' scope.`);
    }

    const existing = byAddress.get(address);
    if (existing) {
      throw new Error(`AEON events contain more than one binding at '${address}'.`);
    }

    const binding = bindingFromEvent(event, address, parents, numericMaterialization);
    byAddress.set(address, binding);
    parents.set(binding, parent);
    parent.children.push(binding);
  }

  return {
    root,
    children: (binding) => binding.children,
    parent: (binding) => parents.get(binding),
    member: (binding, name) => binding.children.find((child) => child.name === name),
    position: (binding, index) => binding.children.find((child) => child.index === index),
    attributeSpace: (binding) => binding.attributeSpace,
    name: (binding) => binding.name,
    index: (binding) => binding.index,
    semanticType: (binding) => binding.semanticType,
    representationKind: (binding) => binding.representationKind,
    value: (binding) => binding.value,
    nullReason: (binding) => binding.nullReason,
    numericLexeme: (binding) => binding.numericLexeme,
    radixBase: (binding) => binding.radixBase,
    representationKindMatches: (binding, expected) => representationKindMatches(binding.representationKind, expected),
  };
}

/** Compile and adapt AEON source into a SANSA namespace. */
export function readAeonNamespace(
  input: string,
  options: ReadAeonNamespaceOptions = {},
): ReadAeonNamespaceResult {
  const { namespace: namespaceOptions, ...readOptions } = options;
  const result = readAeon(input, readOptions);
  if (result.compile.errors.length > 0) {
    const summary = result.compile.errors.map((error) => `${error.code}: ${error.message}`).join('\n');
    throw new Error(`AEON compile failed with ${result.compile.errors.length} error(s):\n${summary}`);
  }
  return {
    ...result,
    eventsByPath: indexEventsByPath(result.compile.events),
    namespace: createAeonNamespace(result.compile.events, namespaceOptions),
  };
}

function eventIsInScope(event: AeonAssignmentEvent, scope: AeonNamespaceScope): boolean {
  if (scope === 'full') return true;
  if (scope === 'header') return event.sourcePlane === 'header';
  return event.sourcePlane !== 'header';
}

function parentPathAddress(path: AeonAssignmentEvent['path']): string {
  if (path.segments.length <= 1) return '$';
  return formatPath({ segments: path.segments.slice(0, -1) });
}

function bindingFromEvent(
  event: AeonAssignmentEvent,
  address: string,
  parents: Map<AeonSansaBinding, AeonSansaBinding | undefined>,
  numericMaterialization: AeonNumericMaterialization,
): AeonSansaBinding {
  const segment = event.path.segments[event.path.segments.length - 1];
  const semanticType = event.datatype ?? semanticTypeFromValue(event.value);
  const binding: AeonSansaBinding = {
    address,
    children: [],
    representationKind: representationKindFromValue(event.value, semanticType),
    ...(event.structuralId !== undefined && event.structuralId !== null ? { identity: event.structuralId } : {}),
    ...(event.sourcePlane ? { sourcePlane: event.sourcePlane } : {}),
    ...(semanticType ? { semanticType } : {}),
  };

  if (segment?.type === 'member') binding.name = segment.key;
  if (segment?.type === 'index') binding.index = segment.index;

  const scalarKind = scalarKindFromValue(event.value, semanticType);
  if (scalarKind !== undefined) binding.scalarKind = scalarKind;
  const nullReason = nullReasonFromValue(event.value);
  if (nullReason !== undefined) binding.nullReason = nullReason;
  const numericLexeme = numericLexemeFromValue(event.value);
  if (numericLexeme !== undefined) binding.numericLexeme = numericLexeme;
  const radixBase = radixBaseFromValue(event.value, semanticType);
  if (radixBase !== undefined) binding.radixBase = radixBase;
  const scalar = scalarFromAeonValue(event.value, numericMaterialization);
  if (scalar.ok) binding.value = scalar.value;

  const unwrapped = unwrapTypedValue(event.value);
  if (unwrapped.type === 'NodeLiteral') binding.nodeTag = unwrapped.tag;
  if (event.annotations?.size) {
    binding.attributeSpace = buildAttributeSpace(address, event.annotations, binding, parents, numericMaterialization);
  }

  return binding;
}

function buildAttributeSpace(
  ownerAddress: string,
  annotations: ReadonlyMap<string, AeonAttributeEntry>,
  owner: AeonSansaBinding,
  parents: Map<AeonSansaBinding, AeonSansaBinding | undefined>,
  numericMaterialization: AeonNumericMaterialization,
): AeonSansaBinding {
  const space: AeonSansaBinding = {
    address: `${ownerAddress}.@`,
    representationKind: 'attributeSpace',
    children: [],
  };

  for (const [name, entry] of annotations) {
    const semanticType = entry.datatype ?? semanticTypeFromValue(entry.value);
    const binding: AeonSansaBinding = {
      address: appendMember(space.address, name),
      name,
      children: [],
      representationKind: representationKindFromValue(entry.value, semanticType),
      ...(entry.structuralId !== undefined && entry.structuralId !== null ? { identity: entry.structuralId } : {}),
      ...(semanticType ? { semanticType } : {}),
    };
    const scalarKind = scalarKindFromValue(entry.value, semanticType);
    if (scalarKind !== undefined) binding.scalarKind = scalarKind;
    const nullReason = nullReasonFromValue(entry.value);
    if (nullReason !== undefined) binding.nullReason = nullReason;
    const numericLexeme = numericLexemeFromValue(entry.value);
    if (numericLexeme !== undefined) binding.numericLexeme = numericLexeme;
    const radixBase = radixBaseFromValue(entry.value, binding.semanticType);
    if (radixBase !== undefined) binding.radixBase = radixBase;
    const scalar = scalarFromAeonValue(entry.value, numericMaterialization);
    if (scalar.ok) binding.value = scalar.value;
    if (entry.annotations?.size) {
      binding.attributeSpace = buildAttributeSpace(
        binding.address,
        entry.annotations,
        binding,
        parents,
        numericMaterialization,
      );
    }
    parents.set(binding, space);
    space.children.push(binding);
  }

  parents.set(space, owner);
  return space;
}

function unwrapTypedValue(value: AeonValue): UnwrappedAeonValue {
  return value.type === 'TypedValue' ? unwrapTypedValue(value.value) : value;
}

function semanticTypeFromValue(value: AeonValue): string | undefined {
  const unwrapped = unwrapTypedValue(value);
  switch (unwrapped.type) {
    case 'StringLiteral': return 'string';
    case 'NumberLiteral': return 'number';
    case 'InfinityLiteral': return 'infinity';
    case 'NaNLiteral': return 'nan';
    case 'BooleanLiteral': return 'boolean';
    case 'NullLiteral': return 'null';
    case 'ToggleLiteral': return 'toggle';
    case 'HexLiteral': return 'hex';
    case 'RadixLiteral': return 'radix';
    case 'EncodingLiteral': return 'encoding';
    case 'SeparatorLiteral': return 'sep';
    case 'SansaAddressLiteral': return 'sansa';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return 'time';
    case 'DateTimeLiteral': return 'datetime';
    case 'ObjectNode':
    case 'ListNode':
    case 'TupleLiteral':
    case 'NodeLiteral':
    case 'CloneReference':
    case 'PointerReference':
      return undefined;
  }
}

function representationKindFromValue(value: AeonValue, semanticType?: string): string {
  const unwrapped = unwrapTypedValue(value);
  switch (unwrapped.type) {
    case 'ObjectNode': return 'object';
    case 'ListNode': return 'list';
    case 'TupleLiteral': return 'tuple';
    case 'NodeLiteral': return 'node';
    case 'StringLiteral': return 'string';
    case 'NumberLiteral': return 'number';
    case 'InfinityLiteral': return 'infinity';
    case 'NaNLiteral': return 'nan';
    case 'BooleanLiteral': return 'boolean';
    case 'NullLiteral': return 'null';
    case 'ToggleLiteral': return 'toggle';
    case 'HexLiteral': return 'hex';
    case 'RadixLiteral': return 'radix';
    case 'EncodingLiteral': return 'encoding';
    case 'SeparatorLiteral': return 'separator';
    case 'SansaAddressLiteral': return 'sansa';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return temporalKindFromSemanticType(semanticType);
    case 'DateTimeLiteral': return temporalKindFromSemanticType(semanticType);
    case 'CloneReference': return 'cloneReference';
    case 'PointerReference': return 'pointerReference';
  }
}

function scalarKindFromValue(value: AeonValue, semanticType?: string): string | undefined {
  const unwrapped = unwrapTypedValue(value);
  switch (unwrapped.type) {
    case 'NullLiteral': return 'null';
    case 'InfinityLiteral': return 'infinity';
    case 'NaNLiteral': return 'nan';
    case 'ToggleLiteral': return 'toggle';
    case 'HexLiteral': return 'hex';
    case 'RadixLiteral': return 'radix';
    case 'EncodingLiteral': return 'encoding';
    case 'SeparatorLiteral': return 'separator';
    case 'SansaAddressLiteral': return 'sansaAddress';
    case 'NumberLiteral': return 'number';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return temporalKindFromSemanticType(semanticType);
    case 'DateTimeLiteral': return temporalKindFromSemanticType(semanticType);
    case 'CloneReference':
    case 'PointerReference':
      return 'referenceForm';
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'ObjectNode':
    case 'ListNode':
    case 'TupleLiteral':
    case 'NodeLiteral':
      return undefined;
  }
}

function scalarFromAeonValue(
  value: AeonValue,
  numericMaterialization: AeonNumericMaterialization,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const unwrapped = unwrapTypedValue(value);
  switch (unwrapped.type) {
    case 'StringLiteral':
    case 'DateLiteral':
    case 'DateTimeLiteral':
    case 'TimeLiteral':
    case 'HexLiteral':
    case 'RadixLiteral':
    case 'EncodingLiteral':
    case 'SeparatorLiteral':
    case 'ToggleLiteral':
      return { ok: true, value: unwrapped.value };
    case 'NumberLiteral':
      return {
        ok: true,
        value: numericMaterialization === 'native' ? Number(unwrapped.value) : unwrapped.value,
      };
    case 'InfinityLiteral':
      return { ok: true, value: unwrapped.value === '-Infinity' ? -Infinity : Infinity };
    case 'NaNLiteral':
      return { ok: true, value: Number.NaN };
    case 'BooleanLiteral':
      return { ok: true, value: unwrapped.value };
    case 'NullLiteral':
      return { ok: true, value: null };
    case 'SansaAddressLiteral':
      return {
        ok: true,
        value: {
          type: 'SansaAddressLiteral',
          address: unwrapped.canonical,
          canonical: unwrapped.canonical,
        },
      };
    case 'CloneReference':
    case 'PointerReference':
      return {
        ok: true,
        value: {
          type: unwrapped.type,
          path: unwrapped.path,
          canonical: `${unwrapped.type === 'PointerReference' ? '~>' : '~'}${formatReferencePath(unwrapped.path)}`,
        },
      };
    case 'ObjectNode':
    case 'ListNode':
    case 'TupleLiteral':
    case 'NodeLiteral':
      return { ok: false };
  }
}

function numericLexemeFromValue(value: AeonValue): string | undefined {
  const unwrapped = unwrapTypedValue(value);
  return unwrapped.type === 'NumberLiteral' ? unwrapped.value : undefined;
}

function radixBaseFromValue(value: AeonValue, semanticType?: string): number | undefined {
  const unwrapped = unwrapTypedValue(value);
  return unwrapped.type === 'RadixLiteral' ? aeonRadixBaseFromDatatype(semanticType) : undefined;
}

function nullReasonFromValue(value: AeonValue): string | undefined {
  const unwrapped = unwrapTypedValue(value);
  return unwrapped.type === 'NullLiteral' ? unwrapped.value : undefined;
}

function temporalKindFromSemanticType(semanticType?: string): string {
  const base = semanticType?.split(/[<[]/u, 1)[0];
  return base && ['date', 'time', 'datetime', 'wtc'].includes(base) ? base : 'datetime';
}

function representationKindMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return actual === expected || lowerFirst(actual) === expected || representationAlias(actual) === expected;
}

function representationAlias(kind: string): string | undefined {
  switch (kind) {
    case 'StringLiteral': return 'string';
    case 'NumberLiteral': return 'number';
    case 'InfinityLiteral': return 'infinity';
    case 'NaNLiteral': return 'nan';
    case 'NullLiteral': return 'null';
    case 'BooleanLiteral': return 'boolean';
    case 'ToggleLiteral': return 'toggle';
    case 'HexLiteral': return 'hex';
    case 'RadixLiteral': return 'radix';
    case 'EncodingLiteral': return 'encoding';
    case 'SeparatorLiteral': return 'separator';
    case 'SansaAddressLiteral': return 'sansa';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return 'time';
    case 'DateTimeLiteral': return 'datetime';
    case 'ObjectNode': return 'object';
    case 'ListNode': return 'list';
    case 'TupleLiteral': return 'tuple';
    case 'NodeLiteral': return 'node';
    case 'CloneReference': return 'cloneReference';
    case 'PointerReference': return 'pointerReference';
    default: return undefined;
  }
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function appendMember(base: string, name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    ? `${base}.${name}`
    : `${base}.[${JSON.stringify(name)}]`;
}

function formatReferencePath(path: readonly (string | number | { readonly type: 'attr'; readonly key: string })[]): string {
  let output = '';
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    if (typeof segment === 'number') {
      output += `[${segment}]`;
      continue;
    }
    if (typeof segment === 'object') {
      output += /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment.key)
        ? `.@.${segment.key}`
        : `.@.[${JSON.stringify(segment.key)}]`;
      continue;
    }
    const rendered = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)
      ? segment
      : `[${JSON.stringify(segment)}]`;
    output += index === 0 ? rendered : `.${rendered}`;
  }
  return output;
}
