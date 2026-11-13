# TypeScript structural reference paths

Clone (`~`) and pointer (`~>`) wrappers consume shared SANSA structural path
grammar, lowering directly to the existing reference segment AST. AEON retains
its document-root shorthands, quoted-name decoding, trivia and diagnostics.
Successful Core validation requires an existing permitted binding and preserves
missing/forward/self-reference and attribute-depth rules. Positional references
remain positional across edits; an identity string is not occurrence continuity.

Default indexes are unsigned decimal 0..999999, without leading zeroes. Earlier
fractional/exponential/signed/underscore or oversized spellings could be
truncated/rounded by parseInt; they now fail. Correct those authored references
to the intended in-range integer; do not mechanically normalize malformed input
without checking its intended target. Quoted numeric keys and ordinary numeric
values retain their previous meanings. No larger-bound AEON option is added.

References exclude wildcard/range/parent/recursive/local-space/qualifier/contextual
and identity-selector steps, even if a selector happens to return one binding.
Structural identities on bindings remain metadata and uniqueness checks remain.
SANSA address literals retain their own broader address grammar.

Reference-safe canonicalization validates authored and rendered documents and
preserves concrete structural targets. Its ordering planner may reuse the same
operation's validated readonly authored emission; rendered validation stays fresh.
No cached target, engine/session/program API or expression replay format is
introduced. Portable AES retains structural targets and rejects unexpected
selection-bearing caller input rather than falling back to a cached path.

The shared cursor contract lives in SANSA's supported `parsing/selector-cursor`
subpath. Other implementations should share these semantics/fixtures through
their native grammar ownership, without copying the removed experimental framework.
