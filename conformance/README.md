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

Portable transport tests select AES Events snapshot 0.2 and Telex snapshot 0.2
for TypeScript and pure-Python, plus Film snapshot 0.3 for TypeScript readers.
These require type-descriptor-only generics while preserving exact numeric
clarifier strings. The Film claim remains decode-only; historical physical
generic tags exposed by syntax inspection are not accepted logical AES.
Historical snapshots remain unchanged. The new transport snapshots do not
promote the separate experimental canonical-ordering contract.
