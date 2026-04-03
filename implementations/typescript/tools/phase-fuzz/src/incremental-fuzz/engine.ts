import { createPrng } from '../prng.js';
import { getIncrementalSeeds } from './corpus/index.js';
import { createIncrementalMutations } from './mutations.js';
import { createOracleSeeds } from './oracle-seeds.js';
import { CandidateQueue } from './queue.js';
import { getIncrementalRegressionCases } from './regressions.js';
import { commitSnapshot, createScoreState, scoreSnapshot } from './scoring.js';
import { createDedupKey, evaluateSource } from './signatures.js';
import { minimizeIncrementalCase } from './minimizer.js';
import type { EvaluationResult, IncrementalFuzzRunOptions, IncrementalFuzzRunSummary, IncrementalSeed, SeedOrigin } from './types.js';

export function runIncrementalFuzz(options: IncrementalFuzzRunOptions): IncrementalFuzzRunSummary {
    const prng = createPrng(options.seed);
    const queue = new CandidateQueue(options.beamWidth);
    const scoreState = createScoreState();
    const mutations = createIncrementalMutations();
    const dedup = new Set<string>();
    const retained: EvaluationResult[] = [];
    const groups = new Set<IncrementalSeed['group']>();
    const oracleSeeds = createOracleSeeds({
        seed: options.seed,
        count: options.oracleSeeds,
        maxLength: options.maxLength,
        group: options.group,
    });

    const seeds = [
        ...normalizeSeeds(getIncrementalRegressionCases(options.group), 'regression'),
        ...(options.oracleOnly ? [] : normalizeSeeds(getIncrementalSeeds(options.group), 'corpus')),
        ...normalizeSeeds(oracleSeeds, 'oracle'),
    ];
    let explored = 0;

    seeds.forEach((seed) => {
        const snapshot = evaluateSource(seed.source, seed);
        const dedupKey = createDedupKey(snapshot, seed.source);
        if (dedup.has(dedupKey)) {
            return;
        }
        const { score, reasons } = scoreSnapshot(snapshot, seed.source, null, scoreState);
        const result: EvaluationResult = {
            id: seed.id,
            seed,
            source: seed.source,
            signature: snapshot,
            score,
            reasons,
            parentId: null,
            mutationTrail: [],
        };
        retain(result, retained, queue, dedup, scoreState, options.keepTop);
        groups.add(seed.group);
        explored += 1;
    });

    while (explored < options.budget && queue.size() > 0) {
        const candidate = queue.shift();
        if (!candidate) {
            break;
        }

        for (const mutation of mutations) {
            if (explored >= options.budget) {
                break;
            }
            const source = mutation.apply(candidate.source, prng);
            if (source.length === 0 || source.length > options.maxLength) {
                explored += 1;
                continue;
            }
            const snapshot = evaluateSource(source, candidate.seed);
            const dedupKey = createDedupKey(snapshot, source);
            if (dedup.has(dedupKey)) {
                explored += 1;
                continue;
            }
            const { score, reasons } = scoreSnapshot(snapshot, source, candidate, scoreState);
            const result: EvaluationResult = {
                id: `${candidate.id}:${mutation.type}:${explored}`,
                seed: candidate.seed,
                source,
                signature: snapshot,
                score,
                reasons,
                parentId: candidate.id,
                mutationTrail: [...candidate.mutationTrail, mutation.type],
            };
            if (score > 0) {
                retain(result, retained, queue, dedup, scoreState, options.keepTop);
                groups.add(candidate.seed.group);
            }
            explored += 1;
        }
    }

    const accepted = retained.filter((entry) => entry.signature.accepted).length;
    const rejected = retained.length - accepted;
    const retainedByOrigin = countByOrigin(retained);
    const reviewCandidates = retained.filter((entry) => isReviewCandidate(entry));
    const validOracleSeeds = retained
        .filter((entry) => isValidOracleSeed(entry))
        .sort((left, right) => compareValidOracleSeeds(left, right));
    const readableValidOracleSeeds = validOracleSeeds.filter((entry) => isReadableValidOracleSeed(entry.source));
    const reportPool = options.reportValidOnly
        ? (readableValidOracleSeeds.length > 0 ? readableValidOracleSeeds : validOracleSeeds)
        : options.reportNewOnly
            ? reviewCandidates
            : retained;
    const reportEntries = reportPool.slice(0, Math.max(0, options.reportTop));
    const topCases = reportEntries.map((entry, index) => {
        const minimized = index < options.minimizeTop && !entry.signature.accepted
            ? minimizeIncrementalCase(entry.source, entry.seed)
            : null;
        const base = {
            id: entry.id,
            group: entry.seed.group,
            seedOrigin: entry.seed.origin ?? 'corpus',
            score: entry.score,
            accepted: entry.signature.accepted,
            reasons: entry.reasons,
            diagnostics: entry.signature.diagnostics,
            mutationTrail: entry.mutationTrail,
            expectationMatch: entry.signature.expectationMatch,
            source: entry.source,
            sourcePreview: previewSource(entry.source),
        };
        if (minimized) {
            return {
                ...base,
                minimizedSource: minimized.source,
                minimizedSourcePreview: previewSource(minimized.source),
                minimizedChanged: minimized.changed,
            };
        }
        return base;
    });

    return {
        lane: 'incremental',
        seed: options.seed,
        budget: options.budget,
        oracleSeedCount: oracleSeeds.length,
        oracleOnly: options.oracleOnly,
        explored,
        retained: retained.length,
        groups: Array.from(groups).sort(),
        accepted,
        rejected,
        bestScore: retained.length > 0 ? retained[0]?.score ?? 0 : 0,
        retainedByOrigin,
        topCasesByOrigin: countByOrigin(topCases),
        reviewCandidateCount: reviewCandidates.length,
        validOracleSeedCount: validOracleSeeds.length,
        topCases,
    };
}

