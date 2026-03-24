/**
 * AEON 52-Cards Reporter
 *
 * Formats evaluation results to console.
 */

const TABLE_FEATURE_WRAP = 24;
const SOURCE_PREVIEW_LINE_WIDTH = 76;
const SOURCE_PREVIEW_MAX_LINES = 80;

function wrapTableCell(value, width = TABLE_FEATURE_WRAP) {
    const text = String(value ?? '');
    if (text.length <= width) return text;

    const parts = [];
    let remaining = text;
    while (remaining.length > width) {
        let splitAt = remaining.lastIndexOf(' ', width);
        if (splitAt <= 0) splitAt = width;
        parts.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) {
        parts.push(remaining);
    }
    return parts.join('\n');
}

function padCell(text, width) {
    return String(text).padEnd(width, ' ');
}

function renderCompactTable(rows, columns) {
    if (!rows || rows.length === 0) {
        console.log('(none)');
        return;
    }

    const separator = `+${columns.map((column) => '-'.repeat(column.width + 2)).join('+')}+`;
    const header = `|${columns.map((column) => ` ${padCell(column.label, column.width)} `).join('|')}|`;

    console.log(separator);
    console.log(header);
    console.log(separator);

    for (const row of rows) {
        const cellLines = columns.map((column) => {
            const raw = row[column.key] ?? '';
            return wrapTableCell(raw, column.width).split('\n');
        });
        const height = Math.max(...cellLines.map((lines) => lines.length));

        for (let i = 0; i < height; i++) {
            const line = `|${columns.map((column, index) => ` ${padCell(cellLines[index][i] ?? '', column.width)} `).join('|')}|`;
            console.log(line);
        }
        console.log(separator);
    }
}

function clipLine(text, width = SOURCE_PREVIEW_LINE_WIDTH) {
    if (text.length <= width) return text;
    return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatSourcePreview(source, options = {}) {
    const maxLines = options.maxLines ?? SOURCE_PREVIEW_MAX_LINES;
    const lineWidth = options.lineWidth ?? SOURCE_PREVIEW_LINE_WIDTH;
    const lines = String(source ?? '').trim().split('\n');
    const clipped = lines.slice(0, maxLines).map((line) => clipLine(line, lineWidth));
    if (lines.length > maxLines) {
        clipped.push(`... (${lines.length - maxLines} more line(s))`);
    }
    return clipped.join('\n');
}

/**
 * Report summary results to console.
 */
export function reportSummary(evaluations) {
    const totalDocs = evaluations.length;
    const totalChecks = evaluations.reduce((sum, e) => sum + e.results.length, 0);

    const failedDocs = evaluations.filter((e) => e.results.some((r) => !r.passed));
    const passedDocs = totalDocs - failedDocs.length;

    // Count by invariant class
    const invariantCounts = {};
    for (const evalResult of evaluations) {
        for (const r of evalResult.results) {
            if (!invariantCounts[r.invariant]) {
                invariantCounts[r.invariant] = { passed: 0, failed: 0, skipped: 0 };
            }
            if (r.details?.skipped) {
                invariantCounts[r.invariant].skipped++;
            } else if (r.passed) {
                invariantCounts[r.invariant].passed++;
            } else {
                invariantCounts[r.invariant].failed++;
            }
        }
    }

    // Count by test class
    const classCounts = {};
    for (const evalResult of evaluations) {
        if (!classCounts[evalResult.class]) {
            classCounts[evalResult.class] = { total: 0, passed: 0, failed: 0 };
        }
        classCounts[evalResult.class].total++;
        const hasFail = evalResult.results.some((r) => !r.passed);
        if (hasFail) {
            classCounts[evalResult.class].failed++;
        } else {
            classCounts[evalResult.class].passed++;
        }
    }

    // Feature coverage
    const featuresSeen = new Set();
    for (const evalResult of evaluations) {
        for (const f of evalResult.features) featuresSeen.add(f);
    }

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║        AEON 52-Cards Harness — Summary          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`Documents generated:  ${totalDocs}`);
    console.log(`Invariant checks:     ${totalChecks}`);
    console.log(`Documents passed:     ${passedDocs}`);
    console.log(`Documents failed:     ${failedDocs.length}`);
    console.log(`Features exercised:   ${featuresSeen.size}`);
    console.log();

    // Invariant breakdown table
    console.log('Invariant breakdown:');
    renderCompactTable(
        Object.entries(invariantCounts).map(([invariant, counts]) => ({
            invariant,
            passed: counts.passed,
            failed: counts.failed,
            skipped: counts.skipped,
        })),
        [
            { key: 'invariant', label: 'invariant', width: 24 },
            { key: 'passed', label: 'passed', width: 8 },
            { key: 'failed', label: 'failed', width: 8 },
            { key: 'skipped', label: 'skipped', width: 8 },
        ],
    );

    // Class breakdown table
    console.log('Test class breakdown:');
    renderCompactTable(
        Object.entries(classCounts).map(([cls, counts]) => ({
            class: cls,
            total: counts.total,
            passed: counts.passed,
            failed: counts.failed,
        })),
        [
            { key: 'class', label: 'class', width: 20 },
            { key: 'total', label: 'total', width: 8 },
            { key: 'passed', label: 'passed', width: 8 },
            { key: 'failed', label: 'failed', width: 8 },
        ],
    );
}

