import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPortableEventPathMap, projectPortableEvents } from '@altopelago/aeon-core';
import { readAeon } from './index.js';
import {
  readAeonNamespace,
  type AeonNamespaceScope,
  type AeonSansaBinding,
  type AeonSansaNamespace,
} from './sansa.js';

type CapabilityState = 'complete' | 'partial' | 'not-supplied' | 'not-collected' | 'not-applicable';

interface ContractCapability {
  readonly id: string;
  readonly description: string;
}

interface ContractFixture {
  readonly id: string;
  readonly source: string;
  readonly compileOptions: {
    readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
    readonly maxAttributeDepth?: number;
  };
  readonly scopes: Readonly<Partial<Record<AeonNamespaceScope, readonly unknown[]>>>;
}

interface PortableTopologyCase {
  readonly id: string;
  readonly source: string;
  readonly sourceToEventPaths: Readonly<Record<string, string>>;
  readonly events: readonly {
    readonly path: string;
    readonly kind: string;
    readonly identity?: string;
    readonly datatype?: string;
    readonly value?: string;
  }[];
}

interface CapabilityScenario {
  readonly id: string;
  readonly inputRoute: string;
  readonly states: Readonly<Record<string, CapabilityState>>;
}

interface DocumentProjectionContract {
  readonly id: string;
  readonly addressDomains: Readonly<Record<string, string>>;
  readonly documentGraphAddressContract: {
    readonly required: string;
    readonly conditional: readonly string[];
    readonly sansaEventBackedDefault: string;
  };
  readonly legacyNamespaceSnapshotAddressDomain: string;
  readonly fidelityDimensions: readonly string[];
  readonly capabilityStates: readonly CapabilityState[];
  readonly capabilities: readonly ContractCapability[];
  readonly capabilityScenarios: readonly CapabilityScenario[];
  readonly documentGraphRequiredFields: readonly string[];
  readonly legacyNamespaceProjectionFields: readonly string[];
  readonly portableTopologyCases: readonly PortableTopologyCase[];
  readonly fixtures: readonly ContractFixture[];
}

const CONTRACT_PATH = fileURLToPath(new URL(
  '../../../../../test-fixtures/document-projection/aeon-document-projection.v1.json',
  import.meta.url,
));

const EXPECTED_CAPABILITY_STATES = [
  'complete',
  'partial',
  'not-supplied',
  'not-collected',
  'not-applicable',
] as const;

const EXPECTED_CAPABILITIES = [
  'source.bytes',
  'source.authored-lexemes',
  'provenance.origin',
  'provenance.span',
  'aes.portable-extensions',
  'telex.unknown-fields',
  'aes.event-order',
  'lineage.events',
] as const;

const EXPECTED_DOCUMENT_GRAPH_FIELDS = [
  'nodeId',
  'address',
  'sourceAddress',
  'eventAddress',
  'parentNodeId',
  'childNodeIds',
  'bindingName',
  'position',
  'sourcePlane',
  'representationKind',
  'valueKind',
  'datatype',
  'identity',
  'decodedValue',
  'canonicalLexeme',
  'authoredLexeme',
  'nullReason',
  'reference',
  'attributeSpaceNodeId',
  'origin',
  'span',
  'portableExtensions',
  'transportSidecar',
  'lineage',
] as const;

const EXPECTED_LEGACY_PROJECTION_FIELDS = [
  'address',
  'parent',
  'name',
  'index',
  'identity',
  'semanticType',
  'representationKind',
  'scalarKind',
  'nullReason',
  'numericLexeme',
  'radixBase',
  'radixScale',
  'value',
  'nodeTag',
  'sourcePlane',
  'children',
  'attributeSpace',
] as const;

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as DocumentProjectionContract;

