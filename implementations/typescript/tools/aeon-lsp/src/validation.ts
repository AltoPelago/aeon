import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { compile as compileCore, type AEONError } from '@aeon/core';
import { finalizeJson } from '@aeon/finalize';
import { compile as compileProfile, createDefaultRegistry, type Diagnostic as ProfileDiagnostic } from '@aeon/profiles';
import { validate, type Diag as SchemaDiagnostic, type SchemaV1 } from '@aeos/core';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node.js';

export interface ValidationConfig {
    readonly enabled?: boolean;
    readonly contractRegistry?: string | null;
    readonly profile?: string | null;
    readonly schema?: string | null;
}

type ContractKind = 'profile' | 'schema';

type ContractRegistryEntry = {
    id: string;
    kind: ContractKind;
    version: string;
    path: string;
    sha256: string;
    status: 'active' | 'deprecated';
};

type ContractRegistryDoc = {
    contracts: ContractRegistryEntry[];
};

export function getConfiguredDiagnostics(text: string, documentPath: string | null, config: ValidationConfig): Diagnostic[] {
    if (config.enabled === false) return [];

    const diagnostics: Diagnostic[] = [];
    const resolved = resolveValidationInputs(documentPath, config, diagnostics);
    if (!resolved) return diagnostics;

    const compileResult = compileProfile(text, {
        profile: resolved.profile ?? 'altopelago.core.v1',
        registry: createDefaultRegistry(),
        mode: 'strict',
        datatypePolicy: 'reserved_only',
        maxAttributeDepth: 1,
        maxSeparatorDepth: 8,
    });

    appendProfileDiagnostics(diagnostics, compileResult.meta?.errors);
    appendProfileDiagnostics(diagnostics, compileResult.meta?.warnings);

    if ((compileResult.meta?.errors?.length ?? 0) > 0) {
        return diagnostics;
    }

    if (!resolved.schema) {
        return diagnostics;
    }

    const schemaResult = validate(compileResult.aes, resolved.schema);
    for (const error of schemaResult.errors) {
        diagnostics.push(fromSchemaDiagnostic(error, text, DiagnosticSeverity.Error));
    }
    for (const warning of schemaResult.warnings) {
        diagnostics.push(fromSchemaDiagnostic(warning, text, DiagnosticSeverity.Warning));
    }
    return diagnostics;
}

function resolveValidationInputs(
    documentPath: string | null,
    config: ValidationConfig,
    diagnostics: Diagnostic[],
): { profile: string | null; schema: SchemaV1 | null } | null {
    const baseDir = documentPath ? path.dirname(documentPath) : process.cwd();
    const headerInfo = extractHeaderInfo(documentPath ? safeRead(documentPath) : null);
    const registryPath = config.contractRegistry
        ? resolvePath(baseDir, config.contractRegistry)
        : null;
    const registry = registryPath ? readContractRegistry(registryPath, diagnostics) : null;
    if (registryPath && !registry) {
        return null;
    }

    const profileId = config.profile ?? headerInfo.profile;
    if (registry && profileId) {
        const entry = resolveContractEntry(registry, profileId, 'profile');
        if (!entry) {
            diagnostics.push(simpleDiagnostic(`Unknown profile contract id in registry: ${profileId}`, 'CONTRACT_UNKNOWN_PROFILE_ID'));
            return null;
        }
        const verified = verifyContractArtifact(entry, registryPath!, diagnostics);
        if (!verified) return null;
    }

    const schemaSetting = config.schema ?? headerInfo.schema;
    if (!schemaSetting) {
        return { profile: profileId, schema: null };
    }

    if (looksLikeFilePath(schemaSetting)) {
        const schemaPath = resolvePath(baseDir, schemaSetting);
        const schema = readSchemaAny(schemaPath, diagnostics);
        if (!schema) return null;
        return { profile: profileId, schema };
    }

    if (!registry) {
        diagnostics.push(simpleDiagnostic(
            `Schema '${schemaSetting}' requires aeon.validation.contractRegistry`,
            'CONTRACT_REGISTRY_REQUIRED',
        ));
        return null;
    }

    const entry = resolveContractEntry(registry, schemaSetting, 'schema');
    if (!entry) {
        diagnostics.push(simpleDiagnostic(`Unknown schema contract id in registry: ${schemaSetting}`, 'CONTRACT_UNKNOWN_SCHEMA_ID'));
        return null;
    }
    const verified = verifyContractArtifact(entry, registryPath!, diagnostics);
    if (!verified) return null;
    const schema = readSchemaAny(verified, diagnostics, entry.id);
    if (!schema) return null;
    return { profile: profileId, schema };
}

