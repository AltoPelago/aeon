/**
 * AEON 52-Cards Harness — Main Runner
 *
 * Entry point for the combinatorial interaction testing framework.
 *
 * Usage:
 *   node src/main.js [options]
 *
 * Options:
 *   --verbose           Show per-document evaluation details
 *   --summary-only      Show only pass/fail summary
 *   --seed <n>          Deterministic ordering seed (default: 0)
 *   --categories <a,b>  Filter feature categories
 *   --max-docs <n>      Cap total generated documents
 *   --markov            Enable Markov-guided generation alongside pairwise
 *   --markov-only       Run only Markov-guided generation
 *   --heatmap           Print the interaction heatmap matrix
 *   --walks <n>         Number of Markov walks (default: 200)
 *   --walk-depth <n>    Max features per walk (default: 5)
 *   --show-walks        Print generated Markov walk samples
 *   --show-walk-sources Print AEON source for shown Markov walks
 *   --walk-sample-limit <n>  Limit shown Markov walk samples (default: all)
 *   --inversion <0-1>   Survivorship-bias inversion strength (default: 0.7)
 *   --depth-tree-count <n>  Number of recursive depth-tree docs (default: 12)
 *   --depth-tree-depth <n>  Max recursive depth for depth trees (default: 4)
 *   --depth-tree-width <n>  Max child width for depth trees (default: 3)
 *   --depth-tree-invalid-rate <0-1>  Chance to emit invalid ref-mutation variants (default: 0.35)
 *   --depth-tree-comment-rate <0-1>  Chance to inject comment-channel mutations (default: 0.35)
 *   --show-depth-trees  Print generated depth-tree sample table
 *   --show-depth-tree-sources  Print AEON source for shown depth-tree samples
 *   --depth-tree-sample-limit <n>  Limit shown depth-tree samples (default: all)
 *   --depth-tree-only  Generate and evaluate only depth-tree documents
 *   --preview-only  Generate documents and show samples without evaluation
 *   --no-depth-tree-layout  Disable whitespace/layout mutation variants
 */

import { performance } from 'node:perf_hooks';
import { ALL_FEATURES, CATEGORIES } from './model/features.js';
import { evaluateSpecCoverage } from './model/spec-coverage.js';
import { printHeatmap } from './model/heatmap.js';
import { generatePairwise, generateCrossCategoryPairs } from './generators/pairwise.js';
import { generateBoundary } from './generators/boundary.js';
import { generateDepthTrees } from './generators/depth-tree.js';
import { generateMarkovWalks, getMarkovStats } from './generators/markov.js';
import { evaluateAll } from './evaluation/evaluator.js';
import { matchKnownIssue, KNOWN_CANON_ISSUES } from './evaluation/known-findings.js';
import {
    reportSummary,
    reportSpecCoverage,
    reportInvariantSkips,
    reportVerbose,
    reportFailures,
    reportMarkovStats,
    reportMarkovSamples,
    reportDepthTreeSamples,
    reportRarity,
} from './reporting/reporter.js';
import { minimizeSource, makeParseFailCheck } from './reporting/minimizer.js';

// ── Parse CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name) {
    return args.includes(name);
}

function getOption(name, defaultValue) {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) return defaultValue;
    return args[idx + 1];
}

