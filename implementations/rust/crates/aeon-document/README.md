# AltoPelago AEON Document

`altopelago-aeon-document` is the immutable, capability-aware document graph
used by the public Rust AEON facade. It is imported as `aeon_document`.

The graph is built from successful AEON Core output and preserves portable
event metadata, explicit capability states, ordered topology, attribute-space
ownership, and payload/header/full-document views. It remains independent of
SANSA; the optional SANSA runtime adapter lives in `altopelago-aeon`.

This crate is an implementation API, not AEON specification authority. See the
[AltoPelago AEON project](https://github.com/AltoPelago/aeon) for the complete
implementation and conformance documentation.
