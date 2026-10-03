import {
  adaptTypeScriptAssignmentEventsToPortableAes,
  aeonRadixBaseFromDatatype,
  aeonRadixScale,
  type CompileResult,
} from '@altopelago/aeon-core';
import { parseAddress, type SansaResolveBinding, type SansaResolveNamespace } from '@altopelago/sansa';
import {
  indexEventsByPath,
  readAeon,
  type ReadAeonResult,
  type ReadAeonOptions,
} from './index.js';

export type AeonAssignmentEvent = CompileResult['events'][number];
type PortableAeonEvent = ReturnType<typeof adaptTypeScriptAssignmentEventsToPortableAes>['events'][number];

export type AeonNamespaceScope = 'payload' | 'header' | 'full';
export type AeonNumericMaterialization = 'lossless' | 'native';

export interface CreateAeonNamespaceOptions {
  /** Select the AEON document plane exposed at the SANSA root. Defaults to `payload`. */
  readonly scope?: AeonNamespaceScope;
  /** Materialize finite numbers as canonical strings or JavaScript numbers. Defaults to `lossless`. */
  readonly numericMaterialization?: AeonNumericMaterialization;
  /** Exact UTF-8 source artifact corresponding to `events`, used to derive portable origin and byte spans. */
  readonly sourceBytes?: Uint8Array;
}

export interface ReadAeonNamespaceOptions extends ReadAeonOptions {
  readonly namespace?: Omit<CreateAeonNamespaceOptions, 'sourceBytes'>;
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
  radixScale?: number;
  value?: unknown;
  children: AeonSansaBinding[];
  attributeSpace?: AeonSansaBinding;
  nodeTag?: string;
  sourcePlane?: 'header' | 'body';
  origin?: string;
  span?: string;
}

export type AeonSansaNamespace = SansaResolveNamespace<AeonSansaBinding> & {
  readonly root: AeonSansaBinding;
  readonly numericLexeme: (binding: AeonSansaBinding) => string | undefined;
  readonly radixBase: (binding: AeonSansaBinding) => number | undefined;
  readonly radixScale: (binding: AeonSansaBinding) => number | undefined;
};

export interface ReadAeonNamespaceResult extends ReadAeonResult {
  readonly eventsByPath: ReadonlyMap<string, AeonAssignmentEvent>;
  readonly namespace: AeonSansaNamespace;
}

/**
 * Adapt compiled AEON assignment events into a queryable SANSA namespace.
 *
 * Native assignment events are first projected into complete portable AES
 * topology. This keeps binding and NodeHead occurrences distinct, translates
 * reference targets through node-head levels, and exposes normative portable
 * representation kinds without losing finite-number precision.
 */
export function createAeonNamespace(
  events: readonly AeonAssignmentEvent[],
  options: CreateAeonNamespaceOptions = {},
): AeonSansaNamespace {
  const scope = options.scope ?? 'payload';
  const numericMaterialization = options.numericMaterialization ?? 'lossless';
  const root: AeonSansaBinding = {
    address: '$',
    representationKind: 'ObjectNode',
    children: [],
  };
  const byAddress = new Map<string, AeonSansaBinding>([['$', root]]);
  const parents = new Map<AeonSansaBinding, AeonSansaBinding | undefined>([[root, undefined]]);

  if (scope === 'full') {
    for (const sourcePlane of ['header', 'body'] as const) {
      const address = appendMember('$', sourcePlane);
      const planeRoot: AeonSansaBinding = {
        address,
        name: sourcePlane,
        sourcePlane,
        representationKind: 'ObjectNode',
        children: [],
      };
      root.children.push(planeRoot);
      byAddress.set(address, planeRoot);
      parents.set(planeRoot, root);
    }
  }

  const portableEvents = adaptTypeScriptAssignmentEventsToPortableAes(events, {
    includeHeaders: true,
    ...(options.sourceBytes !== undefined ? { sourceBytes: options.sourceBytes } : {}),
  }).events;
  for (const event of portableEvents) {
    const location = portableEventLocation(event);
    if (!planeIsInScope(location.sourcePlane, scope)) continue;
    const address = scope === 'full'
      ? addressInPlane(location.sourcePlane, location.path)
      : location.path;
    const existing = byAddress.get(address);
    if (existing) {
      throw new Error(`AEON events contain more than one binding at '${address}'.`);
    }

    const parsed = parseAddress(address);
    if (!parsed.ok || !parsed.address.isExact) {
      const message = parsed.ok
        ? `Portable AES path is not exact: ${address}`
        : parsed.errors[0]?.message ?? `Invalid portable AES path: ${address}`;
      throw new Error(message);
    }
    const selectors = parsed.address.selectors;
    const final = selectors[selectors.length - 1];
    if (final?.type !== 'member' && final?.type !== 'position') {
      throw new Error(`Portable AES event path must end in a member or index: ${address}`);
    }

    let currentAddress = '$';
    let parent = root;
    for (const selector of selectors.slice(0, -1)) {
      if (selector.type === 'attributeSpace') {
        const spaceAddress = `${currentAddress}.@`;
        let space = byAddress.get(spaceAddress);
        if (!space) {
          space = {
            address: spaceAddress,
            representationKind: 'attributeSpace',
            children: [],
          };
          byAddress.set(spaceAddress, space);
          parents.set(space, parent);
          parent.attributeSpace = space;
        }
        currentAddress = spaceAddress;
        parent = space;
        continue;
      }
      if (selector.type !== 'member' && selector.type !== 'position') {
        throw new Error(`Portable AES event path contains a non-structural selector: ${address}`);
      }
      currentAddress = selector.type === 'member'
        ? appendMember(currentAddress, selector.name)
        : `${currentAddress}[${selector.index}]`;
      const nextParent = byAddress.get(currentAddress);
      if (!nextParent) {
        throw new Error(`AEON event '${address}' has no parent binding '${currentAddress}' in the selected '${scope}' scope.`);
      }
      parent = nextParent;
    }

    const binding = bindingFromPortableEvent(
      event,
      address,
      location.sourcePlane,
      final.type === 'member' ? { name: final.name } : { index: final.index },
      numericMaterialization,
      scope,
    );
    byAddress.set(address, binding);
    parents.set(binding, parent);
    parent.children.push(binding);
    if (binding.representationKind === 'NodeHead' && parent.representationKind === 'NodeLiteral') {
      if (binding.nodeTag !== undefined) parent.nodeTag = binding.nodeTag;
    }
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
    radixScale: (binding) => binding.radixScale,
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
    namespace: createAeonNamespace(result.compile.events, {
      ...namespaceOptions,
      sourceBytes: new TextEncoder().encode(input),
    }),
  };
}