function appendProfileDiagnostics(target: Diagnostic[], source: readonly ProfileDiagnostic[] | undefined): void {
    if (!source) return;
    for (const diag of source) {
        target.push({
            severity: diag.level === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
            message: diag.message,
            source: 'aeon-lsp',
            ...(diag.code ? { code: diag.code } : {}),
            range: spanToRange((diag as { span?: unknown }).span),
        });
    }
}

function fromSchemaDiagnostic(diag: SchemaDiagnostic, text: string, severity: DiagnosticSeverity): Diagnostic {
    const range = offsetTupleToRange(diag.span, text);
    return {
        severity,
        message: diag.message,
        source: 'aeon-lsp',
        code: diag.code,
        range,
    };
}

function simpleDiagnostic(message: string, code: string): Diagnostic {
    return {
        severity: DiagnosticSeverity.Error,
        message,
        source: 'aeon-lsp',
        code,
        range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
        },
    };
}

function spanToRange(span: unknown): Diagnostic['range'] {
    const s = span as { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } } | undefined;
    return {
        start: {
            line: Math.max(0, (s?.start?.line ?? 1) - 1),
            character: Math.max(0, (s?.start?.column ?? 1) - 1),
        },
        end: {
            line: Math.max(0, (s?.end?.line ?? 1) - 1),
            character: Math.max(0, (s?.end?.column ?? 2) - 1),
        },
    };
}

function offsetTupleToRange(span: [number, number] | null, text: string): Diagnostic['range'] {
    if (!span) {
        return {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
        };
    }
    return {
        start: offsetToPosition(text, span[0]),
        end: offsetToPosition(text, span[1]),
    };
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
    let line = 0;
    let character = 0;
    for (let i = 0; i < Math.min(offset, text.length); i++) {
        if (text[i] === '\n') {
            line += 1;
            character = 0;
        } else {
            character += 1;
        }
    }
    return { line, character };
}

function resolvePath(baseDir: string, candidate: string): string {
    return path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
}

function looksLikeFilePath(value: string): boolean {
    return value.includes('/') || value.includes(path.sep) || /\.(json|aeon)$/i.test(value);
}

function readContractRegistry(file: string, diagnostics: Diagnostic[]): ContractRegistryDoc | null {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        diagnostics.push(simpleDiagnostic(`Contract registry file is not valid JSON: ${file}`, 'CONTRACT_REGISTRY_INVALID'));
        return null;
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { contracts?: unknown }).contracts)) {
        diagnostics.push(simpleDiagnostic(`Contract registry JSON must contain a top-level 'contracts' array: ${file}`, 'CONTRACT_REGISTRY_INVALID'));
        return null;
    }
    return raw as ContractRegistryDoc;
}

function resolveContractEntry(registry: ContractRegistryDoc, id: string, kind: ContractKind): ContractRegistryEntry | null {
    const entry = registry.contracts.find((contract) => contract.id === id && contract.kind === kind);
    if (!entry || entry.status !== 'active') return null;
    return entry;
}

function verifyContractArtifact(entry: ContractRegistryEntry, registryPath: string, diagnostics: Diagnostic[]): string | null {
    const resolvedPath = path.resolve(path.dirname(registryPath), entry.path);
    let fileBuffer: Buffer;
    try {
        fileBuffer = fs.readFileSync(resolvedPath);
    } catch {
        diagnostics.push(simpleDiagnostic(`Missing contract artifact for '${entry.id}' at ${resolvedPath}`, 'CONTRACT_ARTIFACT_MISSING'));
        return null;
    }
    const actual = createHash('sha256').update(fileBuffer).digest('hex');
    if (actual !== entry.sha256.toLowerCase()) {
        diagnostics.push(simpleDiagnostic(`Contract artifact hash mismatch for '${entry.id}' at ${resolvedPath}`, 'CONTRACT_ARTIFACT_HASH_MISMATCH'));
        return null;
    }
    return resolvedPath;
}

