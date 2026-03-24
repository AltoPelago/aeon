# AEON Implementation Guideline

This document captures the shared implementation shape that already exists across the TypeScript and Python AEON implementations.

Its purpose is to help new implementations, including Rust, start from the stable cross-language contract instead of copying one implementation's internal structure too literally.

The Rust bring-up now provides a third data point: the current spec and CTS are strong enough to stand up a real independent implementation for the currently covered lanes, and the remaining friction is mostly around user-facing CLI scope rather than the conformance core.

## Scope

This guideline is implementation-facing, not normative by itself.

Normative sources remain:

- `specs/04-official/v1/*`
- `cts/protocol/v1/*`
- `cts/*/v1/*`

When this document conflicts with the spec or CTS, the spec and CTS win.

## Normative Vs Reference Behavior

Treat these as normative:

- `specs/04-official/v1/*`
- `cts/protocol/v1/*`
- lane manifests and suite files under `cts/*/v1/*`

Treat these as reference behavior:

- `docs/implementations/*`
- TypeScript implementation details and tests
- Python implementation details and tests

Practical rule:

- if spec and CTS are clear, follow them directly
- if CTS is silent and TypeScript/Python agree, treat that as a strong hint
- if implementations disagree, do not assume Rust or any new implementation is wrong until the authority order is checked

## Semantic Core Vs Operational CLI

The Rust bring-up made one repo reality much clearer:

- `spec + CTS` define the semantic core well enough to build an independent implementation
- the TypeScript CLI contract tests still define a meaningful part of the current operational CLI behavior

In practice, that means:

- use `specs/04-official/v1/*` plus `cts/*/v1/*` to implement language semantics
- use the TypeScript CLI contract tests to pin user-facing command behavior where CTS is intentionally silent

This is not a weakness in the semantic spec. It is mainly a statement about where current CLI/runtime behavior is documented today.

## What A New Implementation Should Target First

Build the implementation in this order:

1. Core compile pipeline
2. CTS adapter surfaces for `core`, `aes`, `annotations`, and `aeos`
3. Canonical formatting
4. User-facing CLI parity
5. Extended runtime/finalization features

This mirrors the current repo reality:

- TypeScript is the broad reference implementation.
- Python is a narrower independent implementation that still passes the current CTS lanes it targets.

That combination is useful because it shows which behavior is truly portable and which behavior is still implementation-shaped.

## What CTS Actually Forces Today

A new implementation can reach a meaningful first milestone with the current lane coverage.

The existing suites are sufficient to drive:

- `core`
- `aes`
- `annotations`
- `aeos`
- `canonical`

That is enough to build:

- a real parser/compiler surface
- deterministic event emission
- annotation extraction
- AEOS schema validation over AES
- deterministic canonical formatting

It is not, by itself, enough to fully define:

- broad CLI parity
- `finalize` feature parity
- richer runtime or integrity tooling

Those surfaces still lean more heavily on implementation docs and TypeScript behavior than on language-neutral CTS.

One useful refinement from the Rust work:

- the current docs are sufficient to build a minimal `finalize` surface for JSON and map output over curated fixtures
- they are not yet strong enough to treat broader `finalize` parity as language-neutral by default

## Known Gaps Outside CTS

These areas were important in the Rust implementation, but they are still not fully captured by language-neutral CTS alone:

- usage/error text and exit-2 command-edge behavior
- human-readable diagnostic formatting
- CLI help text and formatter backup workflow details
- exact JSON payload shapes for `inspect`, `finalize`, `bind`, `doctor`, and `integrity`
- runtime projection and scope details, especially `bind` and `finalize`
- input-limit fail-closed behavior all the way through stdout suppression

One more repo-shape gap surfaced during Rust mode work:

- the official v1 docs and current CTS still model `mode` and datatype policy as separate concerns
- if AEON is meant to expose three semantic modes (`transport`, `strict`, `custom`), that should be promoted into the canonical spec and CTS instead of living only as implementation behavior

That promotion has now happened in the shared spec and CTS, but it exposed a follow-on portability trap:

