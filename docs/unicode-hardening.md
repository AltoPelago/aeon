# Unicode hardening regression contract and capability inventory

These implementation regression vectors exercise existing AEON identity, SANSA
value/selector and AEOS length contracts. They do not allocate a new profile,
change normalization, promote a CTS snapshot or create a released conformance
claim. The data source is `aeonite-cts/fixtures/unicode-hardening/v1.json`;
consumer copies must match its bytes. Initial SHA-256: `41b0e1b55ffed9d3a4f9263ad95aa9340e9e0f5bca3fd8687174f1d5dbd4e9a5`.

| Operation | Required behavior / advertised surface |
| --- | --- |
| Exact keys, reference targets and canonical ordering | Retain decoded scalar sequences without normalization, case folding or ambient-locale comparison. TypeScript, Rust, pure Python and affected native facades exercise distinct keys, references, duplicate controls and canonical fixed points. |
| Default string equality and lower/upper | Existing SANSA JS/shared Rust/native Query surfaces retain exact equality and full default mapping. Casing is an implementation slice: record runtime/Unicode data rather than claiming a future locked version. Pure Python's standalone resolver does not expose Query/default case-conversion APIs. |
| Explicit locale profile | SANSA JS requires supported tr/az/lt fixtures to execute, using one complete string profile for comparison and casing. Invalid locale syntax fails through Intl; valid unsupported locales retain standard Intl fallback, recorded separately from requested locale. Shared Rust/native named locale profiles are rejected through the existing unsupported-profile boundary. No ICU provider is added. |
| Name-pattern ?/* | One code point / zero or more code points, including LF, CR, U+2028/U+2029. This is not grapheme matching. JS, Rust and pure Python Resolve keep original handles, ordering and structural paths; admitted Query consumers reuse that behavior. |
| AEOS min_length/max_length | UTF-16 code units, including ordinary, attribute, attribute-path, datatype and existing alternate-constraint routes. Do not substitute scalar or UTF-8 byte counts. Resource limits retain their separately specified units. |
| Search presentation | Both websites use explicit Unicode default lowercase for query/index-field matching, not ambient locale. Excerpts map transformed offsets back to original UTF-16 positions, retaining surrogate pairs. Result-title ties explicitly select English presentation collation. No normalization/full-casefold search claim is made. |

Default-casing fixtures include Greek final sigma, sharp-s and ligature expansion,
Kelvin/fullwidth mappings and dotted I. Locale cases include Turkish/Azeri and
Lithuanian context. Identity controls include canonical/compatibility lookalikes,
combining sequences, Hangul/Jamo, confusables, zero-width and variation selectors.
The fixture records escaped strings, code points, operation, locale and expected
values. Required supported cases must not be silently skipped. Unsupported or
unexposed APIs are distinct from passing tested capabilities.

Unicode data version is part of evidence: record Node/ICU/CLDR/Unicode, Python
and its Unicode database, and Rust/compiler library versions. Explicit locale
vectors establish bounded provider behavior, not universal cross-version
collation conformance. Preserve complete-profile requirements and equality/order
agreement; no Exact/Custom policy API is added. Normalization, full folding,
grapheme APIs and universal locale providers remain separate work.

References: existing AEON Value Semantics v1, AEOS v1 section 5.14, SANSA
Addressing/Resolve and Query; Unicode SpecialCasing 17.0 at
https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt. The 17.0 file is a
reference for established sample mappings, not a claim that every runtime uses
that data version. Source canonicalization is not Unicode normalization.

This candidate document and the shared fixture need owning review. Immutable
snapshot bytes and existing claim IDs stay unchanged; authority promotion and
release artifact/provider qualification remain separate gates.
