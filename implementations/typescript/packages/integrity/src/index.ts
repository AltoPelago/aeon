import { createHash, sign as signData, verify as verifyData, generateKeyPairSync } from 'node:crypto';
import type { AssignmentEvent } from '@aeon/aes';
import { formatPath } from '@aeon/aes';

type Value = AssignmentEvent['value'];
type ObjectValue = Extract<Value, { type: 'ObjectNode'; bindings: readonly unknown[] }>;
type Binding = ObjectValue['bindings'][number];
type EnvelopeDocumentLike = { bindings: readonly Binding[] };
type EnvelopeObjectLike = { bindings: readonly Binding[] };
const ENVELOPE_DATATYPE = 'envelope';

export interface CanonicalHashResult {
    readonly algorithm: string;
    readonly hash: string;
    readonly stream: string;
}

export interface CanonicalHashOptions {
    readonly algorithm?: 'sha-256' | 'sha-512';
}

export interface SignatureOptions {
    readonly algorithm?: 'ed25519' | 'rsa-sha256';
}

export interface SignatureResult {
    readonly algorithm: string;
    readonly signature: string;
}

export interface EnvelopeDiagnostic {
    readonly level: 'error' | 'warning';
    readonly message: string;
    readonly code?: string;
}

export interface EnvelopeValidationResult {
    readonly errors: readonly EnvelopeDiagnostic[];
    readonly warnings: readonly EnvelopeDiagnostic[];
}

export interface EnvelopeValidationOptions {
    readonly mode?: 'strict' | 'loose';
}

export interface CanonicalReceiptSource {
    readonly mediaType: string;
    readonly encoding: string;
    readonly digestAlgorithm: string;
    readonly digest: string;
}

export interface CanonicalReceiptCanonical {
    readonly format: string;
    readonly spec: string;
    readonly specRelease: string;
    readonly mode: string;
    readonly profile: string;
    readonly outputEncoding: string;
    readonly digestAlgorithm: string;
    readonly digest: string;
    readonly length: number;
    readonly payload?: string;
}

export interface CanonicalReceiptProducer {
    readonly implementation: string;
    readonly version: string;
    readonly build?: string;
}

export interface CanonicalReceiptGenerated {
    readonly at: string;
}

export interface CanonicalReceiptWitness {
    readonly implementation: string;
    readonly version: string;
    readonly digest: string;
}

export interface CanonicalReceipt {
    readonly source: CanonicalReceiptSource;
    readonly canonical: CanonicalReceiptCanonical;
    readonly producer: CanonicalReceiptProducer;
    readonly generated: CanonicalReceiptGenerated;
    readonly policyLevel?: 'basic' | 'auditable' | 'witnessed';
    readonly witnesses?: readonly CanonicalReceiptWitness[];
}

export interface BuildCanonicalReceiptOptions {
    readonly sourceMediaType?: string;
    readonly sourceEncoding?: string;
    readonly canonicalFormat?: string;
    readonly canonicalSpec?: string;
    readonly canonicalSpecRelease?: string;
    readonly canonicalMode?: string;
    readonly canonicalProfile?: string;
    readonly canonicalEncoding?: string;
    readonly canonicalHashAlgorithm?: 'sha-256' | 'sha-512';
    readonly sourceHashAlgorithm?: 'sha-256' | 'sha-512';
    readonly embedCanonicalPayload?: boolean;
    readonly producer: CanonicalReceiptProducer;
    readonly generatedAt?: string;
    readonly policyLevel?: 'basic' | 'auditable' | 'witnessed';
    readonly witnesses?: readonly CanonicalReceiptWitness[];
}

export interface CanonicalReceiptVerificationResult {
    readonly source: {
        readonly matches: boolean;
        readonly expected: string;
        readonly computed: string;
        readonly algorithm: string;
    };
    readonly canonical: {
        readonly matches: boolean;
        readonly expected: string;
        readonly computed: string;
        readonly algorithm: string;
        readonly payloadMatches: boolean | null;
        readonly length: number;
    };
    readonly replay: {
        readonly matches: boolean;
        readonly expected: string;
        readonly computed: string;
        readonly algorithm: string;
    };
}

export function serializeCanonicalEvents(events: readonly AssignmentEvent[]): string {
    const envelopeRoots = new Set(
        events
            .filter((event) => isEnvelopeEvent(event))
            .map((event) => formatPath(event.path))
    );
    const filtered = events.filter((event) => {
        const path = formatPath(event.path);
        for (const root of envelopeRoots) {
            if (path === root || path.startsWith(`${root}.`)) {
                return false;
            }
        }
        return true;
    });
    const ordered = [...filtered].sort((a, b) => formatPath(a.path).localeCompare(formatPath(b.path)));
    return ordered.map((event) => `${formatPath(event.path)}\t${serializeCanonicalValue(event.value)}\n`).join('');
}

