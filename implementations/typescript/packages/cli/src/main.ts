#!/usr/bin/env node
/**
 * @aeon/cli - AEON Command Line Interface
 * 
 * Commands:
 * - aeon version                 Show version
 * - aeon check <file>            Validate AEON document (CI-friendly)
 * - aeon doctor                  Check environment and contract wiring
 * - aeon fmt [file]              Format AEON document (stdout by default)
 * - aeon inspect <file>          Inspect AEON document (human-readable)
 * - aeon finalize <file>         Finalize AEON document to JSON
 * - aeon bind <file>             Run typed runtime binding with schema JSON
 * - aeon integrity validate <file>  Validate integrity envelope
 * - aeon integrity verify <file>    Verify integrity envelope hashes
 * - aeon integrity sign <file>      Generate integrity envelope snippet
 * 
 * Flags:
 * - --json         Output as JSON (inspect/finalize/integrity)
 * - --contract-registry Trusted contract registry JSON path (doctor/bind)
 * - --write        Write formatted output back to file (fmt only)
 * - --annotations  Include annotation stream records in inspect/bind output
 * - --annotations-only  Output only annotation stream records in inspect output
 * - --sort-annotations  Sort annotation records deterministically before output (inspect/bind)
 * - --map          Output finalized map (finalize only)
 * - --scope        Finalization scope: payload|header|full (finalize/bind)
 * - --projected    Materialize only explicitly included canonical paths (finalize/bind)
 * - --include-path Canonical path to include in projected materialization (repeatable; finalize/bind)
 * - --recovery     Enable recovery mode (partial results with errors)
 * - --max-input-bytes  Maximum UTF-8 input size in bytes
 * - --max-attribute-depth  Maximum attribute selector depth
 * - --max-separator-depth  Maximum separator-spec depth
 * - --max-generic-depth  Maximum nested generic type depth
 * - --schema       Schema JSON path (bind only)
 * - --profile      Profile id (bind only)
 * - --contract-registry Trusted contract registry JSON path (bind only)
 * - --trailing-separator-delimiter-policy  off|warn|error (bind only)
 * - --datatype-policy  reserved_only|allow_custom (check/inspect/finalize/bind)
 * - --rich         Preset alias for --datatype-policy allow_custom
 * - --strict       Strict mode (default)
 * - --loose        Loose mode (warnings only)
 * - --public-key   Public key path for signature verification
 * - --private-key  Private key path for signing
 * - --receipt      Receipt sidecar path override
 * - --write        Write generated envelope to file (sign only)
 * - --replace      Replace existing envelope (sign only)
 * - --include-bytes  Include bytes_hash in envelope (sign only)
 * - --include-checksum  Include checksum_value in envelope (sign only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalize } from '@aeon/canonical';
import { compile, VERSION, formatPath, type CompileResult, type AEONError, type AssignmentEvent } from '@aeon/core';
import type { Span } from '@aeon/lexer';
import { finalizeJson, finalizeMap, type Diagnostic, type FinalizeMeta, type FinalizedEntry, type FinalizeOptions } from '@aeon/finalize';
import {
    buildCanonicalReceipt,
    computeCanonicalHash,
    computeByteHash,
    signStringPayload,
    validateEnvelopeEvents,
    type CanonicalReceipt,
    verifyStringPayloadSignature,
    type EnvelopeDiagnostic,
} from '@aeon/integrity';
import { tokenize } from '@aeon/lexer';
import { parse, type Binding, type Value } from '@aeon/parser';
import { runTypedRuntime } from './runtime-bind.js';
import type { SchemaV1 } from '@aeos/core';

const GP_SECURITY_CONVENTIONS = [
    'aeon.gp.security.v1',
    'aeon.gp.integrity.v1',
    'aeon.gp.signature.v1',
] as const;
const ENVELOPE_DATATYPE = 'envelope';
const ENVELOPE_CONVENTION_KEY = 'close';

type ContractDiagnosticCode =
    | 'CONTRACT_UNKNOWN_PROFILE_ID'
    | 'CONTRACT_UNKNOWN_SCHEMA_ID'
    | 'CONTRACT_ARTIFACT_MISSING'
    | 'CONTRACT_ARTIFACT_HASH_MISMATCH';

// =============================================================================
// MAIN CLI ENTRY POINT
// =============================================================================

const args = process.argv.slice(2);
const command = args[0];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPackageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(__dirname, '../../../../../');

switch (command) {
    case 'version':
    case '--version':
    case '-v':
        showVersion();
        break;
    case 'check':
        check(args.slice(1));
        break;
    case 'doctor':
        doctor(args.slice(1));
        break;
    case 'fmt':
        fmt(args.slice(1));
        break;
    case 'inspect':
        inspect(args.slice(1));
        break;
    case 'finalize':
        finalize(args.slice(1));
        break;
    case 'bind':
        bind(args.slice(1));
        break;
    case 'integrity':
        integrity(args.slice(1));
        break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
        showHelp();
        break;
    default:
        console.error(`Error: Unknown command: ${command}`);
        console.error('Usage: aeon <command> [options] [file]');
        process.exit(2);
}

// =============================================================================
// COMMANDS
// =============================================================================

function showVersion(): void {
    console.log(`aeon ${VERSION}`);
}

function showHelp(): void {
    console.log(`
AEON CLI v${VERSION}

Usage: aeon <command> [options] [file]

Commands:
  version            Show version
  check <file>       Validate AEON document (CI-friendly)
  doctor             Check environment and contract wiring
  fmt [file]         Format AEON document (stdout by default)
  inspect <file>     Inspect AEON document
  finalize <file>    Finalize AEON document to JSON
  bind <file>        Run typed runtime binding with schema JSON
  integrity validate <file>  Validate integrity envelope
  integrity verify <file>    Verify integrity envelope hashes
  integrity sign <file>      Generate integrity envelope snippet

Options:
  --write            Write formatted output back to file (fmt only)
  --contract-registry Trusted contract registry JSON path (doctor/bind)
  --json             Output as JSON (inspect/finalize)
    --annotations      Include annotation stream records in inspect/bind output
    --annotations-only Output only annotation stream records in inspect output
    --sort-annotations Sort annotation records deterministically before output (inspect/bind)
  --map              Output finalized map (finalize only)
  --scope            Finalization scope: payload|header|full (finalize/bind)
  --projected        Materialize only explicitly included canonical paths (finalize/bind)
  --include-path     Canonical path to include in projected materialization (repeatable; finalize/bind)
  --recovery         Enable recovery mode (partial results)
  --max-input-bytes  Maximum UTF-8 input size in bytes
  --max-attribute-depth  Maximum attribute selector depth
  --max-separator-depth  Maximum separator-spec depth
  --max-generic-depth  Maximum nested generic type depth
  --schema           Schema JSON path (bind only)
  --profile          Profile id (bind only)
  --contract-registry Trusted contract registry JSON path (bind only)
  --trailing-separator-delimiter-policy  off|warn|error (bind only)
  --datatype-policy  reserved_only|allow_custom (check/inspect/finalize/bind)
  --rich             Preset alias for --datatype-policy allow_custom
  --strict           Strict mode (default)
  --loose            Loose mode (warnings only)
  --public-key       Public key path for signature verification
  --private-key      Private key path for signing
  --receipt          Receipt sidecar path override
  --write            Write generated envelope to file (sign only)
  --replace          Replace existing envelope (sign only)
  --include-bytes    Include bytes_hash in envelope (sign only)
  --include-checksum Include checksum_value in envelope (sign only)

Examples:
  aeon check config.aeon
  aeon doctor
  aeon doctor --json
  aeon doctor --contract-registry ./contracts/registry.json
  aeon fmt config.aeon
  cat config.aeon | aeon fmt
  aeon fmt config.aeon --write
  aeon inspect config.aeon
  aeon inspect config.aeon --json
    aeon inspect config.aeon --json --annotations
    aeon inspect config.aeon --json --annotations-only
    aeon inspect config.aeon --json --annotations-only --sort-annotations
  aeon inspect config.aeon --recovery
  aeon finalize config.aeon
  aeon finalize config.aeon --json
  aeon finalize config.aeon --map
  aeon finalize config.aeon --scope full
  aeon finalize config.aeon --loose
  aeon finalize config.aeon --projected --include-path '$.app.name'
  aeon finalize config.aeon --map --include-path '$.app.name' --include-path '$.app.port'
  aeon bind config.aeon --schema config.schema.json
  aeon bind config.aeon --schema config.schema.json --profile aeon.gp.profile.v1
  aeon bind config.aeon --contract-registry contracts/registry.json
  aeon bind config.aeon --schema config.schema.json --include-path '$.app.name'
  aeon bind config.aeon --schema config.schema.json --include-path '$.app.name' --include-path '$.app.port'
  aeon bind config.aeon --schema config.schema.json --trailing-separator-delimiter-policy warn
  aeon inspect config.aeon --datatype-policy allow_custom
  aeon inspect config.aeon --rich
  aeon bind config.aeon --schema config.schema.json --datatype-policy allow_custom
  aeon bind config.aeon --schema config.schema.json --rich
  aeon bind config.aeon --schema config.schema.json --loose
    aeon bind config.aeon --schema config.schema.json --annotations
    aeon bind config.aeon --schema config.schema.json --annotations --sort-annotations
  aeon integrity validate config.aeon
  aeon integrity verify config.aeon
  aeon integrity verify config.aeon --public-key ./aeon.pub
  aeon integrity verify config.aeon --receipt ./config.aeon.receipt.json
  aeon integrity sign config.aeon --private-key ./aeon.key
  aeon integrity sign config.aeon --private-key ./aeon.key --write
  aeon integrity sign config.aeon --private-key ./aeon.key --write --receipt ./config.aeon.receipt.json
  aeon integrity sign config.aeon --private-key ./aeon.key --write --replace
  aeon integrity sign config.aeon --private-key ./aeon.key --include-bytes
  aeon integrity sign config.aeon --private-key ./aeon.key --include-checksum
`.trim());
}

/**
 * aeon check <file>
 * Purpose: validation only (CI-friendly)
 * Exit code: 0 = valid, 1 = errors
 */
function check(args: string[]): void {
    const file = findFile(args);
    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon check <file>');
        process.exit(2);
    }

    const datatypePolicy = resolveDatatypePolicy(args);
    const maxInputBytes = resolveMaxInputBytes(args);
    if (args.includes('--datatype-policy') && !datatypePolicy) {
        console.error('Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)');
        console.error('Usage: aeon check <file> [--datatype-policy <reserved_only|allow_custom>]');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const result = compile(input, {
        ...(datatypePolicy ? { datatypePolicy } : {}),
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    });

    if (result.errors.length === 0) {
        console.log('OK');
        process.exit(0);
    } else {
        for (const error of result.errors) {
            console.log(formatErrorLine(error));
        }
        process.exit(1);
    }
}

/**
 * aeon doctor [--json] [--contract-registry <registry.json>]
 * Purpose: environment and contract wiring diagnostics
 */
function doctor(args: string[]): void {
    const jsonOutput = args.includes('--json');
    const registryFlagPresent = args.includes('--contract-registry');
    const registryFlagValue = getFlagValue(args, '--contract-registry');

    if (registryFlagPresent && !registryFlagValue) {
        console.error('Error: Missing value for --contract-registry <registry.json>');
        console.error('Usage: aeon doctor [--json] [--contract-registry <registry.json>]');
        process.exit(2);
    }

    const doctorResult = runDoctor({
        contractRegistryPath: registryFlagValue
            ? path.resolve(process.cwd(), registryFlagValue)
            : getDefaultContractRegistryPath(),
    });

    if (jsonOutput) {
        console.log(JSON.stringify(doctorResult, null, 2));
    } else {
        outputDoctorHuman(doctorResult);
    }

    process.exit(doctorResult.ok ? 0 : 1);
}