- wrapper layers like profiles, runtime binders, and CLI presets must not silently restore old datatype-policy defaults after Core becomes mode-driven

Today, the most reliable source for those behaviors is the TypeScript CLI contract test suite.

There is also now a useful third confidence layer:

- repository stress fixtures

Those fixtures are not a substitute for CTS, but they are good at exposing parser and composition gaps that only appear when many valid features interact in one document.

## Recommendation For Future Implementers

The sequence that worked best in Rust was:

1. get the semantic core green against CTS
2. treat remaining mismatches as either:
   - a spec/CTS gap, or
   - a CLI/runtime parity gap
3. use the TypeScript CLI contract tests to close the operational parity gaps
4. run the repository stress fixtures as a hardening pass
5. feed any newly discovered portability traps back into the implementation docs

That keeps semantic correctness and CLI parity from getting conflated, while still making the implementation practically usable.

One additional lesson is now clear:

- semantic correctness does not guarantee implementation quality

Rust proved that the shared spec and CTS are strong enough to drive a third
implementation, but it also showed that a semantically correct implementation
can still make poor internal boundary choices and fall behind the TypeScript
implementation on large-input CLI performance.

Future implementations should therefore treat TypeScript as a useful positive
reference not only for behavior, but also for phase separation and ownership
discipline.

## Shared Architectural Model

Both current implementations follow the same high-level flow:

1. Read source as UTF-8 text.
2. Strip a leading BOM if present.
3. Tokenize.
4. Parse into a document model.
5. Resolve canonical paths.
6. Emit normalized assignment events.
7. Validate reference legality and mode/datatype rules.
8. Optionally derive annotation records in parallel.
9. Hand the assignment event stream to AEOS validation or finalization.

The important design rule is that AEON Core produces a deterministic assignment event stream, and downstream layers consume that stream without reinterpreting Core-owned semantics.

## Recommended Internal Boundaries

A new implementation should keep these concerns separate even if they live in the same crate or package:

- `lexer`
  Tokenization and lexical diagnostics only.
- `parser`
  Structural parsing, AST construction, and syntax diagnostics only.
- `core compile`
  Phase orchestration, fail-closed behavior, path resolution, event emission, and mode/reference checks.
- `annotations`
  Parallel metadata extraction that does not affect compile semantics.
- `aeos`
  Schema validation over AES only.
- `canonical`
  Deterministic formatting from source/parse state.
- `finalize`
  Deterministic projection from AES into JSON/map/node outputs.
- `cli`
  Thin wrapper over stable library surfaces plus CTS adapter entry points.

The main thing to avoid is blending Core, AEOS, and finalization semantics into one large pass. The existing codebases are simpler to reason about because these boundaries mostly hold.

## Core Compile Contract

The compile surface should behave like this:

- input: source text plus compile options
- output: `events`, `errors`, and optional header/annotation metadata
- default mode: fail-closed
- recovery mode: tooling-only and explicitly opt-in

Shared rules already visible in TS and Python:

- any non-recovery compile error suppresses normal event output
- recovery may emit partial events, but errors still remain authoritative
- explicit input-size limits fail closed before deeper processing
- canonical path rendering must be deterministic
- event ordering must follow source emission order

## Data Model Priorities

A new implementation should treat these representations as the stable backbone:

- source spans
- canonical paths
- assignment events
- diagnostics

Recommended rule: normalize early to the cross-language shapes that CTS compares, and keep richer internal structures behind that boundary.

## Common Portability Traps

The Rust bring-up exposed a few places where new implementations are likely to drift unless they are called out explicitly.

- Structured headers are syntax-sensitive and position-sensitive.
  They are not just ordinary bindings with a reserved key. They must appear before body bindings, and canonical formatting must preserve their normal binding rules.

- Annotation binding is source-offset driven.
  Event streams are not enough by themselves. Implementations need source-aware binding heuristics for inline, infix, forward, trailing, and unbound annotation cases.

- Structured comments need parser support, not just annotation extraction.
  The Rust bring-up exposed this when annotation-aware `inspect` output still failed on valid fixtures until Core learned to skip structured line and block comments during parsing.