export function computeCanonicalHash(
    events: readonly AssignmentEvent[],
    options: CanonicalHashOptions = {}
): CanonicalHashResult {
    const algorithm = options.algorithm ?? 'sha-256';
    const stream = serializeCanonicalEvents(events);
    const hash = createHash(algorithm).update(stream).digest('hex');
    return { algorithm, hash, stream };
}

function utf8ByteLength(value: string): number {
    return Buffer.byteLength(value, 'utf-8');
}

export function buildCanonicalReceipt(
    source: string | Uint8Array,
    events: readonly AssignmentEvent[],
    options: BuildCanonicalReceiptOptions
): CanonicalReceipt {
    const canonicalHash = computeCanonicalHash(events, { algorithm: options.canonicalHashAlgorithm ?? 'sha-256' });
    const sourceHash = computeByteHash(source, { algorithm: options.sourceHashAlgorithm ?? 'sha-256' });
    return {
        source: {
            mediaType: options.sourceMediaType ?? 'text/aeon',
            encoding: options.sourceEncoding ?? 'utf-8',
            digestAlgorithm: sourceHash.algorithm,
            digest: sourceHash.hash,
        },
        canonical: {
            format: options.canonicalFormat ?? 'aeon.canonical',
            spec: options.canonicalSpec ?? 'AEON Core',
            specRelease: options.canonicalSpecRelease ?? 'v1',
            mode: options.canonicalMode ?? 'strict',
            profile: options.canonicalProfile ?? 'core',
            outputEncoding: options.canonicalEncoding ?? 'utf-8',
            digestAlgorithm: canonicalHash.algorithm,
            digest: canonicalHash.hash,
            length: utf8ByteLength(canonicalHash.stream),
            ...(options.embedCanonicalPayload ?? true ? { payload: canonicalHash.stream } : {}),
        },
        producer: options.producer,
        generated: {
            at: options.generatedAt ?? new Date().toISOString(),
        },
        ...(options.policyLevel ? { policyLevel: options.policyLevel } : {}),
        ...(options.witnesses ? { witnesses: options.witnesses } : {}),
    };
}

export function verifyCanonicalReceipt(
    receipt: CanonicalReceipt,
    source: string | Uint8Array,
    events: readonly AssignmentEvent[]
): CanonicalReceiptVerificationResult {
    const sourceHash = computeByteHash(source, {
        algorithm: normalizeHashAlgorithm(receipt.source.digestAlgorithm),
    });
    const replayHash = computeCanonicalHash(events, {
        algorithm: normalizeHashAlgorithm(receipt.canonical.digestAlgorithm),
    });
    const payloadMatches = receipt.canonical.payload === undefined
        ? null
        : normalizeHash(computeByteHash(receipt.canonical.payload, {
            algorithm: normalizeHashAlgorithm(receipt.canonical.digestAlgorithm),
        }).hash) === normalizeHash(receipt.canonical.digest);
    return {
        source: {
            matches: normalizeHash(sourceHash.hash) === normalizeHash(receipt.source.digest),
            expected: receipt.source.digest,
            computed: sourceHash.hash,
            algorithm: sourceHash.algorithm,
        },
        canonical: {
            matches: payloadMatches ?? normalizeHash(replayHash.hash) === normalizeHash(receipt.canonical.digest),
            expected: receipt.canonical.digest,
            computed: receipt.canonical.payload === undefined
                ? replayHash.hash
                : computeByteHash(receipt.canonical.payload, {
                    algorithm: normalizeHashAlgorithm(receipt.canonical.digestAlgorithm),
                }).hash,
            algorithm: receipt.canonical.digestAlgorithm,
            payloadMatches,
            length: receipt.canonical.payload === undefined
                ? receipt.canonical.length
                : utf8ByteLength(receipt.canonical.payload),
        },
        replay: {
            matches: normalizeHash(replayHash.hash) === normalizeHash(receipt.canonical.digest),
            expected: receipt.canonical.digest,
            computed: replayHash.hash,
            algorithm: replayHash.algorithm,
        },
    };
}

export interface ByteHashResult {
    readonly algorithm: string;
    readonly hash: string;
}

export interface ByteHashOptions {
    readonly algorithm?: 'sha-256' | 'sha-512';
}