function getDefaultContractRegistryPath(): string {
    const specsRoot = process.env.AEONITE_SPECS_ROOT
        ? path.resolve(process.env.AEONITE_SPECS_ROOT)
        : path.resolve(repoRoot, '..', '..', 'aeonite-org', 'aeonite-specs');
    return path.resolve(specsRoot, 'aeon/v1/drafts/contracts/registry.json');
}

/**
 * aeon fmt [file] [--write]
 * Purpose: deterministic, idempotent formatting
 */
function fmt(args: string[]): void {
    const writeOutput = args.includes('--write');
    const file = findFile(args);
    const maxInputBytes = resolveMaxInputBytes(args);

    if (writeOutput && !file) {
        console.error('Error: --write requires a file path');
        console.error('Usage: aeon fmt [file] [--write]');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }

    const input = file ? readFile(file) : readStdin();
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const result = canonicalize(input);
    if (result.errors.length > 0) {
        for (const error of result.errors) {
            console.log(formatGenericErrorLine(error));
        }
        process.exit(1);
    }

    const formatted = ensureTrailingNewline(result.text);
    if (writeOutput) {
        if (input !== formatted) {
            writeFileWithBackup(file!, formatted);
        }
        return;
    }

    process.stdout.write(formatted);
}

/**
 * aeon inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations]
 * Purpose: human inspection (default) or JSON output
 */
function inspect(args: string[]): void {
    const file = findFileWithValueFlags(args, ['--datatype-policy', '--max-input-bytes', '--max-attribute-depth', '--max-separator-depth', '--max-generic-depth']);
    const jsonOutput = args.includes('--json');
    const recovery = args.includes('--recovery');
     const annotationsOnly = args.includes('--annotations-only');
     const includeAnnotations = args.includes('--annotations');
    const sortAnnotations = args.includes('--sort-annotations');
    const datatypePolicy = resolveDatatypePolicy(args);
    const maxInputBytes = resolveMaxInputBytes(args);
    const maxAttributeDepth = resolveDepthOption(args, '--max-attribute-depth');
    const maxSeparatorDepth = resolveDepthOption(args, '--max-separator-depth');
    const maxGenericDepth = resolveDepthOption(args, '--max-generic-depth');

    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>]');
        process.exit(2);
    }

    if (args.includes('--datatype-policy') && !datatypePolicy) {
        console.error('Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)');
        console.error('Usage: aeon inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>]');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }
    if (maxAttributeDepth === null) {
        console.error('Error: Invalid value for --max-attribute-depth (expected a non-negative integer)');
        process.exit(2);
    }
    if (maxSeparatorDepth === null) {
        console.error('Error: Invalid value for --max-separator-depth (expected a non-negative integer)');
        process.exit(2);
    }
    if (maxGenericDepth === null) {
        console.error('Error: Invalid value for --max-generic-depth (expected a non-negative integer)');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const result = compile(input, {
        recovery,
        emitAnnotations: includeAnnotations || annotationsOnly,
        ...(datatypePolicy ? { datatypePolicy } : {}),
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
        ...(maxAttributeDepth !== undefined ? { maxAttributeDepth } : {}),
        ...(maxSeparatorDepth !== undefined ? { maxSeparatorDepth } : {}),
        ...(maxGenericDepth !== undefined ? { maxGenericDepth } : {}),
    });

    const headerInfo = extractHeaderInfo(input);
    const mode = headerInfo.mode;

    if (jsonOutput) {
        outputJSON(result, { includeAnnotations, annotationsOnly, sortAnnotations });
    } else {
        outputMarkdown(file, result, {
            recovery,
            mode,
            version: headerInfo.version,
            profile: headerInfo.profile,
            schema: headerInfo.schema,
            includeAnnotations: includeAnnotations || annotationsOnly,
            annotationsOnly,
            sortAnnotations,
        });
    }

    // Exit with error code if errors present
    if (result.errors.length > 0) {
        process.exit(1);
    }
}

/**
 * aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose]
 * Purpose: finalize AES into JSON output
 */
function finalize(args: string[]): void {
    const file = findFile(args);
    const recovery = args.includes('--recovery');
    const mode = resolveFinalizeMode(args);
    const outputMap = args.includes('--map');
    const datatypePolicy = resolveDatatypePolicy(args);
    const scope = resolveFinalizeScope(args);
    const maxInputBytes = resolveMaxInputBytes(args);
    const includePaths = getFlagValues(args, '--include-path');
    const projected = args.includes('--projected') || includePaths.length > 0;

    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]');
        process.exit(2);
    }

    if (!mode) {
        console.error('Error: Cannot use both --strict and --loose');
        console.error('Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]');
        process.exit(2);
    }

    if (args.includes('--datatype-policy') && !datatypePolicy) {
        console.error('Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)');
        console.error('Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]');
        process.exit(2);
    }
    if (!scope) {
        console.error('Error: Invalid value for --scope (expected payload, header, or full)');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }

    if (args.includes('--include-path') && includePaths.length === 0) {
        console.error('Error: Missing value for --include-path <$.path>');
        console.error('Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]');
        process.exit(2);
    }

    if (projected && includePaths.length === 0) {
        console.error('Error: --projected requires at least one --include-path <$.path>');
        console.error('Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const result = compile(input, {
        recovery,
        ...(datatypePolicy ? { datatypePolicy } : {}),
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    });
    const finalizeOptions: FinalizeOptions = {
        mode,
        scope,
        ...(result.header ? { header: result.header } : {}),
        ...(projected ? { materialization: 'projected', includePaths } : {}),
    };
    const output = outputMap
        ? finalizeMapOutput(result, finalizeOptions)
        : finalizeJsonOutput(result, finalizeOptions);

    console.log(JSON.stringify(output, null, 2));

    const hasErrors = (output.meta?.errors?.length ?? 0) > 0;
    if (hasErrors) {
        process.exit(1);
    }
}

/**
 * aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]
 * Purpose: run phase-ordered runtime binding with schema validation
 */
