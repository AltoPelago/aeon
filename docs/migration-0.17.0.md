# Migrating to AEON0.17

Status: 0.17.0 stable preparation, 25 November 2026. The exact RC3 registry and
selected downstream/combined configuration is accepted. Stable provider artifacts,
locks/generated outputs, independent stable-delta QA, required hosted checks and
actual stable installed consumers remain required. Existing runtime, target,
capability and resource contracts are retained; metadata alone proves no upload.

This document records the source contract and release-preparation snapshot,
not live registry availability. Completed publication is tracked by the signed
implementation tags, [GitHub releases](https://github.com/AltoPelago/aeon/releases)
and exact registry/consumer receipts; frozen preparation notes are historical
after those gates pass. Experimental profile/CTS statuses remain independent.

## Addressing and references

AEON clone/pointer references use constrained SANSA structural paths. Shared
parsing does not admit identity/property/recursive selectors into references.
Legacy index spellings that violate the SANSA grammar are rejected; use supported
ordinary indexes and canonical structural paths. Target preservation remains
mandatory during canonicalization, replay and native/portable transport.

Read-only child identity selection provides stable-by-name selection among direct
children within an authorized scope, while results keep their actual structural
paths. Chained identities traverse successive child relationships. Duplicate local
matches are ambiguous and identity reuse does not prove mutation continuity.
Instruction/Mutate/SO and reference admission retain their existing explicit gates.

## Properties and consumer boundaries

`&key("name")` tests an authoritative exposed member key. `&tag("book")` selects a
node container, and `&headTag("book")` selects a direct node head. Migrate earlier
unpublished head-target predicates explicitly. Metadata-looking fields on arbitrary
objects are not authoritative; incoming keys outside a scoped root stay hidden.

The[owning support matrix](property-selector-support.md) controls exact entrypoints:
capable TS/Rust SDK Resolve/direct Query, pure-Python standalone Resolve, existing
native Pytonic Query and selected portable AEOS. Pure Python has no Query evaluator.
Native-event AEOS/LSP and incapable legacy CLI/workbench adapters stay denied;
Core/native/WASM literal parsing and transport do not activate selectors.

Empty ordinary object/attribute keys are accepted with the normal duplicate-key
rules. `$.[""]` is an empty member address, distinct from `$`. Empty identities,
tags and local-space names are not introduced. Mixed empty-member/identity paths
must retain text/AST parity. Unicode identities remain exact without implicit
normalization; use explicitly supported casing/locale profiles and documented
native limits. Older readers may reject newly legal empty-key documents.

## Packaging, native ports and resources

TS packages form one18-package release roster including optional
`@altopelago/aeon-highlight`. Rust crates and Python distributions keep their own
release tags and supported platforms. The native distribution is`altopelago-aeon`;
pure-Python source metadata is separate, with no implicit native fallback.
Public Rust enum/option/diagnostic changes may require downstream source updates;
follow the implementation README/API notes and existing namespace constructors.

Final npm/Cargo provider dependencies must be the exact reviewed registry artifacts
with matching locks, replacing development-only overrides/source pins. A sibling
build or archive hash is not registry availability. Review native/wheel and WASM
outputs against their exact inputs and pinned toolchains, not just source tests.

Logical identity/property allowances do not bound all namespace construction,
ancestry, projection/highlighting or allocation costs. Preserve independent parser,
result, validation and mutation limits plus unchanged compatibility/target tests.
Existing1.15x latency/1.20x memory budgets and stop/no-retry rules remain. The
recorded identity V8 heap nonqualification stays narrow; no property-cost waiver
or full-platform performance acceptance is implied by this guide.

## Hosts and deferred work

The AEON local playground compiles/displays inert literals. The separate SANSA
source playground evaluates Resolve/Query through actual engines and a matching
built AEON checkout. Editor coloring and a successful source build do not prove
installed host/browser/clipboard/vendor support; use exact final artifacts.

Newline clarification/warnings and local first/last/fromFirst/fromLast selectors
are deferred to tentative0.17.1. Arithmetic, Type Transpiler, Go/PHP, new comparison
policies and new identity mutation/SO/recursive/reference admission remain outside
this release task. No source feature is silently added by advancing versions.
