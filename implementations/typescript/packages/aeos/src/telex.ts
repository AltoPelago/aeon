import {
    parseTelex,
    validateTelexRecords,
    type TelexLimitOptions,
    type TelexSyntaxError,
} from '@altopelago/aeon-aes';
import { createDiag } from './diag/emit.js';
import { createFailingEnvelope, type ResultEnvelope } from './types/envelope.js';
import type { SchemaV1 } from './types/schema.js';
import type { PortableAesBodyEvent } from './types/aes.js';
import { validate, type ValidateOptions } from './validate.js';

export interface ValidateTelexOptions extends ValidateOptions, TelexLimitOptions {
    readonly registeredFields?: readonly string[];
}

/**
 * Decode and validate a Telex stream before applying an AEOS schema to its
 * body records. Header-plane records are transport metadata and are not schema
 * bindings.
 */
export function validateTelex(
    input: string,
    schema: SchemaV1,
    options: ValidateTelexOptions = {},
): ResultEnvelope {
    let parsed;
    try {
        parsed = parseTelex(input, options);
    } catch (error) {
        const syntax = error as TelexSyntaxError;
        return createFailingEnvelope([
            createDiag('$', null, syntax.message, syntax.code ?? 'TELEX_SYNTAX_ERROR'),
        ]);
    }

    const portable = validateTelexRecords(parsed.records, {
        ...options,
        profile: parsed.profile,
        projection: parsed.projection,
    });
    if (!portable.valid) {
        return createFailingEnvelope(portable.diagnostics.map((diagnostic) => createDiag(
            diagnostic.path ?? '$',
            null,
            diagnostic.message,
            diagnostic.code,
        )));
    }

    return validate(
        parsed.records.filter((record): record is PortableAesBodyEvent => (
            typeof record.path === 'string'
            && typeof record.kind === 'string'
            && record.header === undefined
        )),
        schema,
        options,
    );
}