function retain(
    result: EvaluationResult,
    retained: EvaluationResult[],
    queue: CandidateQueue,
    dedup: Set<string>,
    scoreState: ReturnType<typeof createScoreState>,
    keepTop: number,
): void {
    const dedupKey = createDedupKey(result.signature, result.source);
    dedup.add(dedupKey);
    commitSnapshot(result.signature, scoreState);
    retained.push(result);
    retained.sort((left, right) => right.score - left.score);
    if (retained.length > keepTop) {
        retained.length = keepTop;
    }
    queue.push(result);
}

function previewSource(source: string): string {
    const singleLine = source.replace(/\s+/g, ' ').trim();
    return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 117)}...`;
}

function normalizeSeeds(seeds: readonly IncrementalSeed[], origin: SeedOrigin): IncrementalSeed[] {
    return seeds.map((seed) => ({ ...seed, origin }));
}

function countByOrigin(entries: readonly { seed?: { origin?: SeedOrigin }; seedOrigin?: SeedOrigin }[]): Record<SeedOrigin, number> {
    const counts: Record<SeedOrigin, number> = {
        corpus: 0,
        regression: 0,
        oracle: 0,
    };

    entries.forEach((entry) => {
        const origin = entry.seedOrigin ?? entry.seed?.origin ?? 'corpus';
        counts[origin] += 1;
    });

    return counts;
}

function isReviewCandidate(entry: EvaluationResult): boolean {
    if (entry.seed.origin !== 'oracle') {
        return false;
    }
    if (entry.signature.accepted) {
        return false;
    }
    return entry.reasons.some((reason) =>
        reason === 'new-lexer-signature'
        || reason === 'new-parser-signature'
        || reason.startsWith('new-diagnostic:'),
    );
}

function isValidOracleSeed(entry: EvaluationResult): boolean {
    return entry.seed.origin === 'oracle'
        && entry.signature.accepted
        && entry.parentId === null;
}

function compareValidOracleSeeds(left: EvaluationResult, right: EvaluationResult): number {
    const scoreDelta = readabilityScore(right.source) - readabilityScore(left.source);
    if (scoreDelta !== 0) {
        return scoreDelta;
    }
    const lengthDelta = left.source.length - right.source.length;
    if (lengthDelta !== 0) {
        return lengthDelta;
    }
    return right.score - left.score;
}

function readabilityScore(source: string): number {
    let score = 0;

    if (!source.includes('\n')) {
        score += 6;
    }
    if (!/["'`]$/.test(source)) {
        score += 6;
    }
    if (!/\s["'`][A-Za-z0-9]*$/.test(source)) {
        score += 5;
    }
    if (!/[A-Za-z0-9]@?\{\}\s*=\s*["'`]/.test(source)) {
        score += 2;
    }
    if (/^[-\w.@{}\s=<>()\[\],":']+$/.test(source)) {
        score += 4;
    }
    if (source.length <= 32) {
        score += 6;
    } else if (source.length <= 56) {
        score += 3;
    }

    return score;
}

function isReadableValidOracleSeed(source: string): boolean {
    if (source.includes('\n')) {
        return false;
    }
    if (source.length > 48) {
        return false;
    }
    if (source.includes('<') || source.includes('[')) {
        return /[>\]]$/.test(source);
    }
    return !/["'`]$/.test(source);
}
