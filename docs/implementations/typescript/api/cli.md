# CLI API

Informative status: implementation documentation for the TypeScript `aeon` CLI.

## Package

- Entry point: [`implementations/typescript/packages/cli/src/main.ts`](../../../../implementations/typescript/packages/cli/src/main.ts)

## Commands

- `aeon version`
- `aeon check <file>`
- `aeon doctor`
- `aeon fmt [file]`
- `aeon inspect <file>`
- `aeon finalize <file>`
- `aeon bind <file>`
- `aeon integrity validate <file>`
- `aeon integrity verify <file>`
- `aeon integrity sign <file>`

## Common processing flags

- `--datatype-policy reserved_only|allow_custom`
- `--rich`
- `--strict`
- `--loose`
- `--recovery`
- `--max-input-bytes <n>`

## Output and materialization flags

- `--json`
- `--map`
- `--scope payload|header|full`
- `--projected`
- `--include-path <canonical-path>`
- `--annotations`
- `--annotations-only`
- `--sort-annotations`

## Bind-specific flags

- `--schema <schema.json>`
- `--profile <profile-id>`
- `--contract-registry <registry.json>`
- `--trailing-separator-delimiter-policy off|warn|error`

## Integrity flags

- `--public-key <path>`
- `--private-key <path>`
- `--replace`
- `--include-bytes`
- `--include-checksum`
- `--write`

## Notes

- `--rich` is a preset alias for `--datatype-policy allow_custom`.
- CLI flags are implementation-facing controls, not AEON document syntax.
- `aeon bind` applies additional runtime/schema stages beyond Core parsing and AES emission.

## Related implementation surface

- Runtime binding adapter: [`implementations/typescript/packages/cli/src/runtime-bind.ts`](../../../../implementations/typescript/packages/cli/src/runtime-bind.ts)