function addressInPlane(sourcePlane: 'header' | 'body', address: string): string {
  const planeRoot = appendMember('$', sourcePlane);
  return address === '$' ? planeRoot : `${planeRoot}${address.slice(1)}`;
}

function portableEventLocation(event: PortableAeonEvent): {
  readonly path: string;
  readonly sourcePlane: 'header' | 'body';
} {
  if ('header' in event && typeof event.header === 'string') {
    return { path: event.header, sourcePlane: 'header' };
  }
  if ('path' in event && typeof event.path === 'string') {
    return { path: event.path, sourcePlane: 'body' };
  }
  throw new Error('Portable AES event is missing both path and header location.');
}

function planeIsInScope(sourcePlane: 'header' | 'body', scope: AeonNamespaceScope): boolean {
  return scope === 'full'
    || (scope === 'header' ? sourcePlane === 'header' : sourcePlane === 'body');
}

function bindingFromPortableEvent(
  event: PortableAeonEvent,
  address: string,
  sourcePlane: 'header' | 'body',
  segment: { readonly name: string } | { readonly index: number },
  numericMaterialization: AeonNumericMaterialization,
  scope: AeonNamespaceScope,
): AeonSansaBinding {
  const semanticType = event.datatype ?? portableSemanticType(event.kind);
  const binding: AeonSansaBinding = {
    address,
    children: [],
    representationKind: event.kind,
    sourcePlane,
    ...('name' in segment ? { name: segment.name } : { index: segment.index }),
    ...(event.identity !== undefined ? { identity: event.identity } : {}),
    ...(semanticType !== undefined ? { semanticType } : {}),
    ...(event.datatype !== undefined ? { datatype: event.datatype } : {}),
    ...(event.generics !== undefined ? { generics: event.generics } : {}),
    ...(event.clarifiers !== undefined ? { clarifiers: event.clarifiers } : {}),
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
    ...(event.span !== undefined ? { span: event.span } : {}),
  };

  const scalarKind = portableScalarKind(event.kind);
  if (scalarKind !== undefined) binding.scalarKind = scalarKind;
  if (event.kind === 'NullLiteral' && event.value !== undefined) binding.nullReason = event.value;
  if (event.kind === 'NumberLiteral' && event.value !== undefined) binding.numericLexeme = event.value;
  const radixBase = radixBaseFromPortableEvent(event);
  if (radixBase !== undefined) binding.radixBase = radixBase;
  if (event.kind === 'RadixLiteral' && event.value !== undefined) {
    const radixScale = aeonRadixScale(event.value, radixBase);
    if (radixScale !== null) binding.radixScale = radixScale;
  }
  const scalar = scalarFromPortableEvent(event, numericMaterialization, sourcePlane, scope);
  if (scalar.ok) binding.value = scalar.value;
  if (event.kind === 'NodeHead' && event.value !== undefined) binding.nodeTag = event.value;

  return binding;
}