function bind(args: string[]): void {
    const mode = resolveFinalizeMode(args);
    if (!mode) {
        console.error('Error: Cannot use both --strict and --loose');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }

    const file = findFileWithValueFlags(args, ['--schema', '--profile', '--contract-registry', '--trailing-separator-delimiter-policy', '--datatype-policy', '--include-path']);
    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }

    const schemaPath = getFlagValue(args, '--schema');
    const hasProfileFlag = args.includes('--profile');
    const profile = getFlagValue(args, '--profile');
    const hasRegistryFlag = args.includes('--contract-registry');
    const contractRegistryPath = getFlagValue(args, '--contract-registry');
    const trailingSeparatorPolicyFlag = '--trailing-separator-delimiter-policy';
    const hasTrailingSeparatorPolicy = args.includes(trailingSeparatorPolicyFlag);
    const trailingSeparatorPolicyValue = getFlagValue(args, trailingSeparatorPolicyFlag);
    const trailingSeparatorDelimiterPolicy =
        trailingSeparatorPolicyValue === 'off' ||
        trailingSeparatorPolicyValue === 'warn' ||
        trailingSeparatorPolicyValue === 'error'
            ? trailingSeparatorPolicyValue
            : undefined;
    const datatypePolicy = resolveDatatypePolicy(args);
    const scope = resolveFinalizeScope(args);
    const includeAnnotations = args.includes('--annotations');
    const sortAnnotations = args.includes('--sort-annotations');
    const maxInputBytes = resolveMaxInputBytes(args);
    const includePaths = getFlagValues(args, '--include-path');
    const projected = args.includes('--projected') || includePaths.length > 0;
    if (hasProfileFlag && !profile) {
        console.error('Error: Missing value for --profile <id>');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }
    if (hasRegistryFlag && !contractRegistryPath) {
        console.error('Error: Missing value for --contract-registry <registry.json>');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }
    if (hasTrailingSeparatorPolicy && !trailingSeparatorPolicyValue) {
        console.error('Error: Missing value for --trailing-separator-delimiter-policy <off|warn|error>');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }
    if (hasTrailingSeparatorPolicy && !trailingSeparatorDelimiterPolicy) {
        console.error(`Error: Invalid value for --trailing-separator-delimiter-policy: ${trailingSeparatorPolicyValue}`);
        console.error('Allowed values: off, warn, error');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }
    if (args.includes('--datatype-policy') && !datatypePolicy) {
        console.error('Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }
    if (!scope) {
        console.error('Error: Invalid value for --scope (expected payload, header, or full)');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }
    if (args.includes('--include-path') && includePaths.length === 0) {
        console.error('Error: Missing value for --include-path <$.path>');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }
    if (projected && includePaths.length === 0) {
        console.error('Error: --projected requires at least one --include-path <$.path>');
        console.error('Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const headerInfo = extractHeaderInfo(input);
    const resolvedRegistryPath = contractRegistryPath
        ? path.resolve(process.cwd(), contractRegistryPath)
        : null;
    const registry = resolvedRegistryPath ? readContractRegistryFile(resolvedRegistryPath) : null;

    const effectiveProfile = profile ?? headerInfo.profile;
    if (registry && effectiveProfile) {
        const entry = resolveContractEntry(registry, effectiveProfile, 'profile');
        if (!entry) {
            failContract('CONTRACT_UNKNOWN_PROFILE_ID', `Unknown profile contract id in registry: ${effectiveProfile}`);
        }
        const verified = verifyContractArtifact(entry, resolvedRegistryPath!);
        if (!verified.ok) {
            failContract(verified.code, verified.error);
        }
    }

    let schema: SchemaV1;
    if (schemaPath) {
        schema = schemaPath.toLowerCase().endsWith('.aeon')
            ? readSchemaContractAeonFile(schemaPath)
            : readSchemaFile(schemaPath);
    } else {
        if (!registry || !resolvedRegistryPath) {
            console.error('Error: Missing required --schema <schema.json> (or provide --contract-registry with aeon:schema header id)');
            process.exit(2);
        }
        if (!headerInfo.schema) {
            console.error('Error: Missing schema contract id (aeon:schema) for registry resolution');
            process.exit(2);
        }
        const entry = resolveContractEntry(registry, headerInfo.schema, 'schema');
        if (!entry) {
            failContract('CONTRACT_UNKNOWN_SCHEMA_ID', `Unknown schema contract id in registry: ${headerInfo.schema}`);
        }
        const verified = verifyContractArtifact(entry, resolvedRegistryPath!);
        if (!verified.ok) {
            failContract(verified.code, verified.error);
        }
        schema = readSchemaContractAeonFile(verified.resolvedPath, entry.id);
    }

    const result = runTypedRuntime<unknown>(input, {
        schema,
        mode,
        ...(datatypePolicy ? { datatypePolicy } : {}),
        includeAnnotations,
        scope,
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
        ...(projected ? { materialization: 'projected' as const, includePaths } : {}),
        ...(trailingSeparatorDelimiterPolicy ? { trailingSeparatorDelimiterPolicy } : {}),
        ...(effectiveProfile ? { profile: effectiveProfile } : {}),
    });

    const annotations = includeAnnotations && result.annotations
        ? (sortAnnotations ? sortAnnotationRecords(result.annotations) : result.annotations)
        : undefined;

    console.log(JSON.stringify({
        ...(result.document !== undefined ? { document: result.document } : {}),
        ...(annotations !== undefined ? { annotations } : {}),
        meta: result.meta,
    }, null, 2));

    if (result.meta.errors.length > 0) {
        process.exit(1);
    }
}

/**
 * aeon integrity <validate|verify> <file> [--strict|--loose] [--public-key <path>]
 * Purpose: validate/verify integrity envelopes
 */
function integrity(args: string[]): void {
    const subcommand = args[0];
    if (!subcommand) {
        console.error('Error: Missing integrity subcommand');
        console.error('Usage: aeon integrity <validate|verify> <file> [--strict|--loose]');
        process.exit(2);
    }

    switch (subcommand) {
        case 'validate':
            integrityValidate(args.slice(1));
            break;
        case 'verify':
            integrityVerify(args.slice(1));
            break;
        case 'sign':
            integritySign(args.slice(1));
            break;
        default:
            console.error(`Error: Unknown integrity subcommand: ${subcommand}`);
            console.error('Usage: aeon integrity <validate|verify|sign> <file> [options]');
            process.exit(2);
    }
}

function integrityValidate(args: string[]): void {
    const mode = resolveIntegrityMode(args);
    const jsonOutput = args.includes('--json');
    const maxInputBytes = resolveMaxInputBytes(args);
    if (!mode) {
        console.error('Error: Cannot use both --strict and --loose');
        console.error('Usage: aeon integrity validate <file> [--strict|--loose]');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }

    const file = findFileWithValueFlags(args, ['--public-key', '--pubkey', '--receipt']);
    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon integrity validate <file> [--strict|--loose]');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const compileResult = compile(input, {
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    });
    if (compileResult.errors.length > 0) {
        const errors: EnvelopeDiagnostic[] = [{
            level: 'error',
            code: 'ENVELOPE_PARSE_ERROR',
            message: 'Invalid AEON document for envelope validation',
        }];
        if (jsonOutput) {
            outputEnvelopeJson(errors, [], false);
        } else {
            outputEnvelopeDiagnostics(errors, 'ERROR');
        }
        process.exit(1);
    }

    const result = validateEnvelopeEvents(compileResult.events, { mode });
    if (jsonOutput) {
        outputEnvelopeJson(result.errors, result.warnings, result.errors.length === 0);
        process.exit(result.errors.length === 0 ? 0 : 1);
    } else {
        if (result.errors.length === 0) {
            if (result.warnings.length > 0) {
                outputEnvelopeDiagnostics(result.warnings, 'WARN');
            }
            console.log('OK');
            process.exit(0);
        }
        outputEnvelopeDiagnostics(result.errors, 'ERROR');
        process.exit(1);
    }
}

function integrityVerify(args: string[]): void {
    const mode = resolveIntegrityMode(args);
    const jsonOutput = args.includes('--json');
    const maxInputBytes = resolveMaxInputBytes(args);
    if (!mode) {
        console.error('Error: Cannot use both --strict and --loose');
        console.error('Usage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }

    const file = findFileWithValueFlags(args, ['--public-key', '--pubkey']);
    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const baseInput = removeEnvelope(input);
    const compileResult = compile(input, {
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    });
    const baseCompileResult = compile(baseInput, {
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    });
    if (compileResult.errors.length > 0) {
        const errors: EnvelopeDiagnostic[] = [{
            level: 'error',
            code: 'ENVELOPE_PARSE_ERROR',
            message: 'Invalid AEON document for envelope validation',
        }];
        if (jsonOutput) {
            outputEnvelopeJson(errors, [], false);
        } else {
            outputEnvelopeDiagnostics(errors, 'ERROR');
        }
        process.exit(1);
    }
    if (baseCompileResult.errors.length > 0) {
        const errors: EnvelopeDiagnostic[] = [{
            level: 'error',
            code: 'ENVELOPE_PARSE_ERROR',
            message: 'Invalid AEON document body for envelope verification',
        }];
        if (jsonOutput) {
            outputEnvelopeJson(errors, [], false);
        } else {
            outputEnvelopeDiagnostics(errors, 'ERROR');
        }
        process.exit(1);
    }

    const validation = validateEnvelopeEvents(compileResult.events, { mode });
    if (validation.errors.length > 0) {
        if (jsonOutput) {
            outputEnvelopeJson(validation.errors, validation.warnings, false);
            process.exit(1);
        }
        outputEnvelopeDiagnostics(validation.errors, 'ERROR');
        process.exit(1);
    }

    const diagnostics = {
        errors: [...validation.errors],
        warnings: [...validation.warnings],
    };

    const { fields, errors: parseErrors } = extractEnvelopeFields(input);
    diagnostics.errors.push(...parseErrors);

    if (!fields) {
        diagnostics.errors.push({
            level: 'error',
            code: 'ENVELOPE_MISSING',
            message: 'an :envelope binding is required for verification',
        });
    }

    const verificationMeta: {
        canonical: { present: boolean; algorithm?: string; expected?: string; computed?: string };
        bytes: { present: boolean; algorithm?: string; expected?: string; computed?: string };
        checksum: { present: boolean; algorithm?: string; expected?: string; computed?: string };
        signature: { present: boolean; verified?: boolean };
        replay: { performed: boolean; status: 'match' | 'divergent' | 'unavailable'; expected?: string; computed?: string };
        canonicalStream?: { length: number };
    } = {
        canonical: { present: false },
        bytes: { present: false },
        checksum: { present: false },
        signature: { present: false },
        replay: { performed: false, status: 'unavailable' },
    };
    let receipt: CanonicalReceipt | undefined = resolveReceiptSidecarForVerify(file, args);

    if (fields) {
        const strict = mode === 'strict';
        let hasVerificationTarget = false;
        const canonicalHashValue = readEnvelopeFieldAny(fields, [
            'canonical_hash',
            'canonical:hash',
            'integrity.hash',
            'integrity.hash:string',
            'integrity:integrityBlock.hash',
            'integrity:integrityBlock.hash:string',
        ], diagnostics);
        const canonicalAlgValue = readEnvelopeFieldAny(fields, [
            'canonical_hash_alg',
            'canonical:hash_alg',
            'integrity.alg',
            'integrity.alg:string',
            'integrity:integrityBlock.alg',
            'integrity:integrityBlock.alg:string',
        ], diagnostics);
        if (canonicalHashValue) {
            hasVerificationTarget = true;
            verificationMeta.canonical.present = true;
            const alg = canonicalAlgValue ?? 'sha-256';
            if (!canonicalAlgValue) {
                pushModeDiagnostic(
                    diagnostics,
                    strict,
                    'ENVELOPE_HASH_ALG_DEFAULTED',
                    'canonical_hash_alg missing; defaulting to sha-256'
                );
            }
            const normalizedAlg = normalizeHashAlgorithm(alg, diagnostics, strict, 'canonical_hash_alg');
            if (normalizedAlg) {
                const computed = computeCanonicalHash(baseCompileResult.events, { algorithm: normalizedAlg });
                verificationMeta.canonical.algorithm = normalizedAlg;
                verificationMeta.canonical.expected = canonicalHashValue;
                verificationMeta.canonical.computed = computed.hash;
                verificationMeta.canonicalStream = { length: computed.stream.length };
                verificationMeta.replay = {
                    performed: true,
                    status: normalizeHash(canonicalHashValue) === normalizeHash(computed.hash) ? 'match' : 'divergent',
                    expected: canonicalHashValue,
                    computed: computed.hash,
                };
                receipt ??= createCanonicalReceipt(baseInput, baseCompileResult.events, {
                    embedCanonicalPayload: false,
                    canonicalHashAlgorithm: normalizedAlg,
                    receiptDigestOverride: canonicalHashValue,
                });
                if (normalizeHash(canonicalHashValue) !== normalizeHash(computed.hash)) {
                    diagnostics.errors.push({
                        level: 'error',
                        code: 'ENVELOPE_HASH_MISMATCH',
                        message: 'canonical_hash does not match computed AES hash',
                    });
                }
            }
        } else if (canonicalAlgValue) {
            pushModeDiagnostic(
                diagnostics,
                strict,
                'ENVELOPE_HASH_MISSING',
                'canonical_hash_alg present but canonical_hash is missing'
            );
        }

        const bytesHashValue = readEnvelopeFieldAny(fields, [
            'bytes_hash',
            'bytes:hash',
            'integrity.bytes_hash',
            'integrity.bytes_hash:string',
            'integrity:integrityBlock.bytes_hash',
            'integrity:integrityBlock.bytes_hash:string',
        ], diagnostics);
        const bytesAlgValue = readEnvelopeFieldAny(fields, [
            'bytes_hash_alg',
            'bytes:hash_alg',
            'integrity.bytes_hash_alg',
            'integrity.bytes_hash_alg:string',
            'integrity:integrityBlock.bytes_hash_alg',
            'integrity:integrityBlock.bytes_hash_alg:string',
        ], diagnostics);
        if (bytesHashValue) {
            hasVerificationTarget = true;
            verificationMeta.bytes.present = true;
            const alg = bytesAlgValue ?? 'sha-256';
            if (!bytesAlgValue) {
                pushModeDiagnostic(
                    diagnostics,
                    strict,
                    'ENVELOPE_BYTES_ALG_DEFAULTED',
                    'bytes_hash_alg missing; defaulting to sha-256'
                );
            }
            const normalizedAlg = normalizeHashAlgorithm(alg, diagnostics, strict, 'bytes_hash_alg');
            if (normalizedAlg) {
                const computed = computeByteHash(baseInput, { algorithm: normalizedAlg });
                verificationMeta.bytes.algorithm = normalizedAlg;
                verificationMeta.bytes.expected = bytesHashValue;
                verificationMeta.bytes.computed = computed.hash;
                if (normalizeHash(bytesHashValue) !== normalizeHash(computed.hash)) {
                    diagnostics.errors.push({
                        level: 'error',
                        code: 'ENVELOPE_BYTES_MISMATCH',
                        message: 'bytes_hash does not match computed document hash',
                    });
                }
            }
        } else if (bytesAlgValue) {
            pushModeDiagnostic(
                diagnostics,
                strict,
                'ENVELOPE_BYTES_HASH_MISSING',
                'bytes_hash_alg present but bytes_hash is missing'
            );
        }

        const checksumValue = readEnvelopeFieldAny(fields, [
            'checksum_value',
            'checksum:value',
            'integrity.checksum_value',
            'integrity.checksum_value:string',
            'integrity:integrityBlock.checksum_value',
            'integrity:integrityBlock.checksum_value:string',
        ], diagnostics);
        const checksumAlg = readEnvelopeFieldAny(fields, [
            'checksum_alg',
            'checksum:alg',
            'integrity.checksum_alg',
            'integrity.checksum_alg:string',
            'integrity:integrityBlock.checksum_alg',
            'integrity:integrityBlock.checksum_alg:string',
        ], diagnostics);
        if (checksumValue) {
            hasVerificationTarget = true;
            verificationMeta.checksum.present = true;
            const alg = checksumAlg ?? 'sha-256';
            if (!checksumAlg) {
                pushModeDiagnostic(
                    diagnostics,
                    strict,
                    'ENVELOPE_CHECKSUM_ALG_DEFAULTED',
                    'checksum_alg missing; defaulting to sha-256'
                );
            }
            const normalizedAlg = normalizeHashAlgorithm(alg, diagnostics, strict, 'checksum_alg');
            if (normalizedAlg) {
                const computed = computeByteHash(baseInput, { algorithm: normalizedAlg });
                verificationMeta.checksum.algorithm = normalizedAlg;
                verificationMeta.checksum.expected = checksumValue;
                verificationMeta.checksum.computed = computed.hash;
                if (normalizeHash(checksumValue) !== normalizeHash(computed.hash)) {
                    diagnostics.errors.push({
                        level: 'error',
                        code: 'ENVELOPE_CHECKSUM_MISMATCH',
                        message: 'checksum_value does not match computed document hash',
                    });
                }
            }
        } else if (checksumAlg) {
            pushModeDiagnostic(
                diagnostics,
                strict,
                'ENVELOPE_CHECKSUM_MISSING',
                'checksum_alg present but checksum_value is missing'
            );
        }

        const signature = readEnvelopeFieldAny(fields, [
            'sig',
            'signatures[0].sig',
            'signatures[0].sig:string',
            'signatures:signatureSet[0].sig',
            'signatures:signatureSet[0].sig:string',
        ], diagnostics);
        if (signature) {
            hasVerificationTarget = true;
            verificationMeta.signature.present = true;
            const publicKeyPath = getFlagValue(args, '--public-key') ?? getFlagValue(args, '--pubkey');
            if (!publicKeyPath) {
                pushModeDiagnostic(
                    diagnostics,
                    strict,
                    'ENVELOPE_SIGNATURE_KEY_MISSING',
                    'sig present but no --public-key provided; signature not verified'
                );
            } else {
                const publicKey = readFile(publicKeyPath);
                const payload = verificationMeta.canonical.expected ?? computeCanonicalHash(baseCompileResult.events, { algorithm: 'sha-256' }).hash;
                const ok = verifyStringPayloadSignature(payload, signature, publicKey, { algorithm: 'ed25519' });
                verificationMeta.signature.verified = ok;
                if (!ok) {
                    diagnostics.errors.push({
                        level: 'error',
                        code: 'ENVELOPE_SIGNATURE_INVALID',
                        message: 'signature verification failed',
                    });
                }
            }
        }

        if (!hasVerificationTarget) {
            pushModeDiagnostic(
                diagnostics,
                strict,
                'ENVELOPE_NO_HASH',
                'envelope contains no verifiable hash fields'
            );
        }
        if (!verificationMeta.canonicalStream) {
            const stream = computeCanonicalHash(baseCompileResult.events, { algorithm: 'sha-256' }).stream;
            verificationMeta.canonicalStream = { length: stream.length };
        }
    }

    if (diagnostics.errors.length > 0) {
        if (jsonOutput) {
            outputEnvelopeJson(diagnostics.errors, diagnostics.warnings, false, verificationMeta, receipt);
            process.exit(1);
        } else {
            outputEnvelopeDiagnostics(diagnostics.errors, 'ERROR');
            if (diagnostics.warnings.length > 0) {
                outputEnvelopeDiagnostics(diagnostics.warnings, 'WARN');
            }
            process.exit(1);
        }
    }

    if (diagnostics.warnings.length > 0) {
        if (jsonOutput) {
            outputEnvelopeJson(diagnostics.errors, diagnostics.warnings, true, verificationMeta, receipt);
            process.exit(0);
        } else {
            outputEnvelopeDiagnostics(diagnostics.warnings, 'WARN');
        }
    }

    if (jsonOutput) {
        outputEnvelopeJson(diagnostics.errors, diagnostics.warnings, true, verificationMeta, receipt);
    } else {
        console.log('OK');
    }
}

function integritySign(args: string[]): void {
    const file = findFileWithValueFlags(args, ['--private-key', '--privkey', '--receipt']);
    const jsonOutput = args.includes('--json');
    const writeOutput = args.includes('--write');
    const replaceOutput = args.includes('--replace');
    const includeBytes = args.includes('--include-bytes');
    const includeChecksum = args.includes('--include-checksum');
    const maxInputBytes = resolveMaxInputBytes(args);
    if (!file) {
        console.error('Error: No file specified');
        console.error('Usage: aeon integrity sign <file> --private-key <path> [--receipt <path>]');
        process.exit(2);
    }
    if (maxInputBytes === null) {
        console.error('Error: Invalid value for --max-input-bytes (expected a non-negative integer)');
        process.exit(2);
    }

    const privateKeyPath = getFlagValue(args, '--private-key') ?? getFlagValue(args, '--privkey');
    if (!privateKeyPath) {
        console.error('Error: Missing --private-key');
        console.error('Usage: aeon integrity sign <file> --private-key <path> [--receipt <path>]');
        process.exit(2);
    }

    const input = readFile(file);
    enforceInputByteLimitOrExit(input, maxInputBytes);
    const baseInput = removeEnvelope(input);
    const envelopePresence = extractEnvelopeFields(input);
    if (envelopePresence.errors.length > 0) {
        if (jsonOutput) {
            outputEnvelopeJson(envelopePresence.errors, [], false);
        } else {
            outputEnvelopeDiagnostics(envelopePresence.errors, 'ERROR');
        }
        process.exit(1);
    }
    if (envelopePresence.fields && !replaceOutput) {
        const errors = [{
            level: 'error' as const,
            code: 'ENVELOPE_EXISTS',
            message: 'document already contains an :envelope binding',
        }];
        if (jsonOutput) {
            outputEnvelopeJson(errors, [], false);
        } else {
            outputEnvelopeDiagnostics(errors, 'ERROR');
        }
        process.exit(1);
    }

    const compileResult = compile(baseInput, {
        datatypePolicy: 'allow_custom',
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    });
    if (compileResult.errors.length > 0) {
        if (jsonOutput) {
            const errors = compileResult.errors.map((error) => ({
                level: 'error' as const,
                code: (error as { code?: string }).code ?? 'AEON_ERROR',
                message: error.message,
            }));
            outputEnvelopeJson(errors, [], false);
        } else {
            for (const error of compileResult.errors) {
                console.log(formatErrorLine(error));
            }
        }
        process.exit(1);
    }

    const receipt = createCanonicalReceipt(baseInput, compileResult.events, {
        embedCanonicalPayload: true,
    });
    const receiptPath = resolveReceiptSidecarPathForSign(file, args, writeOutput);
    const canonical = computeCanonicalHash(compileResult.events, { algorithm: 'sha-256' });
    const bytes = includeBytes ? computeByteHash(baseInput, { algorithm: 'sha-256' }) : null;
    const checksum = includeChecksum ? computeByteHash(baseInput, { algorithm: 'sha-256' }) : null;
    const privateKey = readFile(privateKeyPath);
    const signature = signStringPayload(canonical.hash, privateKey, { algorithm: 'ed25519' });

    const lines = [
        `${ENVELOPE_CONVENTION_KEY}:envelope = {`,
        '    integrity:integrityBlock = {',
        '        alg:string = "sha-256"',
        `        hash:string = "${canonical.hash}"`,
    ];
    if (bytes) {
        lines.push('        bytes_hash_alg:string = "sha-256"');
        lines.push(`        bytes_hash:string = "${bytes.hash}"`);
    }
    if (checksum) {
        lines.push('        checksum_alg:string = "sha-256"');
        lines.push(`        checksum_value:string = "${checksum.hash}"`);
    }
    lines.push('    }');
    lines.push('    signatures:signatureSet = [');
    lines.push('        {');
    lines.push('            alg:string = "ed25519"');
    lines.push('            kid:string = "default"');
    lines.push(`            sig:string = "${signature.signature}"`);
    lines.push('        }');
    lines.push('    ]');
    lines.push('}');
    const snippet = lines.join('\n');

    if (writeOutput) {
        const prepared = ensureGpSecurityConventions(baseInput);
        const nextContent = appendEnvelope(prepared.source, snippet);
        writeFileWithBackup(file, nextContent);
        if (receiptPath) {
            writeReceiptSidecar(receiptPath, receipt);
        }
        if (jsonOutput) {
            const envelope = {
                integrity: {
                    alg: 'sha-256',
                    hash: canonical.hash,
                    ...(bytes ? { bytes_hash_alg: 'sha-256', bytes_hash: bytes.hash } : {}),
                    ...(checksum ? { checksum_alg: 'sha-256', checksum_value: checksum.hash } : {}),
                },
                signatures: [
                    {
                        alg: 'ed25519',
                        kid: 'default',
                        sig: signature.signature,
                    },
                ],
            };
            console.log(JSON.stringify({
                ok: true,
                written: true,
                replaced: replaceOutput,
                conventionsApplied: prepared.changed,
                receipt,
                envelope,
            }, null, 2));
        } else {
            console.log(`Wrote envelope to ${file}`);
        }
        return;
    }

    if (jsonOutput) {
        if (receiptPath) {
            writeReceiptSidecar(receiptPath, receipt);
        }
        const envelope = {
            integrity: {
                alg: 'sha-256',
                hash: canonical.hash,
                ...(bytes ? { bytes_hash_alg: 'sha-256', bytes_hash: bytes.hash } : {}),
                ...(checksum ? { checksum_alg: 'sha-256', checksum_value: checksum.hash } : {}),
            },
            signatures: [
                {
                    alg: 'ed25519',
                    kid: 'default',
                    sig: signature.signature,
                },
                ],
            };
        console.log(JSON.stringify({ ok: true, receipt, envelope }, null, 2));
        return;
    }

    if (receiptPath) {
        writeReceiptSidecar(receiptPath, receipt);
    }

    console.log(snippet);
}

// =============================================================================
// OUTPUT FORMATTERS
// =============================================================================

/**
 * Markdown output (default for inspect)
 */
/**
 * JSON output (--json flag)
 */
function outputJSON(result: CompileResult, options: { includeAnnotations: boolean; annotationsOnly: boolean; sortAnnotations: boolean }): void {
    const visibleEvents = result.events.filter(e => !e.key.startsWith('aeon:'));
    const annotations = options.sortAnnotations
        ? sortAnnotationRecords(result.annotations ?? [])
        : (result.annotations ?? []);
    if (options.annotationsOnly) {
        console.log(JSON.stringify({ annotations }, null, 2));
        return;
    }
    const output: {
        events: Array<{
            path: string;
            key: string;
            datatype: string | null;
            span: Span;
            value: unknown;
        }>;
        errors: Array<{
            code: string | undefined;
            path: string;
            span: unknown;
            phaseLabel?: string | undefined;
            message: string;
        }>;
        annotations?: NonNullable<CompileResult['annotations']>;
    } = {
        events: visibleEvents.map(event => ({
            path: formatPath(event.path),
            key: event.key,
            datatype: event.datatype ?? null,
            span: event.span,
            // Preserve AST-like shape (no coercion/inference)
            value: jsonSafe(event.value),
        })),
        errors: result.errors.map(error => ({
            code: (error as { code?: string }).code,
            path: getErrorPath(error) ?? '$',
            span: (error as { span?: unknown }).span,
            ...(getPhaseLabel(error as { code?: string; phase?: unknown })
                ? { phaseLabel: getPhaseLabel(error as { code?: string; phase?: unknown }) }
                : {}),
            message: error.message,
        })),
    };
    if (options.includeAnnotations) {
        output.annotations = annotations;
    }
    console.log(JSON.stringify(output, null, 2));
}

function jsonSafe(value: unknown): unknown {
    if (value instanceof Map) {
        return Object.fromEntries(
            Array.from(value.entries(), ([key, entry]) => [String(key), jsonSafe(entry)]),
        );
    }
    if (Array.isArray(value)) {
        return value.map(jsonSafe);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
        );
    }
    return value;
}

function resolveFinalizeMode(args: string[]): 'strict' | 'loose' | null {
    const hasStrict = args.includes('--strict');
    const hasLoose = args.includes('--loose');
    if (hasStrict && hasLoose) return null;
    if (hasLoose) return 'loose';
    return 'strict';
}

function resolveFinalizeScope(args: string[]): 'payload' | 'header' | 'full' | null {
    const value = getFlagValue(args, '--scope');
    if (!value) return 'payload';
    if (value === 'payload' || value === 'header' || value === 'full') {
        return value;
    }
    return null;
}

function resolveDatatypePolicy(args: string[]): 'reserved_only' | 'allow_custom' | null {
    const hasRichPreset = args.includes('--rich');
    const value = getFlagValue(args, '--datatype-policy');
    if (value === undefined) {
        if (args.includes('--datatype-policy')) return null;
        return hasRichPreset ? 'allow_custom' : null;
    }
    if (hasRichPreset && value === 'reserved_only') return null;
    if (value === 'reserved_only' || value === 'allow_custom') {
        return value;
    }
    return null;
}

function resolveIntegrityMode(args: string[]): 'strict' | 'loose' | null {
    const hasStrict = args.includes('--strict');
    const hasLoose = args.includes('--loose');
    if (hasStrict && hasLoose) return null;
    if (hasLoose) return 'loose';
    return 'strict';
}

function mergeDiagnostics(finalized: { meta?: FinalizeMeta }, errors: readonly AEONError[]): { errors?: Diagnostic[]; warnings?: Diagnostic[] } {
    const mergedErrors: Diagnostic[] = [];
    const mergedWarnings: Diagnostic[] = [];

    if (finalized.meta?.errors) mergedErrors.push(...finalized.meta.errors);
    if (finalized.meta?.warnings) mergedWarnings.push(...finalized.meta.warnings);

    for (const error of errors) {
        mergedErrors.push(toDiagnosticFromError(error));
    }

    const meta: { errors?: Diagnostic[]; warnings?: Diagnostic[] } = {};
    if (mergedErrors.length > 0) meta.errors = mergedErrors;
    if (mergedWarnings.length > 0) meta.warnings = mergedWarnings;
    return meta;
}

function finalizeJsonOutput(result: CompileResult, options: FinalizeOptions) {
    const finalized = finalizeJson(result.events, {
        ...options,
        ...(result.header ? { header: result.header } : {}),
    });
    const meta = mergeDiagnostics(finalized, result.errors);
    return Object.keys(meta).length > 0
        ? { document: finalized.document, meta }
        : { document: finalized.document };
}

function finalizeMapOutput(result: CompileResult, options: FinalizeOptions) {
    const finalized = finalizeMap(result.events, {
        ...options,
        ...(result.header ? { header: result.header } : {}),
    });
    const meta = mergeDiagnostics(finalized, result.errors);
    const entries = Array.from(finalized.document.entries.values()).map(entryToJson);
    const document = { entries };
    return Object.keys(meta).length > 0
        ? { document, meta }
        : { document };
}

function entryToJson(entry: FinalizedEntry) {
    return {
        path: entry.path,
        value: entry.value,
        span: entry.span,
        ...(entry.datatype ? { datatype: entry.datatype } : {}),
        ...(entry.annotations ? { annotations: mapAnnotations(entry.annotations) } : {}),
    };
}

function mapAnnotations(annotations: ReadonlyMap<string, { value: unknown; datatype?: string }>) {
    const entries: Record<string, { value: unknown; datatype?: string }> = {};
    for (const [key, value] of annotations.entries()) {
        entries[key] = {
            value: value.value,
            ...(value.datatype ? { datatype: value.datatype } : {}),
        };
    }
    return entries;
}

function toDiagnosticFromError(error: AEONError): Diagnostic {
    const code = (error as { code?: string }).code;
    const span = (error as { span?: Span }).span;
    const path = getErrorPath(error);
    const phaseLabel = getPhaseLabel(error as { code?: string; phase?: unknown });
    return {
        level: 'error',
        message: error.message,
        ...(code ? { code } : {}),
        ...(path ? { path } : {}),
        ...(span ? { span } : {}),
        ...(phaseLabel ? { phaseLabel } : {}),
    };
}

type DoctorCheckStatus = 'pass' | 'fail' | 'warn';

type DoctorCheck = {
    name: string;
    status: DoctorCheckStatus;
    message: string;
    details?: Record<string, unknown>;
};

type DoctorResult = {
    ok: boolean;
    checks: DoctorCheck[];
};

function runDoctor(options: { contractRegistryPath: string }): DoctorResult {
    const checks: DoctorCheck[] = [];

    const nodeMajor = Number.parseInt(process.version.replace(/^v/, '').split('.')[0] ?? '', 10);
    const workspacePackage = readJsonFileSafe(path.resolve(workspaceRoot, 'package.json'));
    const declaredPnpm = typeof workspacePackage?.packageManager === 'string'
        ? workspacePackage.packageManager
        : null;

    checks.push({
        name: 'node-version',
        status: Number.isFinite(nodeMajor) && nodeMajor >= 20 ? 'pass' : 'fail',
        message: Number.isFinite(nodeMajor) && nodeMajor >= 20
            ? `Node ${process.version} satisfies workspace requirement >=20`
            : `Node ${process.version} does not satisfy workspace requirement >=20`,
        details: {
            actual: process.version,
            required: '>=20.0.0',
        },
    });

    checks.push({
        name: 'pnpm-version',
        status: declaredPnpm ? 'pass' : 'warn',
        message: declaredPnpm
            ? `Workspace declares ${declaredPnpm}`
            : 'Workspace packageManager field is not set',
        ...(declaredPnpm ? { details: { declared: declaredPnpm } } : {}),
    });

    const requiredPackages = [
        '@aeon/core',
        '@aeon/finalize',
        '@aeon/integrity',
        '@aeon/profiles',
        '@aeon/tonic',
        '@aeos/core',
    ];
    const packageStatuses = requiredPackages.map((packageName) => resolveInstalledPackage(packageName));
    const missingPackages = packageStatuses.filter((entry) => !entry.ok);
    checks.push({
        name: 'package-availability',
        status: missingPackages.length === 0 ? 'pass' : 'fail',
        message: missingPackages.length === 0
            ? 'Required CLI/runtime packages are installed'
            : `Missing required packages: ${missingPackages.map((entry) => entry.name).join(', ')}`,
        details: {
            packages: packageStatuses.map((entry) => ({
                name: entry.name,
                ok: entry.ok,
                ...(entry.version ? { version: entry.version } : {}),
            })),
        },
    });

    checks.push(inspectContractRegistry(options.contractRegistryPath));

    checks.push({
        name: 'policy-surface',
        status: 'pass',
        message: 'CLI/runtime policy surface is available',
        details: {
            datatypePolicy: ['reserved_only', 'allow_custom'],
            finalizeMode: ['strict', 'loose'],
            trailingSeparatorDelimiterPolicy: ['off', 'warn', 'error'],
            recovery: true,
        },
    });

    return {
        ok: checks.every((check) => check.status !== 'fail'),
        checks,
    };
}

function outputDoctorHuman(result: DoctorResult): void {
    for (const check of result.checks) {
        const label = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
        console.log(`[${label}] ${check.name} ${check.message}`);
    }
}

function inspectContractRegistry(registryPath: string): DoctorCheck {
    if (!fs.existsSync(registryPath)) {
        return {
            name: 'contract-registry',
            status: 'fail',
            message: `Contract registry not found: ${registryPath}`,
        };
    }

    const registry = readContractRegistryFileSafe(registryPath);
    if (!registry) {
        return {
            name: 'contract-registry',
            status: 'fail',
            message: `Contract registry is unreadable: ${registryPath}`,
        };
    }
    const entryResults = registry.contracts.map((entry) => {
        const verified = verifyContractArtifact(entry, registryPath);
        return {
            id: entry.id,
            kind: entry.kind,
            status: verified.ok ? 'pass' : 'fail',
            ...(verified.ok
                ? { path: verified.resolvedPath }
                : { error: verified.error, code: verified.code }),
        };
    });
    const failures = entryResults.filter((entry) => entry.status === 'fail');

    return {
        name: 'contract-registry',
        status: failures.length === 0 ? 'pass' : 'fail',
        message: failures.length === 0
            ? `Verified ${entryResults.length} contract artifact(s) from ${registryPath}`
            : `Registry verification failed for ${failures.length} contract artifact(s)`,
        details: {
            path: registryPath,
            entries: entryResults,
        },
    };
}

function resolveInstalledPackage(packageName: string): { name: string; ok: boolean; version?: string } {
    const packageJsonPath = path.resolve(cliPackageRoot, 'node_modules', ...packageName.split('/'), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return { name: packageName, ok: false };
    }
    const pkg = readJsonFileSafe(packageJsonPath);
    return {
        name: packageName,
        ok: true,
        ...(typeof pkg?.version === 'string' ? { version: pkg.version } : {}),
    };
}

function readJsonFileSafe(file: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function readContractRegistryFileSafe(file: string): ContractRegistryDoc | null {
    const parsed = readJsonFileSafe(file);
    if (!parsed || !Array.isArray((parsed as { contracts?: unknown }).contracts)) {
        return null;
    }
    const contracts = (parsed as { contracts: unknown[] }).contracts;
    for (const entry of contracts) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
        }
        const candidate = entry as Partial<ContractRegistryEntry>;
        if (
            typeof candidate.id !== 'string' ||
            (candidate.kind !== 'profile' && candidate.kind !== 'schema') ||
            typeof candidate.version !== 'string' ||
            typeof candidate.path !== 'string' ||
            typeof candidate.sha256 !== 'string' ||
            (candidate.status !== 'active' && candidate.status !== 'deprecated')
        ) {
            return null;
        }
    }
    return parsed as unknown as ContractRegistryDoc;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatGenericErrorLine(error: { code?: string; span?: unknown; message: string }): string {
    const code = error.code ?? 'UNKNOWN';
    const span = formatSpan(error.span);
    const message = String(error.message).replace(/[\r\n]+/g, ' ');
    const phaseLabel = getPhaseLabel(error);
    const prefix = phaseLabel ? `${phaseLabel}: ` : '';
    return `${prefix}${message} [${code}] path=$ span=${span}`;
}

function findFile(args: string[]): string | undefined {
    return args.find(arg => !arg.startsWith('--'));
}

function findFileWithValueFlags(args: string[], valueFlags: string[]): string | undefined {
    const skip = new Set<number>();
    for (let i = 0; i < args.length; i++) {
        if (valueFlags.includes(args[i] ?? '') && i + 1 < args.length) {
            skip.add(i + 1);
        }
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg.startsWith('--')) continue;
        if (skip.has(i)) continue;
        return arg;
    }
    return undefined;
}

function getFlagValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return undefined;
    return value;
}

