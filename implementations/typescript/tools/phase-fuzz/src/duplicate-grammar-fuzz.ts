import { tokenize, type LexerError } from '@altopelago/aeon-lexer';
import { parse, type ParserError } from '@altopelago/aeon-parser';
import { buildDuplicateGrammarCorpus } from './corpus.js';
import { createPrng } from './prng.js';
import type { FuzzRunOptions, FuzzRunSummary } from './lexer-fuzz.js';
import { PARSER_DUPLICATE_REGRESSION_CASES } from './regressions.js';

export function runDuplicateGrammarFuzz(options: FuzzRunOptions): FuzzRunSummary {
    const generatedCorpus = buildDuplicateGrammarCorpus(
        createPrng(options.seed),
        options.cases,
        options.maxLength,
        options.duplicateStepWeights
    );
    const cases = [
        ...PARSER_DUPLICATE_REGRESSION_CASES.map((entry) => ({ id: entry.id, source: entry.source, family: 'pollution-regression' })),
        ...generatedCorpus.map((source, index) => ({ id: `generated-${index}`, source, family: 'pollution-generated' })),
    ];

    cases.forEach((entry) => {
        logCase(entry.id, entry.family, entry.source, options.verbose);
        verifyRejectedDuplicateGrammar(entry.source, entry.id);
    });

    return {
        lane: 'parser-duplicates',
        cases: cases.length,
        regressionCases: PARSER_DUPLICATE_REGRESSION_CASES.length,
        seed: options.seed,
    };
}

function logCase(caseId: string, family: string, source: string, verbose: boolean | undefined): void {
    if (!verbose) {
        return;
    }

    console.log(`[family ${family}] [case ${caseId}] ${JSON.stringify(source)}`);
}

function verifyRejectedDuplicateGrammar(source: string, caseId: string): void {
    const first = scanDuplicateGrammar(source, caseId);
    const second = scanDuplicateGrammar(source, caseId);

    const firstSignature = duplicateGrammarSignature(first.lexErrors, first.parseErrors);
    const secondSignature = duplicateGrammarSignature(second.lexErrors, second.parseErrors);

    if (firstSignature !== secondSignature) {
        throw new Error(`duplicate-grammar case ${caseId} is non-deterministic`);
    }

    if (first.lexErrors.length === 0 && first.parseErrors.length === 0) {
        throw new Error(`duplicate-grammar case ${caseId} parsed without any rejection diagnostics: ${JSON.stringify(source)}`);
    }
}

function scanDuplicateGrammar(source: string, caseId: string): { lexErrors: readonly LexerError[]; parseErrors: readonly ParserError[] } {
    try {
        const lexed = tokenize(source);
        const parsed = parse(lexed.tokens);
        return {
            lexErrors: lexed.errors,
            parseErrors: parsed.errors,
        };
    } catch (error) {
        throw new Error(`duplicate-grammar case ${caseId} crashed: ${String(error)}`);
    }
}

function duplicateGrammarSignature(lexErrors: readonly LexerError[], parseErrors: readonly ParserError[]): string {
    return JSON.stringify({
        lexErrors: lexErrors.map((error) => ({
            code: error.code,
            message: error.message,
            start: error.span.start.offset,
            end: error.span.end.offset,
        })),
        parseErrors: parseErrors.map((error) => ({
            code: error.code,
            message: error.message,
            start: error.span.start.offset,
            end: error.span.end.offset,
        })),
    });
}