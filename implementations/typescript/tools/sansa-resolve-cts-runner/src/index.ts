#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAddress, type SansaResolveBinding, type SansaResolveNamespace } from '@altopelago/sansa';

interface CtsManifest {
    readonly suites?: readonly SuiteRef[];
}

interface SuiteRef {
    readonly id?: string;
    readonly file?: string;
}

interface ResolveSuite {
    readonly title?: string;
    readonly fixtures?: {
        readonly namespaces?: readonly NamespaceFixture[];
    };
    readonly tests?: readonly ResolveTest[];
}

interface NamespaceFixture {
    readonly id: string;
    readonly root: ResolveBinding;
}

interface ResolveBinding extends SansaResolveBinding {
    readonly children?: readonly ResolveBinding[];
    readonly attributeSpace?: ResolveBinding;
    readonly attributes?: ResolveBinding;
    readonly localSpaces?: Readonly<Record<string, ResolveBinding>>;
}

interface ResolveTest {
    readonly id: string;
    readonly input?: {
        readonly namespace?: string;
        readonly contextualRoot?: string;
        readonly source?: string;
    };
    readonly expected?: {
        readonly ok?: boolean;
        readonly addresses?: readonly string[];
        readonly error?: string;
        readonly selectorIndex?: number;
    };
}

interface BuiltNamespace {
    readonly namespace: SansaResolveNamespace<ResolveBinding>;
    readonly byAddress: ReadonlyMap<string, ResolveBinding>;
}

let pass = 0;
let fail = 0;

async function main(): Promise<void> {
    const manifestPath = resolveCtsPath(readArg('--cts'));
    const manifest = readJson<CtsManifest>(manifestPath);

    console.log('Running SANSA Resolve CTS against TypeScript @altopelago/sansa');

    for (const suiteRef of manifest.suites ?? []) {
        if (!suiteRef.file) {
            fail += 1;
            console.error(`FAIL ${suiteRef.id ?? '<unknown suite>'}: missing suite file`);
            continue;
        }

        const suitePath = resolve(dirname(manifestPath), suiteRef.file);
        const suite = readJson<ResolveSuite>(suitePath);
        const namespaces = buildNamespaces(suite.fixtures?.namespaces ?? []);

        console.log(`\n--- Suite: ${suite.title ?? suiteRef.id ?? suiteRef.file} ---`);

        for (const test of suite.tests ?? []) {
            const failures = runTest(test, namespaces);
            if (failures.length > 0) {
                fail += 1;
                console.error(`FAIL ${test.id}`);
                for (const failure of failures) console.error(`  - ${failure}`);
            } else {
                pass += 1;
                console.log(`PASS ${test.id}`);
            }
        }
    }

    console.log(`\nSummary: pass=${pass} fail=${fail}`);
    process.exit(fail > 0 ? 1 : 0);
}

function runTest(test: ResolveTest, namespaces: ReadonlyMap<string, BuiltNamespace>): string[] {
    const failures: string[] = [];
    const expected = test.expected ?? {};
    const input = test.input ?? {};
    const fixture = typeof input.namespace === 'string' ? namespaces.get(input.namespace) : undefined;

    if (!fixture) {
        failures.push(`unknown namespace fixture: ${input.namespace ?? null}`);
        return failures;
    }

    if (typeof input.source !== 'string') {
        failures.push('missing input.source');
        return failures;
    }

    const options: { contextualRoot?: ResolveBinding } = {};
    if (typeof input.contextualRoot === 'string') {
        const contextualRoot = fixture.byAddress.get(input.contextualRoot);
        if (!contextualRoot) {
            failures.push(`unknown contextualRoot binding: ${input.contextualRoot}`);
            return failures;
        }
        options.contextualRoot = contextualRoot;
    }

    const result = resolveAddress(input.source, fixture.namespace, options);
    const expectedOk = expected.ok === true;

    if (result.ok !== expectedOk) {
        failures.push(`ok mismatch: expected ${expectedOk}, got ${result.ok}`);
    }

    if (!result.ok) {
        if (typeof expected.error === 'string') {
            const actualCode = result.errors[0]?.code ?? null;
            if (actualCode !== expected.error) {
                failures.push(`error mismatch: expected ${expected.error}, got ${actualCode}`);
            }
        }
        if (Number.isInteger(expected.selectorIndex)) {
            const actualSelectorIndex = result.errors[0]?.selectorIndex;
            if (actualSelectorIndex !== expected.selectorIndex) {
                failures.push(`selectorIndex mismatch: expected ${expected.selectorIndex}, got ${actualSelectorIndex ?? null}`);
            }
        }
        return failures;
    }

    if (Array.isArray(expected.addresses)) {
        compareArray(expected.addresses, result.bindings.map((binding) => binding.address ?? null), 'addresses', failures);
    }

    return failures;
}

function buildNamespaces(entries: readonly NamespaceFixture[]): ReadonlyMap<string, BuiltNamespace> {
    const output = new Map<string, BuiltNamespace>();

    for (const entry of entries) {
        const byAddress = new Map<string, ResolveBinding>();
        indexBindingTree(entry.root, byAddress);
        output.set(entry.id, {
            byAddress,
            namespace: {
                root: entry.root,
                children: (binding) => binding.children ?? [],
                attributeSpace: (binding) => binding.attributeSpace,
            },
        });
    }

    return output;
}

function indexBindingTree(binding: ResolveBinding, output: Map<string, ResolveBinding>): void {
    if (typeof binding.address === 'string') output.set(binding.address, binding);
    for (const child of binding.children ?? []) indexBindingTree(child, output);
    if (binding.attributeSpace) indexBindingTree(binding.attributeSpace, output);
    if (binding.attributes) indexBindingTree(binding.attributes, output);
    for (const localSpace of Object.values(binding.localSpaces ?? {})) indexBindingTree(localSpace, output);
}

function compareArray(
    expected: readonly string[],
    actual: readonly (string | null)[],
    label: string,
    failures: string[],
): void {
    if (expected.length !== actual.length) {
        failures.push(`${label} length mismatch: expected ${expected.length}, got ${actual.length}`);
        return;
    }
    for (let index = 0; index < expected.length; index += 1) {
        if (expected[index] !== actual[index]) {
            failures.push(`${label}[${index}] mismatch: expected ${JSON.stringify(expected[index])}, got ${JSON.stringify(actual[index])}`);
        }
    }
}

function resolveCtsPath(candidate: string | undefined): string {
    if (candidate) return resolve(process.cwd(), candidate);

    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', '..', '..', '..', '..', '..', 'aeonite-org', 'aeonite-cts', 'cts', 'sansa', 'v1', 'sansa-resolve-cts.v1.json');
}

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    return process.argv[index + 1];
}

function readJson<T>(file: string): T {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
}

main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(3);
});