- AEOS does not use the same adapter shape as the source lanes.
  `core`, `aes`, and `canonical` run through source-oriented CLI surfaces, but `aeos` uses the stdin/stdout result-envelope protocol.

- Canonical formatting is a parser/renderer problem.
  It is not just newline normalization. The canonical lane forces structural rendering, quoting rules, indentation, structured-header handling, and deterministic rejection behavior.

- Quoted keys and attribute/member path forms need structural representations.
  Treat them as parsed segments, not as ad hoc strings, or cross-language behavior tends to drift around canonical paths and reference targets.

- Minimal finalization depends on header metadata surviving Core.
  If Core lowers or hides structured header bindings, the implementation still needs an explicit header metadata channel for downstream `finalize` and `full` scope behavior.

- Mode-driven semantics can be lost in wrapper layers.
  The TypeScript update only became fully correct once the profiles compiler and runtime `bind` wrapper stopped forcing `reserved_only` when no explicit datatype-policy override was supplied. New implementations should check every compile wrapper, not just Core, for hidden defaults that override `transport|strict|custom`.

- Attribute projection depends on preserving attribute values, not just attribute shape.
  If Core keeps only attribute-target structure for reference validation, later `finalize` work will hit a hard ceiling when it needs real `@` output.

- Node-literal tooling parity depends on preserving node structure, not only raw node text.
  Rust only reached useful `inspect --json` parity for node attributes once Core carried node tag, attributes, datatype, and children alongside the raw literal.

- Stress fixtures expose cross-feature parser drift earlier than unit tests do.
  Rust only surfaced several remaining parser hardening gaps once it ran the repository stress corpus, including slash-channel comments, unterminated structured comments, namespace and escaped quoted-key addressing, multiline node introducers, trimticks mixed whitespace, and a large full-feature document.
  A follow-up Rust hardening pass cleared the parser-side cases and left one narrower difference: the full-feature stress document succeeds when Rust `inspect` is run with `--datatype-policy allow_custom`, so the remaining gap there is better understood as datatype-policy breadth than parser instability.

### Canonical Paths

Canonical paths are one of the most important shared contracts in the repo.

Implementation guidance:

- represent paths structurally, not only as strings
- format to canonical string form at explicit boundaries
- keep root/member/index distinctions explicit
- do not let implementation-specific AST shortcuts leak into output

### Diagnostics

Diagnostics should be created as structured values first and formatted only at the CLI edge.

The same rule applies to `inspect --json`: derive event and value JSON from shared library structures instead of hand-maintaining a second partial serialization in the CLI.
When a CTS-facing JSON surface depends on tiny object forms like reference path segments, preserve the expected serialized shape deliberately instead of assuming a generic map serializer will be neutral.

Prioritize these fields:

- `code`
- `path`
- `span`
- `phase`
- `message`

CTS generally treats `code`, `path`, and `phase` as normative, with `span` matched only where the suite asks for it.

### Assignment Events

Assignment events are the main portability contract.

A good implementation should keep them:

- ordered
- deterministic
- source-faithful
- free of hidden coercion

Do not finalize, resolve, or reinterpret values during Core event emission unless the spec explicitly requires it.

## Phase Ownership Rules

The current stack is healthiest when each layer owns a narrow responsibility:

- Core owns syntax, path resolution, event emission, reference legality, and mode/datatype enforcement.
- AEOS owns schema validation over AES.
- Finalization owns projection/materialization from AES.
- CLI owns presentation and adapter concerns.

In practice this means:

