// Kept behaviorally aligned with the published Telex v1 reference codec.
import type { TelexLimitOptions, TelexLimits } from './telex.js';

type DatatypeLimits = Pick<
  TelexLimits,
  'maxGenericDepth' | 'maxGenericArguments' | 'maxClarifierValues' | 'maxDatatypeComponents'
>;
type LimitSource = Partial<Readonly<Record<keyof TelexLimits, number>>>;
interface DatatypeLimitOptions extends TelexLimitOptions {
  readonly maxDepth?: number;
  readonly maxItems?: number;
}

export const DEFAULT_TELEX_LIMITS = Object.freeze({
  maxInputBytes: 67_108_864,
  maxLineBytes: 1_048_576,
  maxFieldsPerEvent: 64,
  maxEvents: 100_000,
  maxDecodedPayloadBytes: 33_554_432,
  maxPathDepth: 1_024,
  maxPathCharacters: 8_192,
  maxAttributeDepth: 1,
  maxValueNestingDepth: 256,
  maxStringCodepoints: 1_048_576,
  maxKeySegmentCodepoints: 1_024,
  maxListItems: 65_536,
  maxTupleItems: 65_536,
  maxGenericDepth: 1,
  maxGenericArguments: 32,
  maxClarifierValues: 1,
  maxDatatypeComponents: 64,
}) satisfies Readonly<TelexLimits>;

const NORMALIZED_DATATYPE_LIMITS = new WeakSet<object>();

/**
 * Normalize the integer-only limits consumed by the Telex codec. Limits-file
 * inheritance and custom-null resolution belong to the trusted configuration
 * layer, before this function is called.
 */
export function normalizeTelexLimits(options: TelexLimitOptions = {}): Readonly<TelexLimits> {
  const source: LimitSource = options.limits ?? options;
  const legacyDatatype = options.datatypeLimits ?? {};
  return Object.freeze({
    maxInputBytes: limit(source, 'maxInputBytes', DEFAULT_TELEX_LIMITS.maxInputBytes),
    maxLineBytes: limit(source, 'maxLineBytes', DEFAULT_TELEX_LIMITS.maxLineBytes),
    maxFieldsPerEvent: limit(source, 'maxFieldsPerEvent', DEFAULT_TELEX_LIMITS.maxFieldsPerEvent),
    maxEvents: limit(source, 'maxEvents', DEFAULT_TELEX_LIMITS.maxEvents),
    maxDecodedPayloadBytes: limit(source, 'maxDecodedPayloadBytes', DEFAULT_TELEX_LIMITS.maxDecodedPayloadBytes),
    maxPathDepth: limit(source, 'maxPathDepth', DEFAULT_TELEX_LIMITS.maxPathDepth),
    maxPathCharacters: limit(source, 'maxPathCharacters', DEFAULT_TELEX_LIMITS.maxPathCharacters),
    maxAttributeDepth: limit(source, 'maxAttributeDepth', DEFAULT_TELEX_LIMITS.maxAttributeDepth),
    maxValueNestingDepth: limit(source, 'maxValueNestingDepth', DEFAULT_TELEX_LIMITS.maxValueNestingDepth),
    maxStringCodepoints: limit(source, 'maxStringCodepoints', DEFAULT_TELEX_LIMITS.maxStringCodepoints),
    maxKeySegmentCodepoints: limit(source, 'maxKeySegmentCodepoints', DEFAULT_TELEX_LIMITS.maxKeySegmentCodepoints),
    maxListItems: limit(source, 'maxListItems', DEFAULT_TELEX_LIMITS.maxListItems),
    maxTupleItems: limit(source, 'maxTupleItems', DEFAULT_TELEX_LIMITS.maxTupleItems),
    maxGenericDepth: limit(
      source,
      'maxGenericDepth',
      legacyDatatype.maxGenericDepth ?? legacyDatatype.maxDepth ?? DEFAULT_TELEX_LIMITS.maxGenericDepth,
    ),
    maxGenericArguments: limit(
      source,
      'maxGenericArguments',
      legacyDatatype.maxGenericArguments ?? DEFAULT_TELEX_LIMITS.maxGenericArguments,
    ),
    maxClarifierValues: limit(
      source,
      'maxClarifierValues',
      legacyDatatype.maxClarifierValues ?? DEFAULT_TELEX_LIMITS.maxClarifierValues,
    ),
    maxDatatypeComponents: limit(
      source,
      'maxDatatypeComponents',
      legacyDatatype.maxDatatypeComponents ?? legacyDatatype.maxItems ?? DEFAULT_TELEX_LIMITS.maxDatatypeComponents,
    ),
  });
}

/** Normalize the datatype-only helper surface, including its v0 aliases. */
export function normalizeDatatypeLimits(options: DatatypeLimitOptions = {}): Readonly<DatatypeLimits> {
  if (options !== null && typeof options === 'object' && NORMALIZED_DATATYPE_LIMITS.has(options)) {
    return options as Readonly<DatatypeLimits>;
  }
  const normalized = Object.freeze({
    maxGenericDepth: limit(options, 'maxGenericDepth', options.maxDepth ?? DEFAULT_TELEX_LIMITS.maxGenericDepth),
    maxGenericArguments: limit(options, 'maxGenericArguments', DEFAULT_TELEX_LIMITS.maxGenericArguments),
    maxClarifierValues: limit(options, 'maxClarifierValues', DEFAULT_TELEX_LIMITS.maxClarifierValues),
    maxDatatypeComponents: limit(
      options,
      'maxDatatypeComponents',
      options.maxItems ?? DEFAULT_TELEX_LIMITS.maxDatatypeComponents,
    ),
  });
  NORMALIZED_DATATYPE_LIMITS.add(normalized);
  return normalized;
}

function limit(source: LimitSource, name: keyof TelexLimits, fallback: number): number {
  const value = source[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
