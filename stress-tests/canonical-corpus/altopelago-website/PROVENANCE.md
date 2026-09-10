# AltoPelago Website Corpus

These fixtures were derived from `AltoPelago/aeon-website/content` at commit
`9c2e1479652a634b67cd2f8733a739cac732b0f3` on 8 September 2026. The snapshot
includes all 35 website documents.

The initial import exposed issues in eight documents:

- `developer-start.aeon`
- `language.aeon`
- `orthogonal-composition.aeon`
- `playground.aeon`
- `templating.aeon`
- `value-types.aeon`
- `walkthrough-advanced.aeon`
- `walkthrough.aeon`

Those sources were corrected alongside this corpus: literal backslashes in
embedded AEON examples are escaped, multiline embedded source uses backtick
strings, and the JavaScript newline escape is represented as `\\n`. Rust's
canonical string parser was aligned with the TypeScript and Python behavior.
All 35 snapshots are now part of the positive three-implementation gate.
