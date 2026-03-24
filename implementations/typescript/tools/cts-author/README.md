# @aeon/cts-author

CTS authoring utilities for AEON and AEOS conformance suites.

## Quick Start

```bash
aeon-cts-author lint ./cts/core/v1/core-cts.v1.json
```

## Command

- `aeon-cts-author lint <manifest.json> [--json]`

## What It Checks

The linter validates:

- top-level manifest shape
- suite file references
- duplicate suite and test ids
- basic test fixture shape
- referenced spec paths when present

## Output

- prints `OK` when no issues are found
- prints one line per issue in text mode
- emits structured JSON with `--json`
