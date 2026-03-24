# Internal Release Archive

This directory is archival.

It preserves a historical internal packaging snapshot from the earlier `0.0.1`
workspace state:

- `manifest.json`
- `SHA256SUMS`

These files are not the authoritative release metadata for the current
`0.9.0` implementation state, and they are not used by the normal build, test,
or CTS flows in this repo.

If a future release process needs fresh artifact metadata, it should be
generated from a real packaging run rather than editing these files in place.
