# Repo Paths And Env Defaults

Primary scripts:

- `scripts/repo-paths.mjs`
- `scripts/repo_paths.py`
- `scripts/run-with-repo-paths.mjs`

## Why this exists

Many script workflows need sibling repositories (`aeonite-cts`, `aeonite-specs`, tooling) but local checkout roots vary by developer machine and CI.

These helpers provide one shared resolution strategy so script behavior is consistent.

## Resolution order

For each root, scripts use:

1. explicit environment variable override
2. default sibling path under the `aeon-family` workspace

Environment variables:

- `AEONITE_CTS_ROOT`
- `AEONITE_SPECS_ROOT`
- `AEON_TOOLING_ROOT`
- `AEON_TOOLING_PRIVATE_ROOT` (legacy alias)

## `run-with-repo-paths.mjs`

Wrapper command:

```bash
node ./scripts/run-with-repo-paths.mjs <command> [args...]
```

Behavior:

- injects resolved repo-path environment values for the child process
- rewrites the first `--cts <path>` argument to the resolved CTS root
- preserves all other arguments unchanged
- exits with the child process status code

Example:

```bash
node ./scripts/run-with-repo-paths.mjs \
  node ./scripts/cts-source-lane-runner.mjs \
  --sut ./implementations/typescript/packages/cli/dist/main.js \
  --cts ./cts/core/v1/core-cts.v1.json \
  --lane core
```

## Troubleshooting

- If a path points to the wrong checkout, print the current values:
  - `echo "$AEONITE_CTS_ROOT"`
  - `echo "$AEONITE_SPECS_ROOT"`
- If unset, set explicit overrides before running lane/stress scripts.
