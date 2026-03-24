# @aeos/cts-runner

AEOS Conformance Test Suite Runner

## Usage

```bash
aeos-cts-runner --sut ./path/to/validator --cts ./path/to/cts.json [--strict]
```

## Options

| Option | Description |
|--------|-------------|
| `--sut <path>` | Path to validator executable (SUT) |
| `--cts <path>` | Path to CTS JSON file |
| `--strict` | Enable strict mode |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All tests passed |
| 1 | Functional test failures |
| 2 | Conformance violations |
| 3 | Runner/config/SUT error |

## Example

```bash
# Run CTS against aeos-core validator
aeos-cts-runner --sut ./packages/aeos/dist/bin/aeos-validator.js --cts ../../cts/aeos/v1/aeos-validator-cts.v1.json
```