const verbose = getFlag('--verbose');
const summaryOnly = getFlag('--summary-only');
const seed = Number(getOption('--seed', '0'));
const maxDocs = Number(getOption('--max-docs', 'Infinity'));
const categoryFilter = getOption('--categories', null);
const enableMarkov = getFlag('--markov');
const markovOnly = getFlag('--markov-only');
const showHeatmap = getFlag('--heatmap');
const numWalks = Number(getOption('--walks', '200'));
const walkDepth = Number(getOption('--walk-depth', '5'));
const showWalks = getFlag('--show-walks');
const showWalkSources = getFlag('--show-walk-sources');
const walkSampleLimit = Number(getOption('--walk-sample-limit', 'Infinity'));
const inversionStrength = Number(getOption('--inversion', '0.7'));
const depthTreeCount = Number(getOption('--depth-tree-count', '12'));
const depthTreeDepth = Number(getOption('--depth-tree-depth', '4'));
const depthTreeWidth = Number(getOption('--depth-tree-width', '3'));
const depthTreeInvalidRate = Number(getOption('--depth-tree-invalid-rate', '0.35'));
const depthTreeCommentRate = Number(getOption('--depth-tree-comment-rate', '0.35'));
const showDepthTrees = getFlag('--show-depth-trees');
const showDepthTreeSources = getFlag('--show-depth-tree-sources');
const depthTreeSampleLimit = Number(getOption('--depth-tree-sample-limit', 'Infinity'));
const depthTreeOnly = getFlag('--depth-tree-only');
const previewOnly = getFlag('--preview-only');
const includeDepthTreeLayout = !getFlag('--no-depth-tree-layout');

const categories = categoryFilter
    ? categoryFilter.split(',').map((c) => c.trim())
    : CATEGORIES;