export function computeByteHash(
    input: string | Uint8Array,
    options: ByteHashOptions = {}
): ByteHashResult {
    const algorithm = options.algorithm ?? 'sha-256';
    const buffer = typeof input === 'string' ? Buffer.from(input, 'utf-8') : Buffer.from(input);
    const hash = createHash(algorithm).update(buffer).digest('hex');
    return { algorithm, hash };
}

export function verifyByteHash(
    input: string | Uint8Array,
    expectedHash: string,
    options: ByteHashOptions = {}
): boolean {
    const normalized = normalizeHash(expectedHash);
    const computed = computeByteHash(input, options).hash;
    return normalized === computed;
}

export function verifyCanonicalHash(
    events: readonly AssignmentEvent[],
    expectedHash: string,
    options: CanonicalHashOptions = {}
): boolean {
    const normalized = normalizeHash(expectedHash);
    const computed = computeCanonicalHash(events, options).hash;
    return normalized === computed;
}

export function signCanonicalStream(
    stream: string,
    privateKey: string | Buffer,
    options: SignatureOptions = {}
): SignatureResult {
    return signStringPayload(stream, privateKey, options);
}

export function signStringPayload(
    payload: string,
    privateKey: string | Buffer,
    options: SignatureOptions = {}
): SignatureResult {
    const algorithm = options.algorithm ?? 'ed25519';
    const data = Buffer.from(payload, 'utf-8');
    const signature = algorithm === 'ed25519'
        ? signData(null, data, privateKey)
        : signData('sha256', data, privateKey);
    return { algorithm, signature: signature.toString('hex') };
}

export function verifyCanonicalStreamSignature(
    stream: string,
    signatureHex: string,
    publicKey: string | Buffer,
    options: SignatureOptions = {}
): boolean {
    return verifyStringPayloadSignature(stream, signatureHex, publicKey, options);
}

export function verifyStringPayloadSignature(
    payload: string,
    signatureHex: string,
    publicKey: string | Buffer,
    options: SignatureOptions = {}
): boolean {
    const algorithm = options.algorithm ?? 'ed25519';
    const data = Buffer.from(payload, 'utf-8');
    const signature = Buffer.from(signatureHex, 'hex');
    return algorithm === 'ed25519'
        ? verifyData(null, data, publicKey, signature)
        : verifyData('sha256', data, publicKey, signature);
}

export function generateEd25519KeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
}

export function validateEnvelopeDocument(
    document: EnvelopeDocumentLike,
    options: EnvelopeValidationOptions = {}
): EnvelopeValidationResult {
    const strict = (options.mode ?? 'strict') === 'strict';
    const errors: EnvelopeDiagnostic[] = [];
    const warnings: EnvelopeDiagnostic[] = [];
    const bindings = document.bindings;

    const envelopeIndex = bindings.findIndex((binding) => isEnvelopeBinding(binding));
    if (envelopeIndex === -1) {
        return { errors, warnings };
    }

    if (envelopeIndex !== bindings.length - 1) {
        errors.push({
            level: 'error',
            message: 'envelope binding must be the final binding in the document',
            code: 'ENVELOPE_NOT_LAST',
        });
    }

    const envelopeBinding = bindings[envelopeIndex]!;
    if (envelopeBinding.value.type !== 'ObjectNode') {
        errors.push({
            level: 'error',
            message: 'envelope binding must be an object',
            code: 'ENVELOPE_NOT_OBJECT',
        });
        return { errors, warnings };
    }

    const unknownKeys = collectUnknownEnvelopeKeys(envelopeBinding.value);
    if (unknownKeys.length > 0) {
        const diag: EnvelopeDiagnostic = {
            level: strict ? 'error' : 'warning',
            message: `Unknown envelope fields: ${unknownKeys.join(', ')}`,
            code: 'ENVELOPE_UNKNOWN_FIELD',
        };
        if (strict) errors.push(diag);
        else warnings.push(diag);
    }

    return { errors, warnings };
}

