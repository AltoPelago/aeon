import { tokenize } from '@altopelago/aeon-lexer';
import { parse, type Binding, type Value } from '@altopelago/aeon-parser';

export const AEONIC_LIMITS_ID = 'altopelago.aeonic-limits.v1';
export const AEONIC_LIMITS_VERSION = '1.0.0';

export const LIMITS_BOOTSTRAP = Object.freeze({
    maxInputBytes: 65_536,
    maxEvents: 256,
    maxPathDepth: 8,
    maxValueNestingDepth: 8,
    maxAttributeDepth: 0,
    maxGenericDepth: 0,
    maxGenericArguments: 0,
    maxClarifierValues: 0,
    maxDatatypeComponents: 1,
});

export type LimitSetting = number | 'unBound' | 'useImplementation';

export interface AeonicLimitsV1 {
    readonly limitsId: typeof AEONIC_LIMITS_ID;
    readonly limitsVersion: typeof AEONIC_LIMITS_VERSION;
    readonly profileClaims: readonly string[];
    readonly structure: Readonly<{
        maxAttributeDepth: LimitSetting;
        maxGenericDepth: LimitSetting;
        maxGenericArguments: LimitSetting;
        maxClarifierValues: LimitSetting;
        maxDatatypeComponents: LimitSetting;
        maxValueNestingDepth: LimitSetting;
        maxPathDepth: LimitSetting;
        maxStringCodepoints: LimitSetting;
        maxKeySegmentCodepoints: LimitSetting;
        maxListItems: LimitSetting;
        maxTupleItems: LimitSetting;
        maxPathCharacters: LimitSetting;
    }>;
    readonly processing: Readonly<{
        maxEvents: LimitSetting;
        maxReferenceDepth: LimitSetting;
        maxMaterializedWeight: LimitSetting;
    }>;
    readonly formats: Readonly<{
        aeon: Readonly<{
            maxInputBytes: LimitSetting;
            maxNumericLiteralCharacters: LimitSetting;
            maxStructuredCommentCharacters: LimitSetting;
        }>;
        telex: Readonly<{
            maxInputBytes: LimitSetting;
            maxLineBytes: LimitSetting;
            maxFieldsPerEvent: LimitSetting;
            maxDecodedPayloadBytes: LimitSetting;
        }>;
    }>;
    readonly transport: Readonly<{
        maxFrameBytes: LimitSetting;
        maxBufferBytes: LimitSetting;
        maxHeaderBytes: LimitSetting;
    }>;
}

export interface LimitsDiagnostic {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}

export interface AeonCompileLimits {
    readonly maxAttributeDepth: number;
    readonly maxClarifierValues: number;
    readonly maxGenericDepth: number;
    readonly maxGenericArguments: number;
    readonly maxDatatypeComponents: number;
    readonly maxValueNestingDepth: number;
    readonly maxPathDepth: number;
    readonly maxStringCodepoints: number;
    readonly maxKeySegmentCodepoints: number;
    readonly maxListItems: number;
    readonly maxTupleItems: number;
    readonly maxPathCharacters: number;
    readonly maxNumericLiteralCharacters: number;
    readonly maxStructuredCommentCharacters: number;
    readonly maxInputBytes?: number;
    readonly maxEvents?: number;
}

export type AeonicLimitsLoadResult =
    | { readonly limits: AeonicLimitsV1; readonly errors: readonly [] }
    | { readonly limits: null; readonly errors: readonly LimitsDiagnostic[] };

type Decoded = string | number | LimitSetting | readonly Decoded[] | { readonly [key: string]: Decoded };

