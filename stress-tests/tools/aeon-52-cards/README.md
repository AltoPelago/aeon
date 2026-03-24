# AEON 52-Cards Harness

Systematic combinatorial interaction testing framework for AEON documents.

The harness generates structured AEON documents by combining language features
under controlled constraints, then evaluates parser and processor behavior
against language invariants.

Current status:
- useful stress and regression harness
- aligned to the tracked AEON v1 normative surface in the in-harness coverage ledger
- not a replacement for CTS or a full formal conformance suite

Alignment review:
- `SPEC-ALIGNMENT-REVIEW.md`

## Quick Start

```bash
npm i --cache .npm-cache --no-audit
npm run cards
```

## Scripts

| Script | Description |
|---|---|
| `npm run cards` | Full run — generate, evaluate, report |
| `npm run cards-summary` | Summary only — pass/fail counts |
| `npm run cards-verbose` | Verbose — per-document detail |
| `npm run cards-markov` | Full run + Markov exploration |
| `npm run cards-markov-only` | Markov walks only |
| `npm run cards-heatmap` | Display interaction heatmap |

## Options

| Flag | Description |
|---|---|
| `--verbose` | Show per-document evaluation details |
| `--summary-only` | Show only pass/fail summary |
| `--seed <n>` | Deterministic ordering seed |
| `--categories <a,b>` | Filter feature categories |
| `--max-docs <n>` | Cap total generated documents |
| `--markov` | Enable Markov-guided generation alongside pairwise |
| `--markov-only` | Run only Markov-guided generation |
| `--heatmap` | Print the interaction heatmap matrix |
| `--walks <n>` | Number of Markov walks (default: 200) |
| `--walk-depth <n>` | Max features per walk (default: 5) |
| `--show-walks` | Print the generated Markov walk sample table |
| `--show-walk-sources` | Print AEON source for the shown Markov walks |
| `--walk-sample-limit <n>` | Limit the number of shown Markov walks (default: all) |
| `--inversion <0-1>` | Survivorship-bias inversion strength (default: 0.7) |
| `--depth-tree-count <n>` | Number of recursive depth-tree documents to generate (default: 12) |
| `--depth-tree-depth <n>` | Max recursive depth for generated depth trees (default: 4) |
| `--depth-tree-width <n>` | Max child width for generated depth trees (default: 3) |
| `--depth-tree-invalid-rate <0-1>` | Chance to emit invalid forward/self/missing-reference mutations (default: 0.35) |
| `--depth-tree-comment-rate <0-1>` | Chance to inject comment-channel mutations into generated trees (default: 0.35) |
| `--show-depth-trees` | Print the generated depth-tree sample table |
| `--show-depth-tree-sources` | Print AEON source for the shown depth-tree samples |
| `--depth-tree-sample-limit <n>` | Limit the number of shown depth-tree samples (default: all) |
| `--depth-tree-only` | Generate and evaluate only the depth-tree corpus |
| `--preview-only` | Generate documents and show samples without evaluation |
| `--no-depth-tree-layout` | Disable whitespace/layout mutation variants for depth trees |

## Design

The harness operates on three layers:

1. **Feature Model** — describes AEON syntax elements and constraints
2. **Generation Engine** — produces AEON documents by combining features
3. **Evaluation Engine** — validates parser behavior and language invariants

### Feature Categories

Values · Containers · Keys · Attributes · Type Annotations · References ·
Comments · Layout · Nesting

### Invariant Classes

- Core Parse Stability
- SDK Finalize Stability
- Canonical Idempotency
- Annotation Isolation
- Structural Integrity
- Resource Limits

### Generation Strategies

**Pairwise** — Exhaustive pair combinations across all features. ~3,000 documents.

**Cross-category** — High-priority features from different categories.

**Boundary** — Structural limits (deep nesting, long keys, large lists).

**Depth trees** — Recursive typed binding/value trees that mix objects, lists,
tuples, nodes, scalars, and nested attributes under explicit depth and width
budgets. The generator can also emit layout-mutated variants to stress trivia,
separator, and indentation handling without changing structure. It can also
emit controlled invalid reference mutations so the same recursive trees cover
forward, self, and missing-target rejection paths, and optionally inject
comment-channel mutations so comment parsing is exercised alongside the same
deep structural cases.

**Markov walks** — Multi-feature sequences guided by the heatmap risk model
with survivorship-bias inversion. Prioritizes rare, high-risk, structurally
deep combinations over common paths. Configurable walk depth and inversion strength.

### Interaction Heatmap

A 9×9 category risk matrix scoring interaction danger between feature categories.
High-risk intersections (e.g. references × nesting: 0.9) are prioritized by the
Markov walker. View it with `npm run cards-heatmap`.

### Failure Minimization

When a failure is detected, the harness strips features one at a time until
a minimal reproducing document is found.

## Spec Basis

Based on `specs/04-official/v1/`:
- `AEON-spec-v1.md`
- `structure-syntax-v1.md`
- `value-types-v1.md`
- `comments-annotations-v1.md`
- `addressing-references-v1.md`
- `AEON-v1-compliance.md`

Important scope note:
- the harness reports normative coverage separately from implementation-only cases;
- the current ledger covers the tracked v1 areas used by this harness, including official conformance-floor cases;
- SDK/finalize checks are kept distinct from Core parse checks;
- permissive parser behavior such as trailing separators is explicitly labeled `impl-only`.

Current baseline:
- `4367/4367` documents passing
- `21441` invariant checks
- `114` features exercised
- normative ledger items: all covered
- implementation-only ledger items: covered and separated from normative claims

See `SPEC-ALIGNMENT-REVIEW.md` for the current gap list and patch plan.