- AEOS should not re-own Core reference-legality failures.
- Finalization should not silently act like a resolver or application runtime.
- CLI commands should not invent semantics beyond what the library layers already define.
  But user-facing CLI parity can still include workflow details like backup-on-write behavior for formatters when the implementation docs/tests establish that contract.
  A practical AEOS runtime surface can start as a thin `bind` wrapper that composes Core compile, AEOS validate, and finalization without re-owning schema semantics in the CLI.
  Annotation output and schema-policy knobs like trailing-separator handling can be layered into that wrapper incrementally once the phase ordering is stable.
  Loose-mode runtime behavior is especially worth testing explicitly: Rust benefited from checking that schema failures still retain projected documents in loose mode while strict mode omits them.
  Direct schema JSON should be treated as a contract artifact, not a loose convenience input: Rust only got safer runtime behavior once `bind` rejected missing `schema_id`/`schema_version` metadata and non-canonical keys up front.
  If a runtime flag like `--profile` is accepted before full registry/profile execution exists, it should emit an explicit warning rather than being silently ignored.
  Trusted contract registries are a distinct runtime concern from direct schema files: Rust benefited from resolving header IDs through a registry, verifying artifact hashes, and only then loading schema/profile artifacts.
  When trusted contracts introduce datatype rules, compile-time datatype gating may need to defer to the contract-aware validation path; otherwise Core can reject values that the schema/profile layer is supposed to classify more precisely.
  Conflicting runtime presets should fail closed instead of silently overriding each other; Rust now rejects `--rich` combined with `--datatype-policy reserved_only` rather than guessing which one the caller meant.
  Integrity-envelope tooling is another good example of phase ownership: Rust kept it small by compiling with `allow_custom`, validating/reading the `envelope` subtree from events, and computing canonical hashes over the non-envelope event stream rather than teaching Core special envelope semantics.
  Operational health commands can often reuse the same contract machinery as the runtime path. Rust's `doctor` implementation stayed small by delegating registry inspection to the same artifact verification logic already used by `bind`.
  For cross-CLI parity, health check names may need to stay aligned even when the host runtime differs. Rust ended up using shared contract labels like `node-version` and `package-availability` so existing CLI expectations kept working without special casing a Rust backend.
  PEM-based Ed25519 signing and verification are a practical CLI boundary, not a Core concern. Rust was able to add `integrity sign` and `integrity verify --public-key` by parsing PKCS#8/SPKI keys at the CLI edge and signing the canonical hash payload directly.
  Envelope field lookup should normalize list-style path heads like `signatures[0]` back to their logical field family. Rust briefly misclassified signed envelopes as having unknown fields until the envelope validator stopped treating list indices as distinct top-level field names.
  Replace-mode signing is best modeled as a pre-sign source transform: Rust got cleaner behavior by removing any existing envelope first, then recomputing the canonical hash over the base document.
  GP security convention insertion belongs at the CLI workflow layer. Rust handled `integrity sign --write` by inserting or merging the `aeon.gp.security.v1`, `aeon.gp.integrity.v1`, and `aeon.gp.signature.v1` conventions into the structured header without changing Core parsing rules.
  CLI parity also depends on explicit negative-path diagnostics. Rust tightened the integrity workflow by surfacing `ENVELOPE_EXISTS` when signing without `--replace` and `ENVELOPE_SIGNATURE_KEY_MISSING` when a signature is present but no verification key was supplied, instead of failing silently.
  Human-readable diagnostics are part of the contract too. Rust had to align integrity warnings and errors to the shared `ERROR [CODE] message` / `WARN [CODE] message` shape because downstream tests and operators often rely on those exact forms, not just the JSON output.
  Usage text is contract surface as well. Rust needed follow-up cleanup so `integrity` subcommands reported the same `Error:` and `Usage:` lines as the TypeScript CLI for missing files, conflicting flags, and missing key paths instead of returning generic internal errors.
  Default contract locations should be derived from the workspace, not hard-coded to a developer machine. Rust had to replace an absolute local `contracts/registry.json` path in `doctor` with a workspace-relative lookup to make the CLI portable across checkouts.
  The same command-edge discipline applies outside `integrity`: Rust still had meaningful CLI drift until `check`, `fmt`, and `finalize` matched the shared usage/error behavior for missing files, invalid datatype policy values, `--write` without a path, and projected finalization without `--include-path`.
  Resource-limit flags are part of the contract on every command that accepts input. Rust had to add `--max-input-bytes` handling to `finalize` as a real command feature rather than leaving it as a `check`/`fmt`-only concern.
  `inspect` has the same command-edge expectations as the rest of the CLI. Rust needed a final cleanup pass so missing files, invalid datatype-policy values, and invalid depth-limit flags all fail with the expected usage-oriented diagnostics rather than generic parser errors.
  Runtime commands should converge on the same limit and usage model. Rust still had one more parity gap until `bind` picked up `--max-input-bytes`, projected-output usage checks, and fuller help text alongside the rest of the CLI.
  Input-limit failures should suppress normal stdout payloads. Rust had to tighten both `inspect` and `bind` so oversized inputs behave like the rest of the CLI: emit the limit message on stderr, exit non-zero, and avoid printing partial markdown/JSON payloads that would confuse callers.
  Shared CLI render helpers make parity tests much stronger. Rust improved the signal from `doctor` and `integrity` contract tests once payload and line rendering lived in reusable helpers instead of being reassembled ad hoc inside each test.
  Once command-edge cleanup is mostly done, switch to fixture-exact tests. Rust got much better signal by asserting exact `inspect` markdown and baseline `finalize` JSON against the shared fixture corpus, which is a faster way to detect meaningful parity drift than adding more generic command tests.
  Keep extending fixture coverage into already-supported modes. Rust still found useful gaps once it started pinning recovery-mode `inspect`, strict typed/untyped switch fixtures, symbolic-reference rendering, and formatter stdin behavior, even though the underlying features already existed.
  Don’t neglect scope and required-flag contracts. Rust kept improving parity by pinning `finalize` projected/full-scope shapes, `inspect --annotations` markdown sections, and `bind`'s required `--schema` or `--contract-registry` rule, even though those were mostly adapter-level guarantees rather than new language features.
  Negative-path registry contracts deserve exact tests too. Rust got better parity signal once unknown contract IDs and artifact verification failures were checked against their full `Error [CODE]: ...` message shape instead of only asserting that the code string appeared somewhere in the output.
  The repository-bundled registry deserves its own parity coverage. Rust found it useful to test both the happy path against `contracts/registry.json` and a GP `datatype_rules` failure against the same baseline contracts, because that verifies the shipped contract set rather than only temp-fixture registries.
  Some remaining “CLI parity” failures are actually Core semantics. Rust only matched the TypeScript contract for `check` and fail-closed `inspect` once duplicate canonical paths and mixed structured/shorthand headers were rejected in Core itself, rather than trying to special-case those fixtures at the command layer.
  Formatter failure output is contract surface too. Rust still had a small but real drift until `fmt` reused the same structured diagnostic-line rendering as `check`, so invalid-input output included stable `path=` and `message=` fields instead of bare display strings.
  Plain success-path CLI output deserves the same treatment as JSON. Rust made the integrity commands easier to pin by moving non-JSON warning/`OK` rendering into a shared helper, so tests could assert the exact line order and wording instead of only checking exit codes.
  For `finalize --map`, entry shape includes both containers and descendants. Rust only got an honest parity test once the map fixture checks reflected that objects/lists appear alongside their nested member/index entries, rather than assuming a flattened leaf-only map.
  The same is true for runtime output: exact `bind` tests for projected output, header-only scope, and annotation-bearing documents are much better parity checks than isolated field assertions, because they lock the command to the same document/meta structure future implementations will need to reproduce.

