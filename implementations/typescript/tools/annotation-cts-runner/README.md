# @aeon/annotation-cts-runner

Annotation stream conformance runner for AEON.

## Usage

```bash
aeon-annotation-cts-runner --sut ./path/to/aeon-cli --cts ./path/to/annotation-stream-cts.v1.json
```

## Options

| Option | Description |
|--------|-------------|
| `--sut <path>` | Path to the AEON CLI executable (`inspect` command is used as SUT surface) |
| `--cts <path>` | Path to annotation CTS JSON file |
| `--strict-spans` | Require exact span equality for tests that include expected spans |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All tests passed |
| 1 | Functional test failures |
| 3 | Runner/config/SUT error |

## Binding semantics

This runner enforces the annotation-stream binding semantics used by the TypeScript reference implementation: when a structured comment's span could attach to multiple targets within a container, the binder prefers the nearest indexed descendant element (for example, `$.a[0]` over `$.a`). CTS fixtures in `cts/annotations/v1/` reflect this deterministic nearest-indexed-descendant policy.

If your SUT implements a different deterministic policy, update the CTS expectations accordingly or open an issue to discuss aligning the policy in the spec.