export function loadAeonicLimits(input: string): AeonicLimitsLoadResult {
    const errors: LimitsDiagnostic[] = [];
    const actualBytes = Buffer.byteLength(input, 'utf8');
    if (actualBytes > LIMITS_BOOTSTRAP.maxInputBytes) {
        return failure('LIMITS_BOOTSTRAP_EXCEEDED', '$', `Limits input size ${actualBytes} exceeds bootstrap limit ${LIMITS_BOOTSTRAP.maxInputBytes}`);
    }

    const lexed = tokenize(input, { includeComments: false });
    if (lexed.errors.length > 0) {
        return { limits: null, errors: lexed.errors.map((error) => ({ code: error.code, path: '$', message: error.message })) };
    }
    const parsed = parse(lexed.tokens, {
        maxAttributeDepth: LIMITS_BOOTSTRAP.maxAttributeDepth,
        maxClarifierValues: LIMITS_BOOTSTRAP.maxClarifierValues,
        maxGenericDepth: LIMITS_BOOTSTRAP.maxGenericDepth,
        maxGenericArguments: LIMITS_BOOTSTRAP.maxGenericArguments,
        maxDatatypeComponents: LIMITS_BOOTSTRAP.maxDatatypeComponents,
        maxValueNestingDepth: LIMITS_BOOTSTRAP.maxValueNestingDepth,
    });
    if (parsed.errors.length > 0 || !parsed.document) {
        return {
            limits: null,
            errors: parsed.errors.map((error) => ({ code: error.code, path: '$', message: error.message })),
        };
    }
    if (parsed.document.header) {
        return failure('LIMITS_HEADER_NOT_ALLOWED', '$', 'Limits files must not contain an AEON header');
    }
    const eventCount = parsed.document.bindings.reduce((count, binding) => count + projectedEventCount(binding.value), 0);
    if (eventCount > LIMITS_BOOTSTRAP.maxEvents) {
        return failure('LIMITS_BOOTSTRAP_EXCEEDED', '$', `Limits file projects ${eventCount} events; bootstrap limit is ${LIMITS_BOOTSTRAP.maxEvents}`);
    }

    const decoded: Record<string, Decoded> = {};
    for (const binding of parsed.document.bindings) {
        const value = decodeBinding(binding, `$.${binding.key}`, errors);
        if (value !== undefined) decoded[binding.key] = value;
    }
    if (errors.length > 0) return { limits: null, errors };

    try {
        const limits = validateLimits(decoded);
        return { limits, errors: [] };
    } catch (error) {
        return failure('INVALID_LIMITS_FILE', '$', error instanceof Error ? error.message : String(error));
    }
}

/** Resolve the AEON Core subset into an inspectable, language-native view. */
export function aeonCompileLimits(limits: AeonicLimitsV1): AeonCompileLimits {
    return {
        maxAttributeDepth: bounded(limits.structure.maxAttributeDepth, 1, 64, 'max_attribute_depth'),
        maxClarifierValues: bounded(limits.structure.maxClarifierValues, 1, 4_096, 'max_clarifier_values'),
        maxGenericDepth: bounded(limits.structure.maxGenericDepth, 1, 64, 'max_generic_depth'),
        maxGenericArguments: bounded(limits.structure.maxGenericArguments, 32, 4_096, 'max_generic_arguments'),
        maxDatatypeComponents: bounded(limits.structure.maxDatatypeComponents, 64, 4_096, 'max_datatype_components'),
        maxValueNestingDepth: bounded(limits.structure.maxValueNestingDepth, 256, 512, 'max_value_nesting_depth'),
        maxPathDepth: bounded(limits.structure.maxPathDepth, 1024, 4096, 'max_path_depth'),
        maxStringCodepoints: bounded(limits.structure.maxStringCodepoints, 1_048_576, 16_777_216, 'max_string_codepoints'),
        maxKeySegmentCodepoints: bounded(limits.structure.maxKeySegmentCodepoints, 1024, 65_536, 'max_key_segment_codepoints'),
        maxListItems: bounded(limits.structure.maxListItems, 65_536, 1_000_000, 'max_list_items'),
        maxTupleItems: bounded(limits.structure.maxTupleItems, 65_536, 1_000_000, 'max_tuple_items'),
        maxPathCharacters: bounded(limits.structure.maxPathCharacters, 8192, 65_536, 'max_path_characters'),
        maxNumericLiteralCharacters: bounded(limits.formats.aeon.maxNumericLiteralCharacters, 1024, 65_536, 'max_numeric_literal_characters'),
        maxStructuredCommentCharacters: bounded(limits.formats.aeon.maxStructuredCommentCharacters, 1_048_576, 16_777_216, 'max_structured_comment_characters'),
        ...optional(limits.formats.aeon.maxInputBytes, 16_777_216, 'maxInputBytes'),
        ...optional(limits.processing.maxEvents, 100_000, 'maxEvents'),
    };
}