export function reportSpecCoverage(coverage) {
    if (!coverage) return;

    console.log('Spec coverage ledger:');
    renderCompactTable(
        coverage.items.map((item) => ({
            requirement: item.id,
            scope: item.implementationOnly ? 'impl-only' : 'normative',
            status: item.status,
            required: `${item.coveredRequired}/${item.totalRequired}`,
            optional: item.totalOptional > 0 ? `${item.coveredOptional}/${item.totalOptional}` : '-',
        })),
        [
            { key: 'requirement', label: 'requirement', width: 28 },
            { key: 'scope', label: 'scope', width: 10 },
            { key: 'status', label: 'status', width: 9 },
            { key: 'required', label: 'required', width: 8 },
            { key: 'optional', label: 'optional', width: 8 },
        ],
    );

    const uncovered = coverage.items.filter((item) => item.status !== 'covered');
    if (uncovered.length > 0) {
        console.log(`Coverage summary: covered=${coverage.summary.covered} partial=${coverage.summary.partial} uncovered=${coverage.summary.uncovered}`);
        for (const item of uncovered) {
            const missingValid = item.missingRequiredValid.slice(0, 6).join(', ');
            const missingNegative = item.missingRequiredNegative.slice(0, 6).join(', ');
            const suffix = [];
            if (item.missingRequiredValid.length > 0) {
                suffix.push(`valid ${missingValid}${item.missingRequiredValid.length > 6 ? ', ...' : ''}`);
            }
            if (item.missingRequiredNegative.length > 0) {
                suffix.push(`negative ${missingNegative}${item.missingRequiredNegative.length > 6 ? ', ...' : ''}`);
            }
            console.log(`  ${item.status === 'partial' ? '◐' : '○'} ${item.id}: missing ${suffix.join(' | ') || 'none'}`);
        }
    }
}

export function reportInvariantSkips(evaluations, invariantName) {
    const skipCounts = new Map();

    for (const evaluation of evaluations) {
        for (const result of evaluation.results) {
            if (result.invariant !== invariantName) continue;
            if (!result.details?.skipped) continue;
            const reason = result.details.reason ?? 'unknown';
            skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
        }
    }

    if (skipCounts.size === 0) return;

    console.log(`${invariantName} skip breakdown:`);
    renderCompactTable(
        Array.from(skipCounts.entries()).map(([reason, count]) => ({
            reason,
            count,
        })),
        [
            { key: 'reason', label: 'reason', width: 28 },
            { key: 'count', label: 'count', width: 8 },
        ],
    );
}

/**
 * Report verbose per-document results.
 */
export function reportVerbose(evaluations) {
    for (const evalResult of evaluations) {
        const allPassed = evalResult.results.every((r) => r.passed);
        const status = allPassed ? '✓' : '✗';
        const features = evalResult.features.join(' + ');

        console.log(`\n${status}  ${evalResult.id}  [${evalResult.class}]  features: ${features}`);

        for (const r of evalResult.results) {
            const mark = r.passed ? '  ✓' : '  ✗';
            const skip = r.details?.skipped ? ' (skipped)' : '';
            console.log(`${mark} ${r.invariant}${skip}`);
            if (!r.passed) {
                console.log(`    details: ${JSON.stringify(r.details)}`);
            }
        }
    }
}

/**
 * Report failures only with document source for debugging.
 */