function scalarFromPortableEvent(
  event: PortableAeonEvent,
  numericMaterialization: AeonNumericMaterialization,
  sourcePlane: 'header' | 'body',
  scope: AeonNamespaceScope,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  switch (event.kind) {
    case 'StringLiteral':
    case 'DateLiteral':
    case 'DateTimeLiteral':
    case 'TimeLiteral':
    case 'WTCDateTimeLiteral':
    case 'HexLiteral':
    case 'RadixLiteral':
    case 'EncodingLiteral':
    case 'SeparatorLiteral':
    case 'SymbolicLiteral':
    case 'ToggleLiteral':
    case 'NodeHead':
      return { ok: true, value: event.value ?? '' };
    case 'NumberLiteral':
      return {
        ok: true,
        value: numericMaterialization === 'native' ? Number(event.value ?? '') : event.value ?? '',
      };
    case 'InfinityLiteral':
      return { ok: true, value: event.value === '-Infinity' ? -Infinity : Infinity };
    case 'NaNLiteral':
      return { ok: true, value: Number.NaN };
    case 'BooleanLiteral':
      return { ok: true, value: event.value === 'true' };
    case 'NullLiteral':
      return { ok: true, value: null };
    case 'SansaAddressLiteral':
      return {
        ok: true,
        value: {
          type: 'SansaAddressLiteral',
          address: event.value ?? '',
          canonical: event.value ?? '',
        },
      };
    case 'CloneReference':
    case 'PointerReference': {
      const referencePath = scope === 'full'
        ? addressInPlane(sourcePlane, event.value ?? '')
        : event.value ?? '';
      return {
        ok: true,
        value: {
          type: event.kind,
          path: referencePath,
          canonical: `${event.kind === 'PointerReference' ? '~>' : '~'}${referencePath}`,
        },
      };
    }
    case 'ObjectNode':
    case 'ListNode':
    case 'TupleLiteral':
    case 'NodeLiteral':
      return { ok: false };
  }
}

function portableSemanticType(kind: PortableAeonEvent['kind']): string | undefined {
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
    case 'SeparatorLiteral': return 'sep';
    case 'SymbolicLiteral': return 'symbol';
    case 'SansaAddressLiteral': return 'sansa';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return 'time';
    case 'DateTimeLiteral': return 'datetime';
    case 'WTCDateTimeLiteral': return 'wtc';
    case 'ObjectNode':
    case 'ListNode':
    case 'TupleLiteral':
    case 'NodeLiteral':
    case 'NodeHead':
    case 'CloneReference':
    case 'PointerReference':
      return undefined;
  }
}

function portableScalarKind(kind: PortableAeonEvent['kind']): string | undefined {
  switch (kind) {
    case 'NumberLiteral': return 'number';
    case 'NullLiteral': return 'null';
    case 'InfinityLiteral': return 'infinity';
    case 'NaNLiteral': return 'nan';
    case 'ToggleLiteral': return 'toggle';
    case 'HexLiteral': return 'hex';
    case 'RadixLiteral': return 'radix';
    case 'EncodingLiteral': return 'encoding';
    case 'SeparatorLiteral': return 'separator';
    case 'SymbolicLiteral': return 'symbol';
    case 'SansaAddressLiteral': return 'sansaAddress';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return 'time';
    case 'DateTimeLiteral': return 'datetime';
    case 'WTCDateTimeLiteral': return 'wtc';
    case 'CloneReference':
    case 'PointerReference':
      return 'referenceForm';
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'ObjectNode':
    case 'ListNode':
    case 'TupleLiteral':
    case 'NodeLiteral':
    case 'NodeHead':
      return undefined;
  }
}

function radixBaseFromPortableEvent(event: PortableAeonEvent): number | undefined {
  if (event.kind !== 'RadixLiteral') return undefined;
  const fromDatatype = aeonRadixBaseFromDatatype(event.datatype);
  if (fromDatatype !== undefined) return fromDatatype;
  if (event.datatype !== 'radix' || event.clarifiers?.length !== 1) return undefined;
  const clarifier = event.clarifiers[0];
  if (!isTaggedNumberLiteral(clarifier)) return undefined;
  const base = Number(clarifier.value);
  return Number.isInteger(base) && base >= 2 && base <= 64 ? base : undefined;
}

function isTaggedNumberLiteral(value: unknown): value is { readonly kind: 'NumberLiteral'; readonly value: string } {
  return typeof value === 'object'
    && value !== null
    && 'kind' in value
    && value.kind === 'NumberLiteral'
    && 'value' in value
    && typeof value.value === 'string';
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
    case 'SymbolicLiteral': return 'symbol';
    case 'SansaAddressLiteral': return 'sansa';
    case 'DateLiteral': return 'date';
    case 'TimeLiteral': return 'time';
    case 'DateTimeLiteral': return 'datetime';
    case 'ObjectNode': return 'object';
    case 'ListNode': return 'list';
    case 'TupleLiteral': return 'tuple';
    case 'NodeLiteral': return 'node';
    case 'NodeHead': return 'nodeHead';
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