export function validateEnvelopeEvents(
    events: readonly AssignmentEvent[],
    options: EnvelopeValidationOptions = {}
): EnvelopeValidationResult {
    const strict = (options.mode ?? 'strict') === 'strict';
    const errors: EnvelopeDiagnostic[] = [];
    const warnings: EnvelopeDiagnostic[] = [];

    const topLevelEvents = events.filter((event) => isTopLevelPath(event.path));
    const envelopeIndex = topLevelEvents.findIndex((event) => isEnvelopeEvent(event));
    if (envelopeIndex === -1) {
        return { errors, warnings };
    }

    if (envelopeIndex !== topLevelEvents.length - 1) {
        errors.push({
            level: 'error',
            message: 'envelope binding must be the final binding in the document',
            code: 'ENVELOPE_NOT_LAST',
        });
    }

    const envelopeEvent = topLevelEvents[envelopeIndex]!;
    if (envelopeEvent.value.type !== 'ObjectNode') {
        errors.push({
            level: 'error',
            message: 'envelope binding must be an object',
            code: 'ENVELOPE_NOT_OBJECT',
        });
        return { errors, warnings };
    }

    const unknownKeys = collectUnknownEnvelopeKeys(envelopeEvent.value);
    if (unknownKeys.length > 0) {
        const diag: EnvelopeDiagnostic = {
            level: strict ? 'error' : 'warning',
            message: `Unknown envelope fields: ${unknownKeys.join(', ')}`,
            code: 'ENVELOPE_UNKNOWN_FIELD',
        };
        if (strict) errors.push(diag);
        else warnings.push(diag);
    }

    return { errors, warnings };
}

export function serializeCanonicalValue(value: Value): string {
    switch (value.type) {
        case 'StringLiteral':
            return `"${escapeString(value.value)}"`;
        case 'NumberLiteral':
            return normalizeNumber(value.raw);
        case 'InfinityLiteral':
            return `"${escapeString(value.raw)}"`;
        case 'BooleanLiteral':
            return value.value ? 'true' : 'false';
        case 'SwitchLiteral':
            return `"${escapeString(value.raw)}"`;
        case 'HexLiteral':
            return `"#${value.value.replace(/_/g, '').toLowerCase()}"`;
        case 'RadixLiteral':
            return `"%${value.value.replace(/_/g, '')}"`;
        case 'EncodingLiteral':
            return `"$${value.value}"`;
        case 'SeparatorLiteral':
            return `"${escapeString(value.raw)}"`;
        case 'DateLiteral':
        case 'DateTimeLiteral':
            return `"${escapeString(value.raw)}"`;
        case 'CloneReference':
            return `"~${value.path.join('.')}"`;
        case 'PointerReference':
            return `"~>${value.path.join('.')}"`;
        case 'ObjectNode':
            return serializeObject(value.bindings);
        case 'ListNode':
            return serializeArray(value.elements);
        default:
            return 'null';
    }
}

function serializeObject(bindings: readonly Binding[]): string {
    const entries = [...bindings].sort((a, b) => a.key.localeCompare(b.key));
    const rendered = entries.map((binding) => `${escapeKey(binding.key)}:${serializeCanonicalValue(binding.value)}`);
    return `{${rendered.join(',')}}`;
}

function serializeArray(elements: readonly Value[]): string {
    const rendered = elements.map((value) => serializeCanonicalValue(value));
    return `[${rendered.join(',')}]`;
}

function escapeString(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        switch (ch) {
            case '"':
                out += '\\"';
                break;
            case '\\':
                out += '\\\\';
                break;
            case '\n':
                out += '\\n';
                break;
            case '\r':
                out += '\\r';
                break;
            case '\t':
                out += '\\t';
                break;
            default: {
                const code = ch.charCodeAt(0);
                if (code < 0x20) {
                    out += `\\u${code.toString(16).padStart(4, '0')}`;
                } else {
                    out += ch;
                }
                break;
            }
        }
    }
    return out;
}

function escapeKey(value: string): string {
    return `"${escapeString(value)}"`;
}

function collectUnknownEnvelopeKeys(node: EnvelopeObjectLike): string[] {
    const keys: string[] = [];
    for (const binding of node.bindings) {
        const typedKey = binding.datatype ? `${binding.key}:${binding.datatype.name}` : binding.key;
        switch (binding.key) {
            case 'canonical_hash_alg':
            case 'canonical_hash':
            case 'bytes_hash_alg':
            case 'bytes_hash':
            case 'checksum_alg':
            case 'checksum_value':
            case 'sig':
            case 'canonical':
            case 'bytes':
            case 'checksum':
                continue;
            case 'integrity':
                if (binding.value.type !== 'ObjectNode') {
                    keys.push(typedKey);
                    continue;
                }
                keys.push(...collectUnknownSectionKeys(binding.value, new Set([
                    'alg',
                    'hash',
                    'bytes_hash_alg',
                    'bytes_hash',
                    'checksum_alg',
                    'checksum_value',
                    'canonical_hash_alg',
                    'canonical_hash',
                ]), typedKey));
                continue;
            case 'signatures':
                if (binding.value.type !== 'ListNode') {
                    keys.push(typedKey);
                    continue;
                }
                keys.push(...collectUnknownSignatureKeys(binding.value, typedKey));
                continue;
            case 'encryption':
                if (binding.value.type !== 'ObjectNode') {
                    keys.push(typedKey);
                    continue;
                }
                keys.push(...collectUnknownSectionKeys(binding.value, new Set([
                    'alg',
                    'kid',
                    'ciphertext',
                    'nonce',
                    'tag',
                    'epk',
                ]), typedKey));
                continue;
            default:
                keys.push(typedKey);
        }
    }
    return keys;
}