export function reportFailures(evaluations, documents) {
    const failures = evaluations.filter((e) => e.results.some((r) => !r.passed));
    if (failures.length === 0) {
        console.log('\nNo failures detected.');
        return;
    }

    console.log(`\n━━━ Failures (${failures.length}) ━━━\n`);

    const docMap = new Map(documents.map((d) => [d.id, d]));

    for (const evalResult of failures) {
        const doc = docMap.get(evalResult.id);
        const failedInvariants = evalResult.results.filter((r) => !r.passed);

        console.log(`━━━ ${evalResult.id} ━━━`);
        console.log(`Features: ${evalResult.features.join(' + ')}`);
        console.log(`Class:    ${evalResult.class}`);

        for (const r of failedInvariants) {
            console.log(`  ✗ ${r.invariant}: ${JSON.stringify(r.details)}`);
        }

        if (doc) {
            console.log('\nSource:');
            console.log('───────────────────');
            console.log(doc.source.trim());
            console.log('───────────────────\n');
        }
    }
}

/**
 * Report Markov walk statistics.
 */
export function reportMarkovStats(stats) {
    if (!stats) return;

    console.log('\n┌──────────────────────────────────────────────────┐');
    console.log('│          Markov Walk Statistics                   │');
    console.log('└──────────────────────────────────────────────────┘\n');

    console.log(`Total walks:        ${stats.totalWalks}`);
    console.log(`Walk depth:         ${stats.minDepth}–${stats.maxDepth} (avg ${stats.avgDepth})`);
    console.log(`Average risk:       ${stats.avgRisk} (max ${stats.maxRisk})`);
    console.log(`Categories covered: ${stats.categoriesCovered}`);
    console.log(`Features covered:   ${stats.featuresCovered}`);
    console.log();

    console.log('Walk depth histogram:');
    const maxCount = Math.max(...Object.values(stats.depthHistogram));
    for (const [depth, count] of Object.entries(stats.depthHistogram).sort((a, b) => a[0] - b[0])) {
        const bar = '█'.repeat(Math.ceil((count / maxCount) * 30));
        console.log(`  depth ${depth}: ${bar} ${count}`);
    }
}

/**
 * Report sampled/generated Markov walk documents.
 */
export function reportMarkovSamples(documents, options = {}) {
    const walkDocs = documents.filter((d) => d.class === 'markov-walk');
    if (walkDocs.length === 0) return;

    const limit = options.limit && Number.isFinite(options.limit)
        ? Math.max(0, Math.min(options.limit, walkDocs.length))
        : walkDocs.length;
    const selected = walkDocs.slice(0, limit);

    console.log('\n┌──────────────────────────────────────────────────┐');
    console.log('│            Markov Walk Samples                    │');
    console.log('└──────────────────────────────────────────────────┘\n');

    console.log(`Showing ${selected.length}/${walkDocs.length} walk(s)\n`);
    renderCompactTable(
        selected.map((doc) => ({
            id: doc.id,
            depth: doc.walkDepth,
            avgRisk: doc.avgRisk,
            mode: doc.needsTransport ? 'transport' : 'strict',
            expect: doc.expectPass ? 'pass' : 'fail',
            features: doc.features.join(' + '),
        })),
        [
            { key: 'id', label: 'id', width: 16 },
            { key: 'depth', label: 'depth', width: 5 },
            { key: 'avgRisk', label: 'risk', width: 6 },
            { key: 'mode', label: 'mode', width: 10 },
            { key: 'expect', label: 'expect', width: 6 },
            { key: 'features', label: 'features', width: 21 },
        ],
    );

    if (!options.includeSources) return;

    for (const doc of selected) {
        console.log(`\n━━━ ${doc.id} ━━━`);
        console.log(`Depth:    ${doc.walkDepth}`);
        console.log(`Avg risk: ${doc.avgRisk}`);
        console.log(`Mode:     ${doc.needsTransport ? 'transport' : 'strict'}`);
        console.log(`Features: ${doc.features.join(' + ')}`);
        console.log('\nSource:');
        console.log('───────────────────');
        console.log(formatSourcePreview(doc.source));
        console.log('───────────────────');
    }
}

