#!/usr/bin/env node

import { runDuplicateGrammarFuzz } from './duplicate-grammar-fuzz.js';
import { runFocusedDuplicateGrammarFuzz } from './focused-duplicate-fuzz.js';
import { runLexerFuzz } from './lexer-fuzz.js';
import { runParserFuzz } from './parser-fuzz.js';

type Lane = 'lexer' | 'parser' | 'parser-duplicates' | 'parser-duplicate-attributes' | 'all';
type Profile = 'ci' | 'nightly';
type FocusedFamily = 'attribute' | 'type' | 'container' | 'scalar';

function main(): void {
    const args = process.argv.slice(2);
    const lane = getOption(args, '--lane', 'all') as Lane;
    const profile = getOption(args, '--profile', 'ci') as Profile;
    const seedOption = getOption(args, '--seed', null);
    const seedsOption = getOption(args, '--seeds', null);
    const casesOverride = getOption(args, '--cases', null);
    const maxLengthOverride = getOption(args, '--max-length', null);
    const duplicateStepsOption = getOption(args, '--dup-steps', null);
    const focusedFamilyOption = getOption(args, '--focused-family', null);
    const verbose = hasFlag(args, '--verbose');

    const defaults = profileDefaults(profile);
    const cases = casesOverride ? Number(casesOverride) : defaults.cases;
    const maxLength = maxLengthOverride ? Number(maxLengthOverride) : defaults.maxLength;
    const seeds = resolveSeeds(profile, seedOption, seedsOption);
    const duplicateStepWeights = parseDuplicateStepWeights(duplicateStepsOption);
    const focusedFamily = parseFocusedFamily(focusedFamilyOption);

    if (!Number.isFinite(cases) || !Number.isFinite(maxLength) || seeds.some((seed) => !Number.isFinite(seed))) {
        throw new Error('seed, seeds, cases, and max-length must be finite numbers');
    }

    const duplicateStepsLabel = duplicateStepWeights ? duplicateStepWeights.join(',') : 'default(50,40,10)';
    const focusedFamilyLabel = focusedFamily ?? 'all';
    console.log(`AEON phase fuzz: lane=${lane} profile=${profile} seeds=${seeds.join(',')} cases=${cases} maxLength=${maxLength} verbose=${verbose} dupSteps=${duplicateStepsLabel} focusedFamily=${focusedFamilyLabel}`);

    for (const seed of seeds) {
        console.log(`\nseed ${seed}`);

        if (lane === 'lexer' || lane === 'all') {
            const summary = runLexerFuzz({ seed, cases, maxLength, verbose });
            console.log(`lexer fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }

        if (lane === 'parser' || lane === 'all') {
            const summary = runParserFuzz({ seed, cases, maxLength, verbose });
            console.log(`parser fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }

        if (lane === 'parser-duplicates' || lane === 'all') {
            const summary = runDuplicateGrammarFuzz({
                seed,
                cases,
                maxLength,
                verbose,
                ...(duplicateStepWeights ? { duplicateStepWeights } : {}),
            });
            console.log(`parser duplicate pollution fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }

        if (lane === 'parser-duplicate-attributes' || lane === 'all') {
            const summary = runFocusedDuplicateGrammarFuzz({ seed, cases, maxLength, verbose, ...(focusedFamily ? { focusedFamily } : {}) });
            console.log(`parser duplicate focused fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }
    }
}

function parseFocusedFamily(option: string | null): FocusedFamily | null {
    if (!option) {
        return null;
    }

    const normalized = option.trim().toLowerCase();
    if (normalized === 'attribute' || normalized === 'type' || normalized === 'container' || normalized === 'scalar') {
        return normalized;
    }

    throw new Error('--focused-family must be one of: attribute,type,container,scalar');
}

function parseDuplicateStepWeights(option: string | null): readonly [number, number, number] | null {
    if (!option) {
        return null;
    }

    const parts = option.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error('--dup-steps must be three non-negative numbers like 50,40,10');
    }

    const [oneStepWeight, twoStepWeight, threeStepWeight] = parts;
    if (oneStepWeight === undefined || twoStepWeight === undefined || threeStepWeight === undefined) {
        throw new Error('--dup-steps must provide all three weights');
    }

    const total = oneStepWeight + twoStepWeight + threeStepWeight;
    if (total !== 100) {
        throw new Error('--dup-steps must sum to 100');
    }

    return [oneStepWeight, twoStepWeight, threeStepWeight] as const;
}

function getOption(args: readonly string[], name: string, fallback: string | null): string | null {
    const index = args.indexOf(name);
    if (index === -1 || index + 1 >= args.length) {
        return fallback;
    }
    return args[index + 1] ?? fallback;
}

function hasFlag(args: readonly string[], name: string): boolean {
    return args.includes(name);
}

function profileDefaults(profile: Profile): { cases: number; maxLength: number } {
    if (profile === 'nightly') {
        return { cases: 600, maxLength: 512 };
    }
    return { cases: 120, maxLength: 256 };
}

function resolveSeeds(profile: Profile, seedOption: string | null, seedsOption: string | null): number[] {
    if (seedsOption) {
        return seedsOption
            .split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isFinite(value));
    }

    if (seedOption) {
        return [Number(seedOption)];
    }

    if (profile === 'nightly') {
        return [1337, 7331, 9001, 424242];
    }

    return [1337];
}

main();
