# Fuzz Artifact Inbox

This directory is the staging area for reduced or interesting fuzz findings
before they are promoted into the shared stress corpus.

Intended flow:

1. discover an input via Rust fuzzing
2. reduce or minimize it enough to be reviewable
3. run tri-implementation adjudication with `scripts/stress-fuzz-artifacts.py`
4. copy it here with metadata using `scripts/stress-promote-artifact.py`
5. decide whether it should become:
   - a shared stress fixture under `stress-tests/`
   - a CTS candidate
   - an implementation-only regression
   - a discarded or superseded artifact

This folder is for reviewable staging, not for bulk libFuzzer output.

Each staged artifact should live in its own subdirectory containing:

- `artifact.aeon` or `artifact.bin`
- `meta.json`
- optional `notes.md`

The metadata is meant to capture:

- source artifact path
- fuzz target
- current triage status
- intended promotion target
- observed implementation outcomes

Once a case is promoted into `stress-tests/`, the inbox copy can either stay as
historical context or be removed if it no longer adds value.