export function reportDepthTreeSamples(documents, options = {}) {
    const depthDocs = documents.filter((d) => d.class === 'depth-tree');
    if (depthDocs.length === 0) return;

    const limit = options.limit && Number.isFinite(options.limit)
        ? Math.max(0, Math.min(options.limit, depthDocs.length))
        : depthDocs.length;
    const selected = depthDocs.slice(0, limit);

    console.log('\n┌──────────────────────────────────────────────────┐');
    console.log('│            Depth-Tree Samples                     │');
    console.log('└──────────────────────────────────────────────────┘\n');

    console.log(`Showing ${selected.length}/${depthDocs.length} depth-tree doc(s)\n`);
    renderCompactTable(
        selected.map((doc) => ({
            id: doc.id,
            mode: doc.needsTransport ? 'transport' : 'strict',
            expect: doc.expectPass ? 'pass' : 'fail',
            attrDepth: doc.maxAttrDepth ?? 1,
            genericDepth: doc.maxGenericDepth ?? 1,
            features: doc.features.join(' + '),
        })),
        [
            { key: 'id', label: 'id', width: 20 },
            { key: 'mode', label: 'mode', width: 10 },
            { key: 'expect', label: 'expect', width: 6 },
            { key: 'attrDepth', label: 'attr', width: 4 },
            { key: 'genericDepth', label: 'gen', width: 4 },
            { key: 'features', label: 'features', width: 20 },
        ],
    );

    if (!options.includeSources) return;

    for (const doc of selected) {
        console.log(`\n━━━ ${doc.id} ━━━`);
        console.log(`Mode:          ${doc.needsTransport ? 'transport' : 'strict'}`);
        console.log(`Expect:        ${doc.expectPass ? 'pass' : 'fail'}`);
        console.log(`Attr depth:    ${doc.maxAttrDepth ?? 1}`);
        console.log(`Generic depth: ${doc.maxGenericDepth ?? 1}`);
        console.log(`Features:      ${doc.features.join(' + ')}`);
        console.log('\nSource:');
        console.log('───────────────────');
        console.log(formatSourcePreview(doc.source));
        console.log('───────────────────');
    }
}

/**
 * Report least-exercised features across all generators.
 */
export function reportRarity(allDocuments, allFeatures) {
    const frequencyMap = new Map();
    for (const doc of allDocuments) {
        for (const f of doc.features) {
            frequencyMap.set(f, (frequencyMap.get(f) ?? 0) + 1);
        }
    }

    const coverage = allFeatures.map((feature) => ({
        feature: feature.id,
        count: frequencyMap.get(feature.id) ?? 0,
        expectPass: feature.generate({}).expectPass,
    }));

    coverage.sort((a, b) => a.count - b.count);

    const uncoveredValid = coverage.filter((c) => c.count === 0 && c.expectPass);
    const uncoveredNegative = coverage.filter((c) => c.count === 0 && !c.expectPass);
    const rareValid = coverage.filter((c) => c.count > 0 && c.count <= 5 && c.expectPass);
    const rareNegative = coverage.filter((c) => c.count > 0 && c.count <= 5 && !c.expectPass);

    if (uncoveredValid.length > 0 || uncoveredNegative.length > 0 || rareValid.length > 0 || rareNegative.length > 0) {
        console.log('\n┌──────────────────────────────────────────────────┐');
        console.log('│          Feature Rarity Report                    │');
        console.log('└──────────────────────────────────────────────────┘\n');

        if (uncoveredValid.length > 0) {
            console.log(`Uncovered valid features (${uncoveredValid.length}):`);
            for (const c of uncoveredValid) {
                console.log(`  ⚠ ${c.feature}`);
            }
        }

        if (uncoveredNegative.length > 0) {
            console.log(`\nUncovered negative-test features (${uncoveredNegative.length}):`);
            for (const c of uncoveredNegative) {
                console.log(`  ⚠ ${c.feature}`);
            }
        }

        if (rareValid.length > 0) {
            console.log(`\nRare valid features (≤5 appearances, ${rareValid.length}):`);
            for (const c of rareValid.slice(0, 15)) {
                console.log(`  · ${c.feature}: ${c.count}`);
            }
            if (rareValid.length > 15) {
                console.log(`  ... and ${rareValid.length - 15} more`);
            }
        }

        if (rareNegative.length > 0) {
            console.log(`\nRare negative-test features (≤5 appearances, ${rareNegative.length}):`);
            for (const c of rareNegative.slice(0, 15)) {
                console.log(`  · ${c.feature}: ${c.count}`);
            }
            if (rareNegative.length > 15) {
                console.log(`  ... and ${rareNegative.length - 15} more`);
            }
        }
    }
}