## Determinism Requirements

A new implementation should assume determinism is a feature, not a polish step.

Required habits:

- stable event ordering
- stable diagnostic ordering
- stable annotation ordering when sorted output is requested
- no timestamps in machine-readable output
- no absolute paths in deterministic snapshots
- no map/object ordering that depends on hash iteration

For Rust specifically, this means preferring deterministic iteration strategies at output boundaries.

## CLI Guidance

Treat the CLI as an adapter over the library, not the source of truth.

Recommended command priorities:

1. `inspect`
2. `fmt`
3. CTS envelope adapter entry points
4. `finalize`
5. richer binding/runtime commands

Important current repo reality:

- the TypeScript CLI is the broadest user-facing contract
- Python currently implements a smaller surface focused on CTS-relevant commands

So a Rust CLI should start with the smallest surface that unlocks conformance and then expand.

## Minimum Viable Implementation Order

The bring-up order that worked in practice is:

1. `core`
2. `aes`
3. `annotations`
4. `aeos`
5. `canonical`
6. broader CLI surfaces
7. `finalize` and wider runtime behavior

This order matters.

- `core` and `aes` establish the event model
- `annotations` proves source-position handling
- `aeos` proves the event model is usable by a separate validator layer
- `canonical` proves the implementation can reparse and render deterministically
- broader CLI work is safer after those contracts are stable
- a minimal `finalize` surface becomes much easier once header metadata and deterministic event ordering are already in place