test('document-projection contract declares independent fidelity capabilities', () => {
  assert.equal(contract.id, 'aeon.document-projection.v1');
  assert.deepEqual(Object.keys(contract.addressDomains), ['namespace', 'aeon-source', 'aes-event']);
  assert.deepEqual(contract.documentGraphAddressContract, {
    required: 'namespace',
    conditional: ['aeon-source', 'aes-event'],
    sansaEventBackedDefault: 'aes-event',
  });
  assert.equal(contract.legacyNamespaceSnapshotAddressDomain, 'aeon-source');
  assert.deepEqual(contract.fidelityDimensions, [
    'telex-event',
    'profile-relative-semantic',
    'exact-source',
  ]);
  assert.deepEqual(contract.capabilityStates, EXPECTED_CAPABILITY_STATES);
  assert.deepEqual(contract.capabilities.map(({ id }) => id), EXPECTED_CAPABILITIES);
  assert.deepEqual(contract.documentGraphRequiredFields, EXPECTED_DOCUMENT_GRAPH_FIELDS);
  assert.deepEqual(contract.legacyNamespaceProjectionFields, EXPECTED_LEGACY_PROJECTION_FIELDS);

  assert.equal(new Set(contract.capabilityStates).size, contract.capabilityStates.length);
  assert.equal(new Set(contract.capabilities.map(({ id }) => id)).size, contract.capabilities.length);
  assert.equal(new Set(contract.documentGraphRequiredFields).size, contract.documentGraphRequiredFields.length);
  assert.equal(
    new Set(contract.legacyNamespaceProjectionFields).size,
    contract.legacyNamespaceProjectionFields.length,
  );
  for (const capability of contract.capabilities) assert.notEqual(capability.description.trim(), '');

  const capabilityIds = new Set(contract.capabilities.map(({ id }) => id));
  const capabilityStates = new Set<string>(contract.capabilityStates);
  for (const scenario of contract.capabilityScenarios) {
    assert.notEqual(scenario.id.trim(), '');
    assert.notEqual(scenario.inputRoute.trim(), '');
    assert.deepEqual(Object.keys(scenario.states), EXPECTED_CAPABILITIES);
    for (const [capability, state] of Object.entries(scenario.states)) {
      assert.equal(capabilityIds.has(capability), true, `Unknown capability '${capability}'`);
      assert.equal(capabilityStates.has(state), true, `Unknown capability state '${state}'`);
    }
  }
});

for (const fixture of contract.portableTopologyCases) {
  test(`document-projection portable topology: ${fixture.id}`, () => {
    const { compile } = readAeon(fixture.source);
    assert.deepEqual(compile.errors, []);
    assert.deepEqual(Object.fromEntries(createPortableEventPathMap(compile.events)), fixture.sourceToEventPaths);
    assert.deepEqual(
      projectPortableEvents(compile.events).map(({ path, kind, identity, datatype, value }) => ({
        path,
        kind,
        ...(identity !== undefined ? { identity } : {}),
        ...(datatype !== undefined ? { datatype } : {}),
        ...(value !== undefined ? { value } : {}),
      })),
      fixture.events,
    );
  });
}

for (const fixture of contract.fixtures) {
  for (const [scope, expected] of Object.entries(fixture.scopes)) {
    test(`document-projection contract: ${fixture.id} (${scope})`, () => {
      const { namespace } = readAeonNamespace(fixture.source, {
        compile: fixture.compileOptions,
        namespace: { scope: scope as AeonNamespaceScope },
      });
      assert.deepEqual(snapshotNamespace(namespace), expected);
    });
  }
}

function snapshotNamespace(namespace: AeonSansaNamespace): readonly unknown[] {
  const output: unknown[] = [];

  function visit(binding: AeonSansaBinding, parent?: string): void {
    output.push({
      address: binding.address,
      ...(parent !== undefined ? { parent } : {}),
      ...(binding.name !== undefined ? { name: binding.name } : {}),
      ...(binding.index !== undefined ? { index: binding.index } : {}),
      ...(binding.identity !== undefined ? { identity: binding.identity } : {}),
      ...(binding.semanticType !== undefined ? { semanticType: binding.semanticType } : {}),
      ...(binding.representationKind !== undefined ? { representationKind: binding.representationKind } : {}),
      ...(binding.scalarKind !== undefined ? { scalarKind: binding.scalarKind } : {}),
      ...(binding.nullReason !== undefined ? { nullReason: binding.nullReason } : {}),
      ...(binding.numericLexeme !== undefined ? { numericLexeme: binding.numericLexeme } : {}),
      ...(binding.radixBase !== undefined ? { radixBase: binding.radixBase } : {}),
      ...(binding.radixScale !== undefined ? { radixScale: binding.radixScale } : {}),
      ...(binding.value !== undefined ? { value: jsonSafeValue(binding.value) } : {}),
      ...(binding.nodeTag !== undefined ? { nodeTag: binding.nodeTag } : {}),
      ...(binding.sourcePlane !== undefined ? { sourcePlane: binding.sourcePlane } : {}),
      children: binding.children.map(({ address }) => address),
      ...(binding.attributeSpace !== undefined ? { attributeSpace: binding.attributeSpace.address } : {}),
    });

    for (const child of binding.children) visit(child, binding.address);
    if (binding.attributeSpace !== undefined) visit(binding.attributeSpace, binding.address);
  }

  visit(namespace.root);
  return output;
}

function jsonSafeValue(value: unknown): unknown {
  if (typeof value !== 'number' || Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return { $nonFinite: 'nan' };
  return { $nonFinite: value > 0 ? 'positive-infinity' : 'negative-infinity' };
}
