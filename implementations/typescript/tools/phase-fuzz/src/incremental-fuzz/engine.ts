import { createPrng } from '../prng.js';
import { getIncrementalSeeds } from './corpus/index.js';
import { createIncrementalMutations } from './mutations.js';
import { CandidateQueue } from './queue.js';
import { INCREMENTAL_REGRESSION_CASES } from './regressions.js';
import { commitSnapshot, createScoreState, scoreSnapshot } from './scoring.js';
import { createDedupKey, evaluateSource } from './signatures.js';
import type { EvaluationResult, IncrementalFuzzRunOptions, IncrementalFuzzRunSummary, IncrementalSeed } from './types.js';

export function runIncrementalFuzz(options: IncrementalFuzzRunOptions): IncrementalFuzzRunSummary {
    const prng = createPrng(options.seed);
    const queue = new CandidateQueue(options.beamWidth);
    const scoreState = createScoreState();
    const mutations = createIncrementalMutations();
    const dedup = new Set<string>();
    const retained: EvaluationResult[] = [];
    const groups = new Set<IncrementalSeed['group']>();

    const seeds = [...INCREMENTAL_REGRESSION_CASES, ...getIncrementalSeeds(options.group)];
    let explored = 0;

    seeds.forEach((seed) => {
        const snapshot = evaluateSource(seed.source, seed);
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

    return {
        lane: 'incremental',
        seed: options.seed,
        budget: options.budget,
        explored,
        retained: retained.length,
        groups: Array.from(groups).sort(),
        accepted,
        rejected,
        bestScore: retained.length > 0 ? retained[0]?.score ?? 0 : 0,
        topCases: retained.slice(0, Math.max(0, options.reportTop)).map((entry) => ({
            id: entry.id,
            group: entry.seed.group,
            score: entry.score,
            accepted: entry.signature.accepted,
            reasons: entry.reasons,
            diagnostics: entry.signature.diagnostics,
            mutationTrail: entry.mutationTrail,
            expectationMatch: entry.signature.expectationMatch,
            sourcePreview: previewSource(entry.source),
        })),
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
