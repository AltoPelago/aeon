# Empty property keys and Unicode — development integration

> Historical development/prepublication checkpoint. AEON 0.17.0 and its selected
> public packages/downstreams are now published, with selected live websites
> deployed and staging owner-deferred. See [current migration/release status](migration-0.17.0.md).
> The retained source pins, candidate versions and holds below describe their
> original checkpoint; they are not current installation instructions or gates.


Ordinary property and attribute names may be empty strings. Root, an empty
property, a whitespace property and a missing property remain distinct. Exact
names and references are not normalized or case folded; duplicate decoded names
are still rejected. Node tags, identities and datatype/local-space names retain
their separate nonempty requirements.

The TypeScript development override and Rust source dependency select the same
combined SANSA revision. The retained archive and provenance are recorded in
`implementations/typescript/.candidate-packages/`; the staging helper checks its
checksum before installation. Previous archives remain unchanged. Namespace
identity aliases may select empty-named children while preserving structural
result paths. AEON references remain structural paths; identity reference and
identity mutation admission is unchanged.

## Conformance transition

Run `pnpm test:cts:empty-keys` from `implementations/typescript` for the amended
development contract. It retains every unaffected existing full-target check,
exercises the evolving affected targets, and uses the dedicated reference-safe
canonical target with the same two established exclusions. The generic lexical
canonical target is a separate profile and is not newly qualified here.

Historical commands, fixture bytes and assertions are unchanged. The development
gate executes historical Core 0.5 (299 selected cases), AES projection 0.4 (83),
and WASM Core 0.5 (299) and checks the exact set of superseded rejections,
including the empty-key cases below and the historical Core and AES rejections
of `radix16`.

- `core-addr-001b-empty-quoted-key-reject`
- `core-addr-001c-empty-quoted-path-segment-reject`
- `core-snippet-transport-003-empty-quoted-keys-reject`
- `aes-emission-001b-empty-quoted-key-reject`

The three Core differences apply to both TypeScript and WASM. These failures
explicitly disprove the old rejection claim; they are not reported as released
CTS passes. The evolving targets replace those expectations with acceptance and
retain duplicate, malformed, missing-target and non-property identifier checks.
New immutable promotion and released claim selection remain separate authority
and release work.

The original installed reference/forged/boundary checks, target-preservation
workflows and performance ceilings remain unchanged. Local integration does not
qualify final registry bytes or the complete supported platform matrix. Package
versions are not advanced. Official releases and deployment remain held.
