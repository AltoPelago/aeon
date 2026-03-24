import { tokenize, TokenType, type LexerError, type LexResult, type LexerOptions, type Token } from '@aeon/lexer';
import { buildLexerCorpus } from './corpus.js';
import { createPrng } from './prng.js';
import { LEXER_REGRESSION_CASES } from './regressions.js';

export interface FuzzRunOptions {
    readonly cases: number;
    readonly maxLength: number;
    readonly seed: number;
}

export interface FuzzRunSummary {
    readonly lane: 'lexer' | 'parser';
    readonly cases: number;
    readonly regressionCases: number;
    readonly seed: number;
}

export function runLexerFuzz(options: FuzzRunOptions): FuzzRunSummary {
    const generatedCorpus = buildLexerCorpus(createPrng(options.seed), options.cases, options.maxLength);
    const cases = [
        ...LEXER_REGRESSION_CASES.map((entry) => ({ id: entry.id, source: entry.source })),
        ...generatedCorpus.map((source, index) => ({ id: `generated-${index}`, source })),
    ];

    cases.forEach((entry) => {
        const plain = verifyLexCase(entry.source, entry.id, {});
        const withComments = verifyLexCase(entry.source, entry.id, { includeComments: true });
        const withNewlines = verifyLexCase(entry.source, entry.id, { includeNewlines: true });
        const withAll = verifyLexCase(entry.source, entry.id, { includeComments: true, includeNewlines: true });
        validateOptionStability(plain, withComments, withNewlines, withAll, entry.id);
    });

    return {
        lane: 'lexer',
        cases: cases.length,
        regressionCases: LEXER_REGRESSION_CASES.length,
        seed: options.seed,
    };
}

function verifyLexCase(source: string, caseId: string, options: LexerOptions): LexResult {
    const first = safeTokenize(source, options, caseId);
    const second = safeTokenize(source, options, caseId);

    const firstSignature = lexResultSignature(first);
    const secondSignature = lexResultSignature(second);

    if (firstSignature !== secondSignature) {
        throw new Error(`lexer case ${caseId} is non-deterministic for options ${JSON.stringify(options)}`);
    }

    validateLexResult(first, source, caseId, options);
    return first;
}

function safeTokenize(source: string, options: LexerOptions, caseId: string): LexResult {
    try {
        return tokenize(source, options);
    } catch (error) {
        throw new Error(`lexer case ${caseId} crashed for options ${JSON.stringify(options)}: ${String(error)}`);
    }
}

function validateLexResult(result: LexResult, source: string, caseId: string, options: LexerOptions): void {
    if (result.tokens.length === 0) {
        throw new Error(`lexer case ${caseId} returned no tokens for options ${JSON.stringify(options)}`);
    }

    const lastToken = result.tokens[result.tokens.length - 1];
    if (!lastToken || lastToken.type !== TokenType.EOF) {
        throw new Error(`lexer case ${caseId} missing EOF token for options ${JSON.stringify(options)}`);
    }

    let previousEnd = 0;
    for (const token of result.tokens) {
        validateSpan(token.span.start.offset, token.span.end.offset, source.length, `token ${token.type}`, caseId);
        if (token.span.start.offset < previousEnd) {
            throw new Error(`lexer case ${caseId} has non-monotonic token offsets`);
        }
        if (token.span.start.line < 1 || token.span.start.column < 1 || token.span.end.line < 1 || token.span.end.column < 1) {
            throw new Error(`lexer case ${caseId} has invalid token line/column values`);
        }
        previousEnd = token.span.end.offset;

        if (!options.includeComments && (token.type === TokenType.LineComment || token.type === TokenType.BlockComment)) {
            throw new Error(`lexer case ${caseId} emitted comment tokens with includeComments disabled`);
        }
        if (!options.includeNewlines && token.type === TokenType.Newline) {
            throw new Error(`lexer case ${caseId} emitted newline tokens with includeNewlines disabled`);
        }
    }

    for (const error of result.errors) {
        validateSpan(error.span.start.offset, error.span.end.offset, source.length, `error ${error.code}`, caseId);
        if (error.span.start.line < 1 || error.span.start.column < 1 || error.span.end.line < 1 || error.span.end.column < 1) {
            throw new Error(`lexer case ${caseId} has invalid error line/column values`);
        }
    }
}

function validateOptionStability(plain: LexResult, withComments: LexResult, withNewlines: LexResult, withAll: LexResult, caseId: string): void {
    const withoutOptional = stableNonOptionalSignature(plain);
    if (withoutOptional !== stableNonOptionalSignature(withComments)) {
        throw new Error(`lexer case ${caseId} changed non-comment tokens when includeComments was enabled`);
    }
    if (withoutOptional !== stableNonOptionalSignature(withNewlines)) {
        throw new Error(`lexer case ${caseId} changed non-newline tokens when includeNewlines was enabled`);
    }
    if (withoutOptional !== stableNonOptionalSignature(withAll)) {
        throw new Error(`lexer case ${caseId} changed core tokens when all optional outputs were enabled`);
    }
}

function validateSpan(start: number, end: number, sourceLength: number, label: string, caseId: string): void {
    if (start < 0 || end < 0 || start > end || end > sourceLength) {
        throw new Error(`lexer case ${caseId} has out-of-bounds span for ${label}`);
    }
}

function lexResultSignature(result: LexResult): string {
    return JSON.stringify({
        tokens: result.tokens.map(tokenSignature),
        errors: result.errors.map(errorSignature),
    });
}

function stableNonOptionalSignature(result: LexResult): string {
    return JSON.stringify({
        tokens: result.tokens
            .filter((token) => token.type !== TokenType.LineComment && token.type !== TokenType.BlockComment && token.type !== TokenType.Newline)
            .map(tokenSignature),
        errors: result.errors.map(errorSignature),
    });
}

function tokenSignature(token: Token): object {
    return {
        type: token.type,
        value: token.value,
        start: token.span.start.offset,
        end: token.span.end.offset,
        comment: token.comment ?? null,
        quote: token.quote ?? null,
    };
}

function errorSignature(error: LexerError): object {
    return {
        code: error.code,
        message: error.message,
        start: error.span.start.offset,
        end: error.span.end.offset,
    };
}