function getFlagValues(args: string[], flag: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] !== flag) continue;
        const value = args[i + 1];
        if (!value || value.startsWith('--')) continue;
        values.push(value);
    }
    return values;
}

function resolveMaxInputBytes(args: string[]): number | undefined | null {
    if (!args.includes('--max-input-bytes')) return undefined;
    const value = getFlagValue(args, '--max-input-bytes');
    if (value === undefined) return null;
    if (!/^\d+$/.test(value)) return null;
    return Number.parseInt(value, 10);
}

function resolveDepthOption(args: string[], flag: string): number | undefined | null {
    if (!args.includes(flag)) return undefined;
    const value = getFlagValue(args, flag);
    if (value === undefined) return null;
    if (!/^\d+$/.test(value)) return null;
    return Number.parseInt(value, 10);
}

function enforceInputByteLimitOrExit(input: string, maxInputBytes: number | undefined): void {
    if (maxInputBytes === undefined) return;
    const actualBytes = Buffer.byteLength(input, 'utf8');
    if (actualBytes <= maxInputBytes) return;
    console.error(`Error: Input size ${actualBytes} bytes exceeds configured limit of ${maxInputBytes} bytes`);
    process.exit(1);
}

function readFile(file: string): string {
    try {
        return fs.readFileSync(file, 'utf-8');
    } catch (err) {
        console.error(`Error: Cannot read file: ${file}`);
        process.exit(2);
    }
}