function bounded(setting: LimitSetting, implementationDefault: number, hardCeiling: number, name: string): number {
    if (setting === 'useImplementation') return implementationDefault;
    if (setting === 'unBound') return hardCeiling;
    if (setting > hardCeiling) throw new Error(`${name} ${setting} exceeds implementation safety ceiling ${hardCeiling}`);
    return setting;
}

function optional(setting: LimitSetting, implementationDefault: number, key: 'maxInputBytes' | 'maxEvents'): Partial<AeonCompileLimits> {
    if (setting === 'unBound') return {};
    return { [key]: setting === 'useImplementation' ? implementationDefault : setting };
}

function decodeBinding(binding: Binding, path: string, errors: LimitsDiagnostic[]): Decoded | undefined {
    if (binding.datatype || binding.attributes.length > 0 || binding.structuralId) {
        errors.push({ code: 'LIMITS_DECORATION_NOT_ALLOWED', path, message: 'Limits bindings may not use datatypes, attributes, or structural identities' });
        return undefined;
    }
    return decodeValue(binding.value, path, errors);
}

function decodeValue(value: Value, path: string, errors: LimitsDiagnostic[]): Decoded | undefined {
    switch (value.type) {
        case 'StringLiteral':
            return value.value;
        case 'NumberLiteral': {
            const parsed = Number(value.value.replaceAll('_', ''));
            if (!Number.isSafeInteger(parsed) || parsed < 0) {
                errors.push({ code: 'INVALID_LIMIT_VALUE', path, message: 'Limit values must be non-negative safe integers' });
                return undefined;
            }
            return parsed;
        }
        case 'NullLiteral':
            if (value.mode === 'reason' && (value.value === 'unBound' || value.value === 'useImplementation')) {
                return value.value;
            }
            errors.push({ code: 'INVALID_LIMIT_VALUE', path, message: 'Only !"unBound" and !"useImplementation" are valid limit sentinels' });
            return undefined;
        case 'ListNode':
            return value.elements.map((item, index) => decodeValue(item, `${path}[${index}]`, errors) as Decoded);
        case 'ObjectNode': {
            const object: Record<string, Decoded> = {};
            for (const binding of value.bindings) {
                const child = decodeBinding(binding, `${path}.${binding.key}`, errors);
                if (child !== undefined) object[binding.key] = child;
            }
            return object;
        }
        default:
            errors.push({ code: 'INVALID_LIMIT_VALUE', path, message: `Unsupported limits value ${value.type}` });
            return undefined;
    }
}

function projectedEventCount(value: Value): number {
    switch (value.type) {
        case 'ObjectNode':
            return 1 + value.bindings.reduce((count, binding) => count + projectedEventCount(binding.value), 0);
        case 'ListNode':
        case 'TupleLiteral':
            return 1 + value.elements.reduce((count, item) => count + projectedEventCount(item), 0);
        default:
            return 1;
    }
}

