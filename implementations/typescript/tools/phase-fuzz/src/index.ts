#!/usr/bin/env node

import { runLexerFuzz } from './lexer-fuzz.js';
import { runParserFuzz } from './parser-fuzz.js';

type Lane = 'lexer' | 'parser' | 'all';
type Profile = 'ci' | 'nightly';

function main(): void {
    const args = process.argv.slice(2);
    const lane = getOption(args, '--lane', 'all') as Lane;
    const profile = getOption(args, '--profile', 'ci') as Profile;
    const seedOption = getOption(args, '--seed', null);
    const seedsOption = getOption(args, '--seeds', null);
    const casesOverride = getOption(args, '--cases', null);
    const maxLengthOverride = getOption(args, '--max-length', null);

    const defaults = profileDefaults(profile);
    const cases = casesOverride ? Number(casesOverride) : defaults.cases;
    const maxLength = maxLengthOverride ? Number(maxLengthOverride) : defaults.maxLength;
    const seeds = resolveSeeds(profile, seedOption, seedsOption);

    if (!Number.isFinite(cases) || !Number.isFinite(maxLength) || seeds.some((seed) => !Number.isFinite(seed))) {
        throw new Error('seed, seeds, cases, and max-length must be finite numbers');
    }

    console.log(`AEON phase fuzz: lane=${lane} profile=${profile} seeds=${seeds.join(',')} cases=${cases} maxLength=${maxLength}`);

    for (const seed of seeds) {
        console.log(`\nseed ${seed}`);

        if (lane === 'lexer' || lane === 'all') {
            const summary = runLexerFuzz({ seed, cases, maxLength });
            console.log(`lexer fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }

        if (lane === 'parser' || lane === 'all') {
            const summary = runParserFuzz({ seed, cases, maxLength });
            console.log(`parser fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }
    }
}

function getOption(args: readonly string[], name: string, fallback: string | null): string | null {
    const index = args.indexOf(name);
    if (index === -1 || index + 1 >= args.length) {
        return fallback;
    }
    return args[index + 1] ?? fallback;
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
