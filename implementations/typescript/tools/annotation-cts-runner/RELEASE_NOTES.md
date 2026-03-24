# Release notes — @aeon/annotation-cts-runner

## 0.9.0 (unreleased)

- Initial scaffold of annotation-stream CTS runner
- Adds CLI wrapper `aeon-annotation-cts-runner` to run annotation CTS suites
- Enforces deterministic binding semantics (nearest-indexed-descendant)
- Includes README and spec blurb in `specs/04-official/v1/comments-annotations-v1.md`

## Publishing checklist

- [ ] Bump `version` in `package.json`
- [ ] Run `pnpm install` then `pnpm run build`
- [ ] Run `pnpm run typecheck` and package tests (if any)
- [ ] Ensure `dist` contains `index.js` and types
- [ ] Tag the release in git and push tag
- [ ] Run `pnpm publish --access public` from package folder (or use your release automation)

Notes: this package is a tooling runner and reuses CTS artifacts in the repository; it does not alter CTS semantics by itself.