function readSchemaAny(file: string, diagnostics: Diagnostic[], expectedSchemaId?: string): SchemaV1 | null {
    if (file.toLowerCase().endsWith('.aeon')) {
        return readSchemaAeon(file, diagnostics, expectedSchemaId);
    }
    return readSchemaJson(file, diagnostics, expectedSchemaId);
}

function readSchemaJson(file: string, diagnostics: Diagnostic[], expectedSchemaId?: string): SchemaV1 | null {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        diagnostics.push(simpleDiagnostic(`Schema file is not valid JSON: ${file}`, 'SCHEMA_INVALID_JSON'));
        return null;
    }
    return normalizeSchemaContractDoc(raw as Record<string, unknown>, file, diagnostics, expectedSchemaId);
}

function readSchemaAeon(file: string, diagnostics: Diagnostic[], expectedSchemaId?: string): SchemaV1 | null {
    const source = fs.readFileSync(file, 'utf-8');
    const compiled = compileCore(source, { datatypePolicy: 'allow_custom' });
    if (compiled.errors.length > 0) {
        for (const error of compiled.errors) {
            diagnostics.push(fromCoreError(error));
        }
        return null;
    }
    const finalized = finalizeJson(compiled.events, { mode: 'strict' });
    if ((finalized.meta?.errors?.length ?? 0) > 0) {
        for (const error of finalized.meta?.errors ?? []) {
            diagnostics.push(simpleDiagnostic(error.message, error.code ?? 'SCHEMA_FINALIZE_ERROR'));
        }
        return null;
    }
    return normalizeSchemaContractDoc(finalized.document as Record<string, unknown>, file, diagnostics, expectedSchemaId);
}

