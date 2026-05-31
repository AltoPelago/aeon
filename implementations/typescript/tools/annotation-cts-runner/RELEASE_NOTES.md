# Release notes — @altopelago/aeon-annotation-cts-runner

## 0.9.3 - 2026-06-01

- Initial scaffold of annotation-stream CTS runner
- Adds CLI wrapper `aeon-annotation-cts-runner` to run annotation CTS suites
- Enforces deterministic binding semantics (nearest-indexed-descendant)
- Includes README and spec blurb in `specs/04-official/v1/comments-annotations-v1.md`

## Publishing checklist

- [ ] Bump `version` in `package.json`
- [ ] Run `pnpm install --frozen-lockfile --ignore-scripts`
- [ ] Run `pnpm publish:preflight` from the TypeScript workspace root
- [ ] Ensure `dist` contains `index.js` and types
- [ ] Tag the release with a signed `typescript/vX.Y.Z` tag after the release commit is on `main`
- [ ] Let the workspace npm publish workflow publish the package set

Notes: this package is a tooling runner and reuses CTS artifacts in the repository; it does not alter CTS semantics by itself.