function readStdin(): string {
    try {
        return fs.readFileSync(0, 'utf-8');
    } catch {
        console.error('Error: Cannot read stdin');
        process.exit(2);
    }
}

function ensureTrailingNewline(text: string): string {
    return text.endsWith('\n') ? text : `${text}\n`;
}

function readSchemaFile(file: string): SchemaV1 {
    const raw = readFile(file);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.error(`Error: Schema file is not valid JSON: ${file}`);
        process.exit(2);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error(`Error: Schema file must be a JSON object: ${file}`);
        process.exit(2);
    }

    return normalizeSchemaContractDoc(parsed as Record<string, unknown>, file);
}

function normalizeSchemaContractDoc(
    doc: Record<string, unknown>,
    file: string,
    expectedSchemaId?: string
): SchemaV1 {
    const schemaId = doc['schema_id'];
    const schemaVersion = doc['schema_version'];
    const rulesRaw = doc['rules'];
    const world = doc['world'];
    const datatypeRules = doc['datatype_rules'];
    const datatypeAllowlist = doc['datatype_allowlist'];
    const allowedTopLevel = new Set([
        'schema_id',
        'schema_version',
        'rules',
        'world',
        'datatype_rules',
        'datatype_allowlist',
    ]);

    for (const key of Object.keys(doc)) {
        if (!allowedTopLevel.has(key)) {
            console.error(`Error: Unknown schema contract key '${key}' in ${file}`);
            process.exit(2);
        }
    }

    if (typeof schemaId !== 'string' || schemaId.length === 0) {
        console.error(`Error: Schema contract missing required string field 'schema_id': ${file}`);
        process.exit(2);
    }
    if (expectedSchemaId && schemaId !== expectedSchemaId) {
        console.error(`Error: Schema contract id mismatch. Expected '${expectedSchemaId}', found '${schemaId}' in ${file}`);
        process.exit(2);
    }
    if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) {
        console.error(`Error: Schema contract missing required string field 'schema_version': ${file}`);
        process.exit(2);
    }
    if (!Array.isArray(rulesRaw)) {
        console.error(`Error: Schema contract missing required array field 'rules': ${file}`);
        process.exit(2);
    }
    if (world !== undefined && world !== 'open' && world !== 'closed') {
        console.error(`Error: Schema contract field 'world' must be "open" or "closed": ${file}`);
        process.exit(2);
    }
    if (datatypeRules !== undefined) {
        if (!datatypeRules || typeof datatypeRules !== 'object' || Array.isArray(datatypeRules)) {
            console.error(`Error: Schema contract field 'datatype_rules' must be object: ${file}`);
            process.exit(2);
        }
        for (const [key, value] of Object.entries(datatypeRules)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                console.error(`Error: Schema contract datatype_rules['${key}'] must be object: ${file}`);
                process.exit(2);
            }
        }
    }
    if (datatypeAllowlist !== undefined) {
        if (!Array.isArray(datatypeAllowlist) || datatypeAllowlist.some((v) => typeof v !== 'string')) {
            console.error(`Error: Schema contract field 'datatype_allowlist' must be array<string>: ${file}`);
            process.exit(2);
        }
    }

    const rules = rulesRaw.map((rule, index) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            console.error(`Error: Schema contract rule at index ${index} is not an object: ${file}`);
            process.exit(2);
        }
        const ruleObj = rule as Record<string, unknown>;
        if (typeof ruleObj.path !== 'string' || !ruleObj.path) {
            console.error(`Error: Schema contract rule at index ${index} missing string 'path': ${file}`);
            process.exit(2);
        }
        if (!ruleObj.constraints || typeof ruleObj.constraints !== 'object' || Array.isArray(ruleObj.constraints)) {
            console.error(`Error: Schema contract rule at index ${index} missing object 'constraints': ${file}`);
            process.exit(2);
        }
        return {
            path: ruleObj.path,
            constraints: ruleObj.constraints as Record<string, unknown>,
        };
    });

    return {
        rules,
        ...(world !== undefined ? { world: world as 'open' | 'closed' } : {}),
        ...(datatypeRules && typeof datatypeRules === 'object' && !Array.isArray(datatypeRules)
            ? { datatype_rules: datatypeRules as Record<string, Record<string, unknown>> }
            : {}),
        ...(Array.isArray(datatypeAllowlist)
            ? { datatype_allowlist: datatypeAllowlist as string[] }
            : {}),
    } as SchemaV1;
}

