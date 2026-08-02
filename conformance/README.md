# Conformance Claims

This directory records the CTS snapshots claimed by the maintained AEON
implementations in this repository.

`cts-claims.json` is machine-readable implementation metadata. It identifies the
exact CTS snapshot ids claimed by TypeScript, Rust, and Python, plus the local
command used to run each lane.

Validate the claim file against the sibling CTS checkout with:

```bash
npm run validate:cts-claims
```

The claim file records implementation/package versions, not AEON language
versions. Specification authority remains with `aeonite-org/aeonite-specs`; CTS
authority remains with `aeonite-org/aeonite-cts`.