function normalizeSchemaContractDoc(
    doc: Record<string, unknown>,
    file: string,
    diagnostics: Diagnostic[],
    expectedSchemaId?: string,
): SchemaV1 | null {
    const schemaId = doc['schema_id'];
    const schemaVersion = doc['schema_version'];
    const rulesRaw = doc['rules'];
    const world = doc['world'];
    const datatypeAllowlist = doc['datatype_allowlist'];
    const datatypeRules = doc['datatype_rules'];
    const allowedTopLevel = new Set(['schema_id', 'schema_version', 'rules', 'world', 'datatype_allowlist', 'datatype_rules']);

    for (const key of Object.keys(doc)) {
        if (!allowedTopLevel.has(key)) {
            diagnostics.push(simpleDiagnostic(`Unknown schema contract key '${key}' in ${file}`, 'SCHEMA_UNKNOWN_KEY'));
            return null;
        }
    }

    if (typeof schemaId !== 'string' || schemaId.length === 0) {
        diagnostics.push(simpleDiagnostic(`Schema contract missing required string field 'schema_id': ${file}`, 'SCHEMA_ID_MISSING'));
        return null;
    }
    if (expectedSchemaId && schemaId !== expectedSchemaId) {
        diagnostics.push(simpleDiagnostic(`Schema contract id mismatch. Expected '${expectedSchemaId}', found '${schemaId}' in ${file}`, 'SCHEMA_ID_MISMATCH'));
        return null;
    }
    if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) {
        diagnostics.push(simpleDiagnostic(`Schema contract missing required string field 'schema_version': ${file}`, 'SCHEMA_VERSION_MISSING'));
        return null;
    }
    if (!Array.isArray(rulesRaw)) {
        diagnostics.push(simpleDiagnostic(`Schema contract missing required array field 'rules': ${file}`, 'SCHEMA_RULES_MISSING'));
        return null;
    }
    if (world !== undefined && world !== 'open' && world !== 'closed') {
        diagnostics.push(simpleDiagnostic(`Schema contract field 'world' must be 'open' or 'closed': ${file}`, 'SCHEMA_WORLD_INVALID'));
        return null;
    }
    if (datatypeAllowlist !== undefined) {
        if (!Array.isArray(datatypeAllowlist) || datatypeAllowlist.some((v) => typeof v !== 'string')) {
            diagnostics.push(simpleDiagnostic(`Schema contract field 'datatype_allowlist' must be array<string>: ${file}`, 'SCHEMA_DATATYPE_ALLOWLIST_INVALID'));
            return null;
        }
    }
    if (datatypeRules !== undefined) {
        if (!datatypeRules || typeof datatypeRules !== 'object' || Array.isArray(datatypeRules)) {
            diagnostics.push(simpleDiagnostic(`Schema contract field 'datatype_rules' must be object<string, constraints>: ${file}`, 'SCHEMA_DATATYPE_RULES_INVALID'));
            return null;
        }
        for (const [key, value] of Object.entries(datatypeRules as Record<string, unknown>)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                diagnostics.push(simpleDiagnostic(`Schema datatype rule '${key}' must be an object of constraints: ${file}`, 'SCHEMA_DATATYPE_RULES_INVALID'));
                return null;
            }
        }
    }

    const rules = rulesRaw.map((rule, index) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            diagnostics.push(simpleDiagnostic(`Schema contract rule at index ${index} is not an object: ${file}`, 'SCHEMA_RULE_INVALID'));
            return null;
        }
        const ruleObj = rule as Record<string, unknown>;
        if (typeof ruleObj.path !== 'string' || !ruleObj.path) {
            diagnostics.push(simpleDiagnostic(`Schema contract rule at index ${index} missing string 'path': ${file}`, 'SCHEMA_RULE_PATH_MISSING'));
            return null;
        }
        if (!ruleObj.constraints || typeof ruleObj.constraints !== 'object' || Array.isArray(ruleObj.constraints)) {
            diagnostics.push(simpleDiagnostic(`Schema contract rule at index ${index} missing object 'constraints': ${file}`, 'SCHEMA_RULE_CONSTRAINTS_MISSING'));
            return null;
        }
        return {
            path: ruleObj.path,
            constraints: ruleObj.constraints as Record<string, unknown>,
        };
    });

    if (rules.some((rule) => rule === null)) {
        return null;
    }

    return {
        rules: rules as Array<{ path: string; constraints: Record<string, unknown> }>,
        ...(world === 'open' || world === 'closed' ? { world } : {}),
        ...(Array.isArray(datatypeAllowlist) ? { datatype_allowlist: datatypeAllowlist as string[] } : {}),
        ...(datatypeRules && typeof datatypeRules === 'object' && !Array.isArray(datatypeRules)
            ? { datatype_rules: datatypeRules as Record<string, Record<string, unknown>> }
            : {}),
    } as SchemaV1;
}

function fromCoreError(error: AEONError): Diagnostic {
    return {
        severity: DiagnosticSeverity.Error,
        message: error.message,
        source: 'aeon-lsp',
        code: (error as { code?: string }).code ?? 'AEON_ERROR',
        range: spanToRange((error as { span?: unknown }).span),
    };
}

function safeRead(file: string | null): string {
    if (!file) return '';
    try {
        return fs.readFileSync(file, 'utf-8');
    } catch {
        return '';
    }
}

function extractHeaderInfo(input: string | null): { profile: string | null; schema: string | null } {
    if (!input) return { profile: null, schema: null };
    const profileShorthand = input.match(/aeon:profile\s*=\s*"([^"]*)"/i)?.[1] ?? null;
    const schemaShorthand = input.match(/aeon:schema\s*=\s*"([^"]*)"/i)?.[1] ?? null;
    const headerBody = input.match(/aeon:header\s*=\s*\{([\s\S]*?)\}/i)?.[1] ?? '';
    const profileHeader = headerBody.match(/profile\s*=\s*"([^"]*)"/i)?.[1] ?? null;
    const schemaHeader = headerBody.match(/schema\s*=\s*"([^"]*)"/i)?.[1] ?? null;
    return {
        profile: profileShorthand ?? profileHeader,
        schema: schemaShorthand ?? schemaHeader,
    };
}