function readSchemaContractAeonFile(file: string, expectedSchemaId?: string): SchemaV1 {
    const source = readFile(file);
    const compiled = compile(source, { datatypePolicy: 'allow_custom' });
    if (compiled.errors.length > 0) {
        console.error(`Error: Schema contract AEON file failed to parse: ${file}`);
        for (const error of compiled.errors) {
            console.error(`  - ${(error as { code?: string }).code ?? 'AEON_ERROR'}: ${error.message}`);
        }
        process.exit(2);
    }

    const finalized = finalizeJson(compiled.events, { mode: 'strict' });
    if ((finalized.meta?.errors?.length ?? 0) > 0) {
        console.error(`Error: Schema contract AEON file failed to finalize: ${file}`);
        for (const error of finalized.meta?.errors ?? []) {
            console.error(`  - ${error.message}`);
        }
        process.exit(2);
    }

    return normalizeSchemaContractDoc(finalized.document as Record<string, unknown>, file, expectedSchemaId);
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

function readContractRegistryFile(file: string): ContractRegistryDoc {
    const raw = readFile(file);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.error(`Error: Contract registry file is not valid JSON: ${file}`);
        process.exit(2);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { contracts?: unknown }).contracts)) {
        console.error(`Error: Contract registry JSON must contain a top-level 'contracts' array: ${file}`);
        process.exit(2);
    }

    const contracts = (parsed as { contracts: unknown[] }).contracts;
    for (let i = 0; i < contracts.length; i++) {
        const entry = contracts[i];
        if (!entry || typeof entry !== 'object') {
            console.error(`Error: Invalid contract registry entry at index ${i}`);
            process.exit(2);
        }
        const candidate = entry as Partial<ContractRegistryEntry>;
        const kind = candidate.kind;
        const status = candidate.status;
        if (typeof candidate.id !== 'string' ||
            (kind !== 'profile' && kind !== 'schema') ||
            typeof candidate.version !== 'string' ||
            typeof candidate.path !== 'string' ||
            !candidate.path.toLowerCase().endsWith('.aeon') ||
            typeof candidate.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(candidate.sha256) ||
            (status !== 'active' && status !== 'deprecated')) {
            console.error(`Error: Invalid contract registry entry shape at index ${i}`);
            process.exit(2);
        }
    }

    return parsed as ContractRegistryDoc;
}

function resolveContractEntry(registry: ContractRegistryDoc, id: string, kind: ContractKind): ContractRegistryEntry | null {
    const entry = registry.contracts.find((contract) => contract.id === id && contract.kind === kind);
    if (!entry) return null;
    if (entry.status !== 'active') return null;
    return entry;
}

function failContract(code: ContractDiagnosticCode, message: string): never {
    console.error(`Error [${code}]: ${message}`);
    process.exit(2);
}

function verifyContractArtifact(
    entry: ContractRegistryEntry,
    registryPath: string
): { ok: true; resolvedPath: string } | { ok: false; code: ContractDiagnosticCode; error: string } {
    const baseDir = path.dirname(path.resolve(registryPath));
    const resolvedPath = path.resolve(baseDir, entry.path);

    let fileBuffer: Buffer;
    try {
        fileBuffer = fs.readFileSync(resolvedPath);
    } catch {
        return {
            ok: false,
            code: 'CONTRACT_ARTIFACT_MISSING',
            error: `Missing contract artifact for '${entry.id}' at ${resolvedPath}`,
        };
    }

    const actual = createHash('sha256').update(fileBuffer).digest('hex');
    if (actual !== entry.sha256.toLowerCase()) {
        return {
            ok: false,
            code: 'CONTRACT_ARTIFACT_HASH_MISMATCH',
            error: `Contract artifact hash mismatch for '${entry.id}' at ${resolvedPath}`,
        };
    }

    return { ok: true, resolvedPath };
}

function appendEnvelope(source: string, envelope: string): string {
    const trimmed = source.trimEnd();
    const separator = trimmed.length === 0 || trimmed.endsWith('\n') ? '' : '\n';
    return `${trimmed}${separator}\n${envelope}\n`;
}

function removeEnvelope(source: string): string {
    const trimmed = source.trimEnd();
    const lines = trimmed.split('\n');
    let startIndex = -1;
    let openBraces = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (startIndex === -1) {
            if (isEnvelopeStartLine(line)) {
                startIndex = i;
                openBraces += countChar(line, '{') - countChar(line, '}');
                if (openBraces <= 0) {
                    const before = lines.slice(0, i);
                    const after = lines.slice(i + 1);
                    return [...before, ...after].join('\n').trimEnd();
                }
            }
        } else {
            openBraces += countChar(line, '{') - countChar(line, '}');
            if (openBraces <= 0) {
                const before = lines.slice(0, startIndex);
                const after = lines.slice(i + 1);
                return [...before, ...after].join('\n').trimEnd();
            }
        }
    }

    return source.trimEnd();
}

function countChar(value: string, ch: string): number {
    let count = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === ch) count += 1;
    }
    return count;
}

function writeFileWithBackup(file: string, contents: string): void {
    const backupPath = nextBackupPath(file);
    fs.copyFileSync(file, backupPath);
    fs.writeFileSync(file, contents, 'utf-8');
}

function nextBackupPath(file: string): string {
    let candidate = `${file}.bak`;
    if (!fs.existsSync(candidate)) return candidate;
    let index = 1;
    while (fs.existsSync(`${file}.bak${index}`)) {
        index += 1;
    }
    return `${file}.bak${index}`;
}

function ensureGpSecurityConventions(source: string): { source: string; changed: boolean } {
    const structured = findStructuredHeaderRange(source);
    if (!structured) {
        const header = renderSecurityHeader();
        return {
            source: `${header}\n\n${source.trimStart()}`.trimEnd(),
            changed: true,
        };
    }

    const headerBlock = source.slice(structured.start, structured.end);
    const existing = new Set(extractHeaderConventions(headerBlock));
    const missing = GP_SECURITY_CONVENTIONS.filter((entry) => !existing.has(entry));
    if (missing.length === 0) {
        return { source, changed: false };
    }

    const updated = mergeSecurityConventionsIntoHeader(headerBlock, missing);
    return {
        source: `${source.slice(0, structured.start)}${updated}${source.slice(structured.end)}`,
        changed: true,
    };
}

function renderSecurityHeader(): string {
    return [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        ...GP_SECURITY_CONVENTIONS.map((entry) => `    "${entry}"`),
        '  ]',
        '}',
    ].join('\n');
}

function findStructuredHeaderRange(source: string): { start: number; end: number } | null {
    const marker = /aeon:header\s*=\s*\{/g;
    const match = marker.exec(source);
    if (!match) return null;
    const start = match.index;
    const openIndex = source.indexOf('{', match.index);
    if (openIndex === -1) return null;

    let depth = 0;
    let inString: '"' | "'" | '`' | null = null;
    let escaping = false;
    for (let i = openIndex; i < source.length; i++) {
        const ch = source[i]!;
        if (inString) {
            if (escaping) {
                escaping = false;
                continue;
            }
            if (ch === '\\') {
                escaping = true;
                continue;
            }
            if (ch === inString) {
                inString = null;
            }
            continue;
        }
        if (ch === '"' || ch === '\'' || ch === '`') {
            inString = ch;
            continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                let end = i + 1;
                while (end < source.length && (source[end] === '\n' || source[end] === '\r')) {
                    end += 1;
                }
                return { start, end };
            }
        }
    }

    return null;
}

function extractHeaderConventions(headerBlock: string): string[] {
    const match = headerBlock.match(/(^|\n)([ \t]*)conventions(?:\s*:[^=\n]+)?\s*=\s*\[([\s\S]*?)\n\2\]/);
    if (!match) return [];
    const body = match[3] ?? '';
    return [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!).filter(Boolean);
}