function validateLimits(root: Record<string, Decoded>): AeonicLimitsV1 {
    assertKeys(root, '$', ['limits_id', 'limits_version', 'profile_claims', 'structure', 'processing', 'formats', 'transport']);
    const limitsId = requiredString(root, 'limits_id', '$');
    const limitsVersion = requiredString(root, 'limits_version', '$');
    if (limitsId !== AEONIC_LIMITS_ID) throw new Error(`Unsupported limits_id ${JSON.stringify(limitsId)}`);
    if (limitsVersion !== AEONIC_LIMITS_VERSION) throw new Error(`Unsupported limits_version ${JSON.stringify(limitsVersion)}`);
    const profileClaims = requiredArray(root, 'profile_claims', '$').map((value, index) => {
        if (typeof value !== 'string') throw new Error(`$.profile_claims[${index}] must be a string`);
        return value;
    });
    const structure = requiredObject(root, 'structure', '$');
    const processing = requiredObject(root, 'processing', '$');
    const formats = requiredObject(root, 'formats', '$');
    const aeon = requiredObject(formats, 'aeon', '$.formats');
    const telex = requiredObject(formats, 'telex', '$.formats');
    const transport = requiredObject(root, 'transport', '$');

    return {
        limitsId: AEONIC_LIMITS_ID,
        limitsVersion: AEONIC_LIMITS_VERSION,
        profileClaims,
        structure: settings(structure, '$.structure', ['max_attribute_depth', 'max_generic_depth', 'max_generic_arguments', 'max_clarifier_values', 'max_datatype_components', 'max_value_nesting_depth', 'max_path_depth', 'max_string_codepoints', 'max_key_segment_codepoints', 'max_list_items', 'max_tuple_items', 'max_path_characters'], ['maxAttributeDepth', 'maxGenericDepth', 'maxGenericArguments', 'maxClarifierValues', 'maxDatatypeComponents', 'maxValueNestingDepth', 'maxPathDepth', 'maxStringCodepoints', 'maxKeySegmentCodepoints', 'maxListItems', 'maxTupleItems', 'maxPathCharacters']),
        processing: settings(processing, '$.processing', ['max_events', 'max_reference_depth', 'max_materialized_weight'], ['maxEvents', 'maxReferenceDepth', 'maxMaterializedWeight']),
        formats: {
            aeon: settings(aeon, '$.formats.aeon', ['max_input_bytes', 'max_numeric_literal_characters', 'max_structured_comment_characters'], ['maxInputBytes', 'maxNumericLiteralCharacters', 'maxStructuredCommentCharacters']),
            telex: settings(telex, '$.formats.telex', ['max_input_bytes', 'max_line_bytes', 'max_fields_per_event', 'max_decoded_payload_bytes'], ['maxInputBytes', 'maxLineBytes', 'maxFieldsPerEvent', 'maxDecodedPayloadBytes']),
        },
        transport: settings(transport, '$.transport', ['max_frame_bytes', 'max_buffer_bytes', 'max_header_bytes'], ['maxFrameBytes', 'maxBufferBytes', 'maxHeaderBytes']),
    } as AeonicLimitsV1;
}

function settings<T extends string>(object: Record<string, Decoded>, path: string, sourceKeys: readonly string[], targetKeys: readonly T[]): Record<T, LimitSetting> {
    assertKeys(object, path, sourceKeys);
    const result = {} as Record<T, LimitSetting>;
    sourceKeys.forEach((key, index) => { result[targetKeys[index]!] = requiredSetting(object, key, path); });
    return result;
}

function assertKeys(object: Record<string, Decoded>, path: string, expected: readonly string[]): void {
    const actual = Object.keys(object);
    for (const key of actual) if (!expected.includes(key)) throw new Error(`Unknown field ${path}.${key}`);
    for (const key of expected) if (!(key in object)) throw new Error(`Missing field ${path}.${key}`);
}

function requiredString(object: Record<string, Decoded>, key: string, path: string): string {
    const value = object[key];
    if (typeof value !== 'string') throw new Error(`${path}.${key} must be a string`);
    return value;
}

function requiredSetting(object: Record<string, Decoded>, key: string, path: string): LimitSetting {
    const value = object[key];
    if (typeof value === 'number' || value === 'unBound' || value === 'useImplementation') return value;
    throw new Error(`${path}.${key} must be a non-negative integer, !"unBound", or !"useImplementation"`);
}

function requiredObject(object: Record<string, Decoded>, key: string, path: string): Record<string, Decoded> {
    const value = object[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}.${key} must be an object`);
    return value as Record<string, Decoded>;
}

function requiredArray(object: Record<string, Decoded>, key: string, path: string): readonly Decoded[] {
    const value = object[key];
    if (!Array.isArray(value)) throw new Error(`${path}.${key} must be a list`);
    return value;
}

function failure(code: string, path: string, message: string): AeonicLimitsLoadResult {
    return { limits: null, errors: [{ code, path, message }] };
}