// ── Banner ───────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════╗');
console.log('║        AEON 52-Cards Harness                    ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log();

// ── Heatmap ──────────────────────────────────────────────────────────

if (showHeatmap) {
    printHeatmap();
}

// ── Generate documents ───────────────────────────────────────────────

const genStart = performance.now();
let pairwiseDocs = [];
let crossDocs = [];
let boundaryDocs = [];
let depthTreeDocs = [];
let markovDocs = [];

if (!markovOnly && !depthTreeOnly) {
    console.log('Generating pairwise interaction documents...');
    pairwiseDocs = generatePairwise({ categories, maxDocs, seed });
    console.log(`  → ${pairwiseDocs.length} pairwise documents`);

    console.log('Generating cross-category interaction documents...');
    crossDocs = generateCrossCategoryPairs({ maxDocs: Math.max(0, maxDocs - pairwiseDocs.length) });
    console.log(`  → ${crossDocs.length} cross-category documents`);

    console.log('Generating boundary-case documents...');
    boundaryDocs = generateBoundary();
    console.log(`  → ${boundaryDocs.length} boundary documents`);
}

console.log('Generating recursive depth-tree documents...');
depthTreeDocs = generateDepthTrees({
    count: depthTreeCount,
    maxDepth: depthTreeDepth,
    maxWidth: depthTreeWidth,
    seed,
    invalidMutationRate: depthTreeInvalidRate,
    commentMutationRate: depthTreeCommentRate,
    includeLayoutMutations: includeDepthTreeLayout,
});
console.log(`  → ${depthTreeDocs.length} depth-tree documents`);

// Dedup cross-category docs that might overlap with pairwise
const seenPairs = new Set(pairwiseDocs.map((d) => d.features.sort().join('+')));
const dedupedCross = crossDocs.filter((d) => !seenPairs.has(d.features.sort().join('+')));

const baselineDocs = [...pairwiseDocs, ...dedupedCross, ...boundaryDocs, ...depthTreeDocs];

// Markov-guided generation
if (enableMarkov || markovOnly) {
    console.log('Generating Markov-walk documents...');
    console.log(`  config: walks=${numWalks} depth=${walkDepth} inversion=${inversionStrength}`);
    markovDocs = generateMarkovWalks(baselineDocs, {
        numWalks,
        maxSteps: walkDepth,
        minSteps: Math.max(2, walkDepth - 2),
        seed: seed || 42,
        inversionStrength,
    });
    console.log(`  → ${markovDocs.length} Markov-walk documents`);
}

const documents = [...baselineDocs, ...markovDocs];

const genMs = Math.round(performance.now() - genStart);
console.log(`\nTotal documents: ${documents.length} (generated in ${genMs}ms)`);

if (depthTreeDocs.length > 0 && (showDepthTrees || showDepthTreeSources)) {
    reportDepthTreeSamples(depthTreeDocs, {
        limit: depthTreeSampleLimit,
        includeSources: showDepthTreeSources,
    });
}

if (previewOnly) {
    console.log('\nPreview only mode: evaluation skipped.');
    console.log(`Generated ${documents.length} document(s).`);
    process.exit(0);
}

// ── Evaluate documents ───────────────────────────────────────────────

console.log('\nEvaluating documents against invariants...');
const evalStart = performance.now();

const evaluations = evaluateAll(documents);
const coverageFeatureIds = [];
for (const doc of documents) {
    for (const feature of doc.features) {
        coverageFeatureIds.push(feature);
    }
}
const coverage = evaluateSpecCoverage(coverageFeatureIds);

const evalMs = Math.round(performance.now() - evalStart);
console.log(`Evaluation complete (${evalMs}ms)`);

// ── Classify failures ────────────────────────────────────────────────

const allFailures = evaluations.filter((e) =>
    e.results.some((r) => !r.passed && !r.details?.skipped),
);

const knownFindings = [];
const unexpectedFailures = [];

for (const failure of allFailures) {
    const { isKnown, knownIssueId } = matchKnownIssue(failure);
    if (isKnown) {
        knownFindings.push({ ...failure, knownIssueId });
    } else {
        unexpectedFailures.push(failure);
    }
}

// ── Minimize unexpected failures ─────────────────────────────────────

if (unexpectedFailures.length > 0 && !summaryOnly) {
    console.log(`\nMinimizing ${unexpectedFailures.length} unexpected failure(s)...`);
    const docMap = new Map(documents.map((d) => [d.id, d]));

    for (const failure of unexpectedFailures) {
        const doc = docMap.get(failure.id);
        if (!doc) continue;

        const failCheck = makeParseFailCheck(doc.expectPass, {
            maxSepDepth: doc.maxSepDepth,
            maxAttrDepth: doc.maxAttrDepth,
            maxGenericDepth: doc.maxGenericDepth,
        });
        const { minimized, linesRemoved } = minimizeSource(doc.source, failCheck);

        if (linesRemoved > 0) {
            console.log(`  ${failure.id}: reduced by ${linesRemoved} block(s)`);
            doc.minimizedSource = minimized;
        }
    }
}

// ── Report ───────────────────────────────────────────────────────────

if (verbose) {
    reportVerbose(evaluations);
}

reportSummary(evaluations);
reportInvariantSkips(evaluations, 'canonical-idempotency');
reportSpecCoverage(coverage);

if (!summaryOnly) {
    reportFailures(evaluations, documents);
}

// Markov stats
if (markovDocs.length > 0) {
    const stats = getMarkovStats(markovDocs);
    reportMarkovStats(stats);
    if (showWalks || showWalkSources) {
        reportMarkovSamples(markovDocs, {
            limit: walkSampleLimit,
            includeSources: showWalkSources,
        });
    }
}

// Rarity report (when running full pipeline)
if ((enableMarkov || markovOnly) && !summaryOnly) {
    reportRarity(documents, ALL_FEATURES);
}

// ── Known findings report ────────────────────────────────────────────

if (knownFindings.length > 0) {
    console.log('\n┌──────────────────────────────────────────────────┐');
    console.log(`│  Known Findings: ${String(knownFindings.length).padEnd(3)} document(s) match tracked issues │`);
    console.log('└──────────────────────────────────────────────────┘');

    const byCause = {};
    for (const f of knownFindings) {
        const key = f.knownIssueId;
        byCause[key] = (byCause[key] ?? 0) + 1;
    }
    for (const [id, count] of Object.entries(byCause)) {
        const issue = KNOWN_CANON_ISSUES.find((k) => k.id === id);
        console.log(`  ${id}: ${count} occurrence(s) — ${issue?.summary ?? 'unknown'}`);
    }
}

// ── Exit code ────────────────────────────────────────────────────────

if (unexpectedFailures.length > 0) {
    console.error(`\n52-Cards harness detected ${unexpectedFailures.length} unexpected failure(s).`);
    process.exit(1);
}

const passedCount = documents.length - allFailures.length;
console.log(`\n52-Cards harness passed: ${passedCount}/${documents.length} document(s), all invariants hold.`);
if (knownFindings.length > 0) {
    console.log(`  (${knownFindings.length} known finding(s) tracked but not blocking)`);
}