function mergeSecurityConventionsIntoHeader(headerBlock: string, missing: readonly string[]): string {
    const listPattern = /(^|\n)([ \t]*)conventions(?:\s*:[^=\n]+)?\s*=\s*\[([\s\S]*?)\n\2\]/;
    const match = headerBlock.match(listPattern);
    if (!match) {
        const insertAt = headerBlock.indexOf('{') + 1;
        const prefix = headerBlock.slice(0, insertAt);
        const suffix = headerBlock.slice(insertAt);
        const snippet = [
            '',
            '  conventions:conventionSet = [',
            ...missing.map((entry) => `    "${entry}"`),
            '  ]',
        ].join('\n');
        return `${prefix}${snippet}${suffix}`;
    }

    const indent = match[2] ?? '';
    const existingBody = (match[3] ?? '').trimEnd();
    const extraEntries = missing.map((entry) => `${indent}  "${entry}"`);
    const body = existingBody.length > 0
        ? `${existingBody}\n${extraEntries.join('\n')}`
        : extraEntries.join('\n');
    const replacement = `${match[1]}${indent}conventions:conventionSet = [\n${body}\n${indent}]`;
    return headerBlock.replace(listPattern, replacement);
}

type HeaderInfo = {
    mode: 'transport' | 'strict';
    version: string | null;
    profile: string | null;
    schema: string | null;
};

function extractHeaderInfo(input: string): HeaderInfo {
    // Lightweight header extraction without depending on the parser/lexer.
    // This intentionally uses simple regexes to find header shorthand or
    // structured header fields. It's only used for human-readable metadata
    // in the CLI output and must not affect compilation behavior.
    try {
        let mode: HeaderInfo['mode'] = 'transport';
        let version: string | null = null;
        let profile: string | null = null;
        let schema: string | null = null;

        // Shorthand header fields: aeon:mode = "strict"
        const modeMatch = input.match(/aeon:mode\s*=\s*"(strict|transport|custom)"/i);
        const modeGroup = modeMatch?.[1];
        if (modeGroup) mode = modeGroup.toLowerCase() as HeaderInfo['mode'];

        const vMatch = input.match(/aeon:version\s*=\s*"([^"]*)"/i);
        version = vMatch?.[1] ?? null;

        const pMatch = input.match(/aeon:profile\s*=\s*"([^"]*)"/i);
        profile = pMatch?.[1] ?? null;

        const sMatch = input.match(/aeon:schema\s*=\s*"([^"]*)"/i);
        schema = sMatch?.[1] ?? null;

        // Structured header: aeon:header = { ... }
        const headerMatch = input.match(/aeon:header\s*=\s*\{([\s\S]*?)\}/i);
        if (headerMatch) {
            const body = headerMatch[1] ?? '';
            const hv = body.match(/version\s*=\s*"([^"]*)"/i);
            version = hv?.[1] ?? version;
            const hp = body.match(/profile\s*=\s*"([^"]*)"/i);
            profile = hp?.[1] ?? profile;
            const hs = body.match(/schema\s*=\s*"([^"]*)"/i);
            schema = hs?.[1] ?? schema;
            const hm = body.match(/mode\s*=\s*"(strict|transport)"/i);
            const hmGroup = hm?.[1];
            if (hmGroup) mode = hmGroup.toLowerCase() as HeaderInfo['mode'];
        }

        return { mode, version, profile, schema };
    } catch {
        return { mode: 'transport', version: null, profile: null, schema: null };
    }
}

function createCanonicalReceipt(
    source: string,
    events: readonly AssignmentEvent[],
    overrides: {
        embedCanonicalPayload?: boolean;
        canonicalHashAlgorithm?: 'sha-256' | 'sha-512';
        receiptDigestOverride?: string;
    } = {}
): CanonicalReceipt {
    const header = extractHeaderInfo(source);
    const receipt = buildCanonicalReceipt(source, events, {
        canonicalMode: header.mode,
        canonicalProfile: header.profile ?? 'core',
        canonicalSpecRelease: 'v1',
        canonicalHashAlgorithm: overrides.canonicalHashAlgorithm ?? 'sha-256',
        embedCanonicalPayload: overrides.embedCanonicalPayload ?? true,
        producer: {
            implementation: 'aeon-cli-ts',
            version: VERSION,
        },
    });
    if (!overrides.receiptDigestOverride) {
        return receipt;
    }
    return {
        ...receipt,
        canonical: {
            ...receipt.canonical,
            digest: overrides.receiptDigestOverride,
        },
    };
}

function defaultReceiptSidecarPath(file: string): string {
    return `${file}.receipt.json`;
}

function resolveReceiptSidecarPathForSign(file: string, args: string[], writeOutput: boolean): string | undefined {
    const explicit = getFlagValue(args, '--receipt');
    if (args.includes('--receipt') && explicit === undefined) {
        console.error('Error: Missing value for --receipt <path>');
        process.exit(2);
    }
    if (explicit) return explicit;
    return writeOutput ? defaultReceiptSidecarPath(file) : undefined;
}

function resolveReceiptSidecarForVerify(file: string, args: string[]): CanonicalReceipt | undefined {
    const explicit = getFlagValue(args, '--receipt');
    if (args.includes('--receipt') && explicit === undefined) {
        console.error('Error: Missing value for --receipt <path>');
        process.exit(2);
    }
    const candidate = explicit ?? defaultReceiptSidecarPath(file);
    if (!fs.existsSync(candidate)) {
        return undefined;
    }
    return readReceiptSidecar(candidate);
}

function readReceiptSidecar(file: string): CanonicalReceipt {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFile(file));
    } catch {
        console.error(`Error: Receipt file is not valid JSON: ${file}`);
        process.exit(2);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error(`Error: Receipt file must be a JSON object: ${file}`);
        process.exit(2);
    }
    return parsed as CanonicalReceipt;
}

function writeReceiptSidecar(file: string, receipt: CanonicalReceipt): void {
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2), 'utf-8');
}

function extractEnvelopeFields(input: string): { fields: Map<string, Value> | null; errors: EnvelopeDiagnostic[] } {
    const lex = tokenize(input);
    const parseResult = parse(lex.tokens);
    if (lex.errors.length > 0 || parseResult.errors.length > 0 || !parseResult.document) {
        return {
            fields: null,
            errors: [{ level: 'error', code: 'ENVELOPE_PARSE_ERROR', message: 'Unable to parse envelope source' }],
        };
    }

    const binding = parseResult.document.bindings.find((entry) => isEnvelopeBinding(entry));
    if (!binding) {
        return { fields: null, errors: [] };
    }

    if (binding.value.type !== 'ObjectNode') {
        return {
            fields: null,
            errors: [{ level: 'error', code: 'ENVELOPE_NOT_OBJECT', message: 'envelope binding must be an object' }],
        };
    }

    const fields = new Map<string, Value>();
    for (const entry of binding.value.bindings) {
        collectEnvelopeFields(fields, entry, []);
    }
    return { fields, errors: [] };
}

function isEnvelopeStartLine(line: string): boolean {
    return /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*envelope\b/.test(line);
}

function isEnvelopeBinding(binding: Binding): boolean {
    return datatypeBase(binding.datatype?.name) === ENVELOPE_DATATYPE;
}

function datatypeBase(datatype: string | undefined): string | null {
    if (!datatype) return null;
    const genericIdx = datatype.indexOf('<');
    const separatorIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, separatorIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx).toLowerCase();
}

function collectEnvelopeFields(fields: Map<string, Value>, binding: Binding, parents: readonly string[]): void {
    const prefixes = formatEnvelopePrefixes(binding, parents);
    for (const prefix of prefixes) {
        fields.set(prefix, binding.value);
    }

    if (binding.value.type === 'ObjectNode') {
        for (const child of binding.value.bindings) {
            collectEnvelopeFields(fields, child, prefixes);
        }
        return;
    }

    if (binding.value.type === 'ListNode') {
        for (let index = 0; index < binding.value.elements.length; index++) {
            const element = binding.value.elements[index]!;
            for (const prefix of prefixes) {
                fields.set(`${prefix}[${index}]`, element);
            }
            if (element.type === 'ObjectNode') {
                for (const child of element.bindings) {
                    collectEnvelopeFields(fields, child, prefixes.map((prefix) => `${prefix}[${index}]`));
                }
            }
        }
    }
}

function formatEnvelopePrefixes(binding: Binding, parents: readonly string[]): string[] {
    const base = parents.length > 0 ? parents.map((parent) => `${parent}.${binding.key}`) : [binding.key];
    if (!binding.datatype?.name) {
        return base;
    }
    const typed = parents.length > 0
        ? parents.map((parent) => `${parent}.${binding.key}:${binding.datatype!.name}`)
        : [`${binding.key}:${binding.datatype.name}`];
    return [...new Set([...base, ...typed])];
}

function readEnvelopeField(
    fields: Map<string, Value>,
    key: string,
    diagnostics: { errors: EnvelopeDiagnostic[]; warnings: EnvelopeDiagnostic[] }
): string | null {
    const value = fields.get(key);
    if (!value) return null;
    const literal = readLiteralString(value);
    if (literal === null) {
        diagnostics.errors.push({
            level: 'error',
            code: 'ENVELOPE_FIELD_TYPE',
            message: `${key} must be a literal string value`,
        });
        return null;
    }
    return literal;
}

function readEnvelopeFieldAny(
    fields: Map<string, Value>,
    keys: readonly string[],
    diagnostics: { errors: EnvelopeDiagnostic[]; warnings: EnvelopeDiagnostic[] }
): string | null {
    for (const key of keys) {
        const value = readEnvelopeField(fields, key, diagnostics);
        if (value !== null) return value;
    }
    return null;
}

function readLiteralString(value: Value): string | null {
    switch (value.type) {
        case 'StringLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'EncodingLiteral':
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'InfinityLiteral':
            return String(value.raw);
        case 'NumberLiteral':
        case 'BooleanLiteral':
        case 'SwitchLiteral':
        case 'CloneReference':
        case 'PointerReference':
        case 'ObjectNode':
        case 'ListNode':
        default:
            return null;
    }
}

