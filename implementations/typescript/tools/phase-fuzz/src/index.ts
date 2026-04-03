#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { runLexerFuzz } from './lexer-fuzz.js';
import { runParserFuzz } from './parser-fuzz.js';
import { runIncrementalFuzz } from './incremental-fuzz/index.js';
import type { IncrementalFuzzRunSummary, IncrementalReportFormat, SyntaxGroup } from './incremental-fuzz/types.js';

type Lane = 'lexer' | 'parser' | 'incremental' | 'all';
type Profile = 'ci' | 'nightly';

function main(): void {
    const args = process.argv.slice(2);
    const lane = getOption(args, '--lane', 'all') as Lane;
    const profile = getOption(args, '--profile', 'ci') as Profile;
    const seedOption = getOption(args, '--seed', null);
    const seedsOption = getOption(args, '--seeds', null);
    const casesOverride = getOption(args, '--cases', null);
    const maxLengthOverride = getOption(args, '--max-length', null);
    const budgetOverride = getOption(args, '--budget', null);
    const beamWidthOverride = getOption(args, '--beam-width', null);
    const keepTopOverride = getOption(args, '--keep-top', null);
    const reportTopOverride = getOption(args, '--report-top', null);
    const reportFormat = (getOption(args, '--report-format', 'human') ?? 'human') as IncrementalReportFormat;
    const reportFile = getOption(args, '--report-file', null);
    const group = (getOption(args, '--group', 'all') ?? 'all') as SyntaxGroup | 'all';

    const defaults = profileDefaults(profile);
    const cases = casesOverride ? Number(casesOverride) : defaults.cases;
    const maxLength = maxLengthOverride ? Number(maxLengthOverride) : defaults.maxLength;
    const budget = budgetOverride ? Number(budgetOverride) : defaults.budget;
    const beamWidth = beamWidthOverride ? Number(beamWidthOverride) : defaults.beamWidth;
    const keepTop = keepTopOverride ? Number(keepTopOverride) : defaults.keepTop;
    const reportTop = reportTopOverride ? Number(reportTopOverride) : defaults.reportTop;
    const seeds = resolveSeeds(profile, seedOption, seedsOption);
    const incrementalSummaries: IncrementalFuzzRunSummary[] = [];

    if (
        !Number.isFinite(cases)
        || !Number.isFinite(maxLength)
        || !Number.isFinite(budget)
        || !Number.isFinite(beamWidth)
        || !Number.isFinite(keepTop)
        || !Number.isFinite(reportTop)
        || seeds.some((seed) => !Number.isFinite(seed))
    ) {
        throw new Error('seed, seeds, cases, max-length, budget, beam-width, keep-top, and report-top must be finite numbers');
    }
    if (reportFormat !== 'human' && reportFormat !== 'json') {
        throw new Error("report-format must be either 'human' or 'json'");
    }
    if ((reportFormat === 'json' || reportFile !== null) && lane !== 'incremental' && lane !== 'all') {
        throw new Error('report-format json and report-file are currently supported for incremental fuzz runs only');
    }

    const quietIncrementalReport = lane === 'incremental' && reportFormat === 'json';

    if (!quietIncrementalReport) {
        console.log(`AEON phase fuzz: lane=${lane} profile=${profile} seeds=${seeds.join(',')} cases=${cases} maxLength=${maxLength} budget=${budget} group=${group}`);
    }

    for (const seed of seeds) {
        if (!quietIncrementalReport) {
            console.log(`\nseed ${seed}`);
        }

        if (lane === 'lexer' || lane === 'all') {
            const summary = runLexerFuzz({ seed, cases, maxLength });
            console.log(`lexer fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }

        if (lane === 'parser' || lane === 'all') {
            const summary = runParserFuzz({ seed, cases, maxLength });
            console.log(`parser fuzz passed: ${summary.cases} cases (${summary.regressionCases} regressions)`);
        }

        if (lane === 'incremental' || lane === 'all') {
            const summary = runIncrementalFuzz({ seed, budget, maxLength, beamWidth, keepTop, group, reportTop });
            incrementalSummaries.push(summary);
            if (reportFormat === 'human') {
                console.log(
                    `incremental fuzz passed: explored=${summary.explored} retained=${summary.retained} accepted=${summary.accepted} rejected=${summary.rejected} groups=${summary.groups.join(',')} bestScore=${summary.bestScore}`,
                );
                if (summary.topCases.length > 0) {
                    console.log('top retained cases:');
                    summary.topCases.forEach((entry, index) => {
                        const diagnostics = entry.diagnostics.length > 0 ? entry.diagnostics.join(',') : 'none';
                        const mutations = entry.mutationTrail.length > 0 ? entry.mutationTrail.join('>') : 'seed';
                        console.log(
                            `  ${index + 1}. ${entry.id} group=${entry.group} score=${entry.score} accepted=${entry.accepted} expectationMatch=${entry.expectationMatch} diagnostics=${diagnostics} mutations=${mutations}`,
                        );
                        console.log(`     reasons=${entry.reasons.join(', ')}`);
                        console.log(`     source=${entry.sourcePreview}`);
                    });
                }
            }
        }
    }

    if (incrementalSummaries.length > 0 && (reportFormat === 'json' || reportFile !== null)) {
        const report = JSON.stringify(
            {
                lane: 'incremental',
                profile,
                group,
                generatedAt: new Date().toISOString(),
                runs: incrementalSummaries,
            },
            null,
            2,
        );
        if (reportFile !== null) {
            writeFileSync(reportFile, report, 'utf8');
            console.log(`incremental fuzz report written: ${reportFile}`);
        }
        if (reportFormat === 'json') {
            console.log(report);
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

function profileDefaults(profile: Profile): { cases: number; maxLength: number; budget: number; beamWidth: number; keepTop: number; reportTop: number } {
    if (profile === 'nightly') {
        return { cases: 600, maxLength: 512, budget: 1500, beamWidth: 64, keepTop: 128, reportTop: 8 };
    }
    return { cases: 120, maxLength: 256, budget: 320, beamWidth: 24, keepTop: 48, reportTop: 5 };
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
