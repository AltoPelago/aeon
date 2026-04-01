# Contributing

AEON is public and readable, but this repository is not run as a standard
open-contribution project.

The governance model is described in [GOVERNANCE.md](./GOVERNANCE.md). The short
version is:

- implementation authority lives in this repo
- release and merge authority stay with the maintainer
- outside pull requests are not assumed to be part of the default workflow

## What is welcome

- clear bug reports
- reproducible interoperability or canonicalization mismatches
- CTS gaps and parity findings
- documentation fixes
- forks, downstream tooling, and independent implementations

## Before opening a pull request

- do not assume an unsolicited PR will be merged
- prefer opening an issue first for non-trivial changes
- if the change touches canonicalization, diagnostics, CTS, or security
  behavior, include the concrete failing case and expected outcome
- keep changes narrowly scoped and avoid bundling unrelated cleanup
- run `bash ./scripts/pre-commit-check.sh` so tracked files do not introduce
  local filesystem paths into the public repo

## Development expectations

- run the relevant implementation tests for the area you changed
- for cross-implementation behavior, prefer the shared stress or CTS lanes
- keep canonical and diagnostic behavior deterministic across implementations
- avoid changing generated build artifacts unless the source change requires it

## Good contribution shape

- a minimal repro
- the intended contract or authority surface
- focused code changes
- tests or corpus additions that lock the behavior in

## Security issues

Do not use normal public issues for suspected vulnerabilities. Follow
[SECURITY.md](./SECURITY.md) instead.