function normalizeHash(value: string): string {
    return value.trim().replace(/^#/, '').toLowerCase();
}

function normalizeHashAlgorithm(
    algorithm: string,
    diagnostics: { errors: EnvelopeDiagnostic[]; warnings: EnvelopeDiagnostic[] },
    strict: boolean,
    field: string
): 'sha-256' | 'sha-512' | null {
    const normalized = algorithm.trim().toLowerCase();
    if (normalized === 'sha-256' || normalized === 'sha256') return 'sha-256';
    if (normalized === 'sha-512' || normalized === 'sha512') return 'sha-512';
    const message = `${field} must be sha-256 or sha-512 (received "${algorithm}")`;
    if (strict) {
        diagnostics.errors.push({ level: 'error', code: 'ENVELOPE_HASH_ALG_UNSUPPORTED', message });
    } else {
        diagnostics.warnings.push({ level: 'warning', code: 'ENVELOPE_HASH_ALG_UNSUPPORTED', message });
    }
    return null;
}

function pushModeDiagnostic(
    diagnostics: { errors: EnvelopeDiagnostic[]; warnings: EnvelopeDiagnostic[] },
    strict: boolean,
    code: string,
    message: string
): void {
    if (strict) {
        diagnostics.errors.push({ level: 'error', code, message });
    } else {
        diagnostics.warnings.push({ level: 'warning', code, message });
    }
}

function outputEnvelopeDiagnostics(diagnostics: readonly EnvelopeDiagnostic[], label: 'ERROR' | 'WARN'): void {
    for (const diagnostic of diagnostics) {
        const code = diagnostic.code ?? 'ENVELOPE';
        const message = diagnostic.message.replace(/[\r\n]+/g, ' ');
        console.log(`${label} [${code}] ${message}`);
    }
}

type VerificationJson = {
    canonical: { present: boolean; algorithm?: string; expected?: string; computed?: string };
    bytes: { present: boolean; algorithm?: string; expected?: string; computed?: string };
    checksum: { present: boolean; algorithm?: string; expected?: string; computed?: string };
    signature: { present: boolean; verified?: boolean };
    replay: { performed: boolean; status: 'match' | 'divergent' | 'unavailable'; expected?: string; computed?: string };
    canonicalStream?: { length: number };
};

function outputEnvelopeJson(
    errors: readonly EnvelopeDiagnostic[],
    warnings: readonly EnvelopeDiagnostic[],
    ok: boolean,
    verification?: VerificationJson,
    receipt?: CanonicalReceipt
): void {
    const payload = {
        ok,
        errors: errors.map((diag) => ({
            code: diag.code,
            message: diag.message,
        })),
        warnings: warnings.map((diag) => ({
            code: diag.code,
            message: diag.message,
        })),
        ...(receipt ? { receipt } : {}),
        ...(verification ? { verification } : {}),
    };
    console.log(JSON.stringify(payload, null, 2));
}

 

function outputMarkdown(
    file: string,
    result: CompileResult,
    info: {
        recovery: boolean;
        mode: 'transport' | 'strict';
        version: string | null;
        profile: string | null;
        schema: string | null;
        includeAnnotations: boolean;
        annotationsOnly: boolean;
        sortAnnotations: boolean;
    },
): void {
    const visibleEvents = result.events.filter(e => !e.key.startsWith('aeon:'));
    const annotations = info.sortAnnotations
        ? sortAnnotationRecords(result.annotations ?? [])
        : (result.annotations ?? []);

    if (info.annotationsOnly) {
        console.log('# AEON Annotations');
        console.log('');
        console.log(`- Count: ${annotations.length}`);
        if (annotations.length > 0) {
            console.log('');
            console.log('## Annotation Records');
            for (const annotation of annotations) {
                console.log(`- ${formatAnnotationLine(annotation)}`);
            }
        }
        return;
    }

    console.log('# AEON Inspect');

    if (info.recovery) {
        console.log('> WARNING: recovery mode enabled (tooling-only); output may be partial');
    }

    console.log('');
    console.log('## Summary');
    console.log(`- File: ${path.basename(file)}`);
    console.log(`- Version: ${info.version ?? '—'}`);
    console.log(`- Mode: ${info.mode}`);
    console.log(`- Profile: ${info.profile ?? '—'}`);
    console.log(`- Schema: ${info.schema ?? '—'}`);
    console.log(`- Recovery: ${info.recovery ? 'true' : 'false'}`);
    console.log(`- Events: ${visibleEvents.length}`);
    if (info.includeAnnotations) {
        console.log(`- Annotations: ${annotations.length}`);
    }
    console.log(`- Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
        console.log('');
        console.log('## Errors');
        for (const error of result.errors) {
            console.log(`- ${formatErrorLine(error)}`);
        }
    }

    if (visibleEvents.length > 0) {
        console.log('');
        console.log('## Assignment Events');
        for (const event of visibleEvents) {
            console.log(`- ${formatEventLine(event)}`);
        }
    }

    const refs = findReferences(visibleEvents);
    if (refs.length > 0) {
        console.log('');
        console.log('## References');
        for (const ref of refs) {
            console.log(`- ${ref}`);
        }
    }

    if (info.includeAnnotations && annotations.length > 0) {
        console.log('');
        console.log('## Annotation Records');
        for (const annotation of annotations) {
            console.log(`- ${formatAnnotationLine(annotation)}`);
        }
    }
}

function sortAnnotationRecords(records: NonNullable<CompileResult['annotations']>): NonNullable<CompileResult['annotations']> {
    return [...records]
        .map((record, index) => ({ record, index }))
        .sort((left, right) => {
            const byStart = left.record.span.start.offset - right.record.span.start.offset;
            if (byStart !== 0) return byStart;
            const byEnd = left.record.span.end.offset - right.record.span.end.offset;
            if (byEnd !== 0) return byEnd;
            const byKind = left.record.kind.localeCompare(right.record.kind);
            if (byKind !== 0) return byKind;
            const byForm = left.record.form.localeCompare(right.record.form);
            if (byForm !== 0) return byForm;
            const byRaw = left.record.raw.localeCompare(right.record.raw);
            if (byRaw !== 0) return byRaw;
            return left.index - right.index;
        })
        .map((entry) => entry.record);
}

function formatAnnotationLine(annotation: NonNullable<CompileResult['annotations']>[number]): string {
    const target = (() => {
        if (annotation.target.kind === 'path') {
            return annotation.target.path;
        }
        if (annotation.target.kind === 'span') {
            return `span(${formatSpan(annotation.target.span)})`;
        }
        return `unbound(${annotation.target.reason})`;
    })();
    const subtype = annotation.subtype ? `/${annotation.subtype}` : '';
    return `${annotation.kind}${subtype} ${annotation.form} -> ${target} raw=${JSON.stringify(annotation.raw)}`;
}

function formatSpan(span: unknown): string {
    if (!span || typeof span !== 'object') return '?:?-?:?';
    const start = (span as { start?: unknown }).start;
    const end = (span as { end?: unknown }).end;
    if (!start || !end || typeof start !== 'object' || typeof end !== 'object') return '?:?-?:?';
    const sl = (start as { line?: unknown }).line;
    const sc = (start as { column?: unknown }).column;
    const el = (end as { line?: unknown }).line;
    const ec = (end as { column?: unknown }).column;
    if ([sl, sc, el, ec].some(v => typeof v !== 'number')) return '?:?-?:?';
    return `${sl}:${sc}-${el}:${ec}`;
}

function formatErrorLine(error: AEONError): string {
    const code = (error as { code?: string }).code ?? 'UNKNOWN';
    const errPath = getErrorPath(error) ?? '$';
    const span = formatSpan((error as { span?: unknown }).span);
    const message = String(error.message).replace(/[\r\n]+/g, ' ');
    const phaseLabel = getPhaseLabel(error as { code?: string; phase?: unknown });
    const prefix = phaseLabel ? `${phaseLabel}: ` : '';
    return `${prefix}${message} [${code}] path=${errPath} span=${span}`;
}

function phaseNumberLabel(phase: number | undefined): string | undefined {
    switch (phase) {
        case 0:
            return 'Input Validation';
        case 5:
            return 'Profile Compilation';
        case 6:
            return 'Schema Validation';
        case 7:
            return 'Reference Resolution';
        case 8:
            return 'Finalization';
        default:
            return undefined;
    }
}

function inferPhaseLabelFromCode(code: string | undefined): string | undefined {
    switch (code) {
        case 'INPUT_SIZE_EXCEEDED':
            return 'Input Validation';
        case 'UNEXPECTED_CHARACTER':
        case 'UNTERMINATED_BLOCK_COMMENT':
        case 'UNTERMINATED_STRING':
        case 'UNTERMINATED_TRIMTICK':
            return 'Lexical Analysis';
        case 'SYNTAX_ERROR':
        case 'INVALID_DATE':
        case 'INVALID_TIME':
        case 'INVALID_DATETIME':
        case 'INVALID_SEPARATOR_CHAR':
        case 'SEPARATOR_DEPTH_EXCEEDED':
        case 'GENERIC_DEPTH_EXCEEDED':
            return 'Parsing';
        case 'HEADER_CONFLICT':
        case 'DUPLICATE_CANONICAL_PATH':
        case 'DATATYPE_LITERAL_MISMATCH':
            return 'Core Validation';
        case 'MISSING_REFERENCE_TARGET':
        case 'FORWARD_REFERENCE':
        case 'SELF_REFERENCE':
        case 'ATTRIBUTE_DEPTH_EXCEEDED':
            return 'Reference Validation';
        case 'UNTYPED_SWITCH_LITERAL':
        case 'UNTYPED_VALUE_IN_STRICT_MODE':
        case 'CUSTOM_SWITCH_ALIAS_NOT_ALLOWED':
        case 'CUSTOM_DATATYPE_NOT_ALLOWED':
        case 'INVALID_NODE_HEAD_DATATYPE':
            return 'Mode Enforcement';
        case 'PROFILE_NOT_FOUND':
        case 'PROFILE_PROCESSORS_SKIPPED':
            return 'Profile Compilation';
        case 'TYPE_GUARD_FAILED':
            return 'Finalization';
        default:
            return code?.startsWith('FINALIZE_') ? 'Finalization' : undefined;
    }
}

function getPhaseLabel(error: { code?: string; phase?: unknown }): string | undefined {
    const phase = typeof error.phase === 'number' ? error.phase : undefined;
    return phaseNumberLabel(phase) ?? inferPhaseLabelFromCode(error.code);
}

function formatEventLine(event: AssignmentEvent): string {
    const p = formatPath(event.path);
    const t = event.datatype ? ` :${event.datatype}` : '';
    return `${p}${t} = ${renderValue(event.value as unknown as Record<string, unknown>)}`;
}

function renderValue(value: Record<string, unknown>): string {
    const type = String(value.type);
    switch (type) {
        case 'StringLiteral':
            return JSON.stringify(String(value.value ?? ''));
        case 'InfinityLiteral':
            return String(value.raw ?? value.value ?? '');
        case 'NumberLiteral':
            return String(value.raw ?? value.value ?? '');
        case 'BooleanLiteral':
            return String(value.raw ?? value.value ?? '');
        case 'SwitchLiteral':
            return String(value.raw ?? value.value ?? '');
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
            return String(value.raw ?? value.value ?? '');
        case 'CloneReference':
            return `~${Array.isArray(value.path) ? (value.path as string[]).join('.') : ''}`;
        case 'PointerReference':
            return `~>${Array.isArray(value.path) ? (value.path as string[]).join('.') : ''}`;
        case 'ObjectNode': {
            const bindings = Array.isArray(value.bindings) ? (value.bindings as unknown[]) : [];
            const rendered = bindings
                .map(b => renderBindingInline(b as Record<string, unknown>))
                .filter(s => s.length > 0)
                .join(', ');
            return `{ ${rendered} }`;
        }
        case 'ListNode': {
            const elements = Array.isArray(value.elements) ? (value.elements as unknown[]) : [];
            const rendered = elements
                .map(e => renderValue(e as Record<string, unknown>))
                .join(', ');
            return `[ ${rendered} ]`;
        }
        default:
            return type;
    }
}

function renderBindingInline(binding: Record<string, unknown>): string {
    const key = typeof binding.key === 'string' ? binding.key : '';
    const datatype = binding.datatype && typeof binding.datatype === 'object' ? (binding.datatype as { name?: unknown }).name : null;
    const value = binding.value && typeof binding.value === 'object' ? (binding.value as Record<string, unknown>) : null;
    if (!key || !value) return '';
    const dt = typeof datatype === 'string' ? `:${datatype}` : '';
    return `${key}${dt} = ${renderValue(value)}`;
}


function getErrorPath(error: AEONError): string | undefined {
    const candidate = (error as unknown as { path?: unknown }).path;
    if (typeof candidate === 'string') {
        return candidate;
    }
    if (candidate && typeof candidate === 'object' && 'segments' in (candidate as Record<string, unknown>)) {
        return formatPath(candidate as Parameters<typeof formatPath>[0]);
    }
    return undefined;
}

function findReferences(events: readonly AssignmentEvent[]): string[] {
    const refs: string[] = [];
    for (const event of events) {
        const value = event.value;
        if (value.type === 'CloneReference') {
            refs.push(`${formatPath(event.path)} = ~${(value.path as string[]).join('.')}`);
        } else if (value.type === 'PointerReference') {
            refs.push(`${formatPath(event.path)} = ~>${(value.path as string[]).join('.')}`);
        }
    }
    return refs;
}