function collectUnknownSectionKeys(node: EnvelopeObjectLike, allowed: Set<string>, section: string): string[] {
    const keys: string[] = [];
    for (const binding of node.bindings) {
        const typedKey = binding.datatype ? `${binding.key}:${binding.datatype.name}` : binding.key;
        if (!allowed.has(binding.key) && !allowed.has(typedKey)) {
            keys.push(`${section}.${typedKey}`);
        }
    }
    return keys;
}

function collectUnknownSignatureKeys(value: Extract<Value, { type: 'ListNode'; elements: readonly Value[] }>, section: string): string[] {
    const keys: string[] = [];
    for (let index = 0; index < value.elements.length; index++) {
        const element = value.elements[index]!;
        if (element.type !== 'ObjectNode') {
            keys.push(`${section}[${index}]`);
            continue;
        }
        keys.push(...collectUnknownSectionKeys(element, new Set(['alg', 'kid', 'sig']), `${section}[${index}]`));
    }
    return keys;
}

function isEnvelopeBinding(binding: { datatype?: { name: string } | null }): boolean {
    return datatypeBase(binding.datatype?.name) === ENVELOPE_DATATYPE;
}

function isEnvelopeEvent(event: AssignmentEvent): boolean {
    return datatypeBase(event.datatype) === ENVELOPE_DATATYPE;
}

function datatypeBase(datatype: string | null | undefined): string | null {
    if (!datatype) return null;
    const genericIdx = datatype.indexOf('<');
    const separatorIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, separatorIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx).toLowerCase();
}

function isTopLevelPath(path: AssignmentEvent['path']): boolean {
    return path.segments.length === 2
        && path.segments[0]?.type === 'root'
        && path.segments[1]?.type === 'member';
}

function normalizeHash(hash: string): string {
    return hash.trim().replace(/^#/, '').toLowerCase();
}

function normalizeHashAlgorithm(algorithm: string): 'sha-256' | 'sha-512' {
    const normalized = algorithm.trim().toLowerCase();
    if (normalized === 'sha-512' || normalized === 'sha512') {
        return 'sha-512';
    }
    return 'sha-256';
}

function normalizeNumber(raw: string): string {
    let value = raw.replace(/_/g, '').replace(/E/g, 'e').replace(/^\+/, '');
    const negative = value.startsWith('-');
    if (negative) value = value.slice(1);

    const [mantissaRaw, expRaw] = value.split('e');
    let mantissa = mantissaRaw ?? '0';
    let exponent = expRaw ? parseInt(expRaw, 10) : 0;
    if (Number.isNaN(exponent)) exponent = 0;

    let [intPart, fracPart] = mantissa.split('.');
    intPart = (intPart ?? '0').replace(/^0+/, '') || '0';
    fracPart = trimTrailingZeros(fracPart ?? '');

    const digits = `${intPart}${fracPart}`;
    let decimalIndex = intPart.length + exponent;

    if (digits.replace(/0/g, '').length === 0) {
        return '0';
    }

    if (decimalIndex <= 0) {
        const zeros = '0'.repeat(Math.abs(decimalIndex));
        return trimTrailingDotAndZeros(`${negative ? '-' : ''}0.${zeros}${digits}`);
    }
    if (decimalIndex >= digits.length) {
        const zeros = '0'.repeat(decimalIndex - digits.length);
        return `${negative ? '-' : ''}${digits}${zeros}`;
    }

    const left = digits.slice(0, decimalIndex);
    const right = trimTrailingZeros(digits.slice(decimalIndex));
    const normalized = right.length > 0 ? `${left}.${right}` : left;
    return `${negative ? '-' : ''}${normalized}`;
}

function trimTrailingZeros(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '0') {
        end -= 1;
    }
    return value.slice(0, end);
}

function trimTrailingDotAndZeros(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '0') {
        end -= 1;
    }
    if (end > 0 && value[end - 1] === '.') {
        end -= 1;
    }
    return value.slice(0, end);
}