## What Is Actually Normative Today

A new implementation should trust these first:

- official v1 spec text
- CTS manifests and lane contracts
- runner protocol documents

It should treat these as secondary but highly informative:

- TypeScript CLI/output docs
- TypeScript tests
- Python behavior where it already passes CTS

This distinction matters because some repo behavior is well implemented before it is fully generalized into language-neutral conformance artifacts.

## Current Gaps To Expect

The current specs and runners are strong enough to build a real Rust implementation, but not every surface is equally frozen.

Known pressure points:

- `finalize` behavior is better documented in implementation docs/tests than in language-neutral CTS
- user-facing CLI parity is stronger in TypeScript than in current cross-language conformance lanes
- canonical formatting has a lane, but not every implementation wrapper currently runs it in the same way
- some appendix-level and boundary-language docs remain tracked as follow-up or decision-needed items

This means a Rust implementation should be used as a spec-gap detector, not only as a feature port.

## What Rust Showed

The Rust implementation gives a useful read on current implementation readiness.

What turned out to be implementation work, not spec failure:

- event and diagnostic normalization for `core` and `aes`
- source-aware annotation binding
- AEOS envelope transport and schema checks
- canonical rendering for the current baseline fixtures

What still remains more implementation-defined than lane-defined:

- richer CLI contract details beyond CTS
- `finalize` behavior and related user-facing output surfaces
- broader runtime and integrity tooling

What the Rust `finalize` work clarified:

- a small library-first finalizer over AES is practical without pulling runtime semantics back into Core
- projected materialization needs path-prefix logic, not simple exact-path matching
- JSON and map outputs can be brought up incrementally before broader bind/runtime parity
- typed clone-reference finalization depends on Core datatype checks resolving through reference targets, not treating the reference token as the final value kind

Useful conclusion:

- the current spec plus CTS is sufficient for the conformance core
- the next portability risks are mostly outside the current lane set

## Recommended Rust Bring-Up Plan

1. Implement a minimal library-first Core pipeline.
2. Add a thin CTS adapter binary that can satisfy `core`, `aes`, `annotations`, and `aeos`.
3. Run the language-neutral suites before building a broad CLI.
4. Add canonical formatting and run canonical CTS.
5. Add `inspect` as the first human-facing CLI command.
6. Add `finalize` only after Core and canonical behavior are stable.
7. Compare behavior against both TS and Python when CTS is silent.

## How To Use TS And Python As References

Use TypeScript for:

- widest feature coverage
- CLI/output-contract examples
- runtime/finalization/profile layering

Use Python for:

- proof that the Core/CTS model is portable
- simpler end-to-end structure
- a good reference for the minimum viable conformance surface

Do not require Rust to mirror either implementation's exact module graph.
Mirror the contracts, boundaries, and deterministic behaviors instead.

## Definition Of Done For A New Implementation

A new implementation is in a good first-release state when it can show:

- passing `core` CTS
- passing `aes` CTS
- passing `annotations` CTS
- passing `aeos` CTS
- passing canonical CTS
- stable `inspect` CLI behavior
- comment-aware parsing so annotation-bearing source behaves the same in Core and CLI surfaces
- explicit documentation of any intentionally unsupported surfaces

At that point, remaining differences are likely to be either:

- genuine spec/CTS gaps
- broader CLI/runtime feature work
- non-normative implementation choices

That is the right moment to tighten the Rust-specific roadmap without drifting away from the portable AEON contract.
