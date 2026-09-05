// @ts-nocheck
// Kept behaviorally aligned with the published Telex v0 reference codec.
export const DEFAULT_TELEX_LIMITS = Object.freeze({
  maxInputBytes: 67_108_864,
  maxLineBytes: 1_048_576,
  maxFieldsPerEvent: 64,
  maxEvents: 100_000,
  maxDecodedPayloadBytes: 33_554_432,
  maxPathDepth: 1_024,
  maxPathCharacters: 8_192,
  maxGenericDepth: 1,
  maxGenericArguments: 32,
  maxClarifierValues: 1,
  maxDatatypeComponents: 64,
});

const NORMALIZED_DATATYPE_LIMITS = new WeakSet();

/**
 * Normalize the integer-only limits consumed by the Telex codec. Limits-file
 * inheritance and custom-null resolution belong to the trusted configuration
 * layer, before this function is called.
 */
export function normalizeTelexLimits(options = {}) {
  const source = options.limits ?? options;
  const legacyDatatype = options.datatypeLimits ?? {};
  return Object.freeze({
    maxInputBytes: limit(source, 'maxInputBytes', DEFAULT_TELEX_LIMITS.maxInputBytes),
    maxLineBytes: limit(source, 'maxLineBytes', DEFAULT_TELEX_LIMITS.maxLineBytes),
    maxFieldsPerEvent: limit(source, 'maxFieldsPerEvent', DEFAULT_TELEX_LIMITS.maxFieldsPerEvent),
    maxEvents: limit(source, 'maxEvents', DEFAULT_TELEX_LIMITS.maxEvents),
    maxDecodedPayloadBytes: limit(source, 'maxDecodedPayloadBytes', DEFAULT_TELEX_LIMITS.maxDecodedPayloadBytes),
    maxPathDepth: limit(source, 'maxPathDepth', DEFAULT_TELEX_LIMITS.maxPathDepth),
    maxPathCharacters: limit(source, 'maxPathCharacters', DEFAULT_TELEX_LIMITS.maxPathCharacters),
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
export function normalizeDatatypeLimits(options = {}) {
  if (options !== null && typeof options === 'object' && NORMALIZED_DATATYPE_LIMITS.has(options)) {
    return options;
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

function limit(source, name, fallback) {
  const value = source[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
