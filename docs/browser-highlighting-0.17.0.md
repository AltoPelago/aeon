# Browser highlighting for AEON 0.17.0

16 November 2026. Package preparation on `feat/browser-highlight-package`, based
on AEON main `accf679291a7851ec434f41168a4778d82703b0d`, independently of ongoing
PR #197. No changes to that branch, runtime source, CTS claims, reference/target
contracts or performance budgets are required. Releases and deployment stay held.

## Ownership and API

AEON owns optional `@altopelago/aeon-highlight`, depending only on its lexer. The
pure renderer, explicitly registered web component and scoped dark/light themes
have separate public entry points. It follows the existing TypeScript release
version, currently `0.17.0-rc.1`. Host-specific editor grammars stay in tooling.
No DOM registration occurs on import, and runtime/core consumers do not acquire a
browser dependency. The full npm publication roster and clean-consumer smoke must
include the new package; publication still requires the existing release decision.

The initial renderer/presentation helpers originate in AEON playground PR #197 at
`cd987f82ac041f0b6a55d2c782f3293c4be71a9a`; its implementation is reused without
changing that branch. Internal JSDoc supplies declaration types. The component is
a new shell inspired by tooling's existing component; it deliberately leaves
site-specific languages and expansion controls with their owning consumers.

## Consumer assessment and migration order

| Consumer and inspected revision | Current implementation | Required migration |
| --- | --- | --- |
| AEON local playground, PR #197 | Lexer renderer plus editor/diagnostic adapter | After package approval, replace renderer/helper copies with package imports; retain watch, source maps, diagnostic and composer guards. Do not modify the active PR as part of this branch. |
| AEON website, PR #11 | Copied lexer renderer plus page-specific runtime maps | Stage package from the selected 0.17.0 graph; replace copies, retaining PHP import maps, static docs, font/palette and candidate/default boundaries. Do not silently upgrade the released 0.16.0 graph. |
| Aeonite website, main `bc4c328b6e55fa18e886103d47b120c5789ba3db` | `site/assets/js/aeon-code-block.js` has a separate AEON scanner, light component, static enhancement, JSON/TS/grammar renderers and expansion UI | Replace only its AEON scanner with the package renderer, bundled through its existing asset pipeline. Preserve other languages, copy/expand/focus behavior and light palette. Audit generated/minified output and source paths. |
| SANSA local playground, main `8f2976e7c71cf796f9f62701e6d2ed13451ff004` | Custom AEON scanner; server discovers selected AEON workspace package exports | Import package via the selected AEON checkout, retain editor adapter and SANSA Query/source-language highlighting. Prove startup with the selected package built, source-map/module paths and existing target-preservation tests. No SANSA runtime dependency. |
| Tooling browser component, main `9b552ac0b44491622241cc1e2d563ab07f7f6cff` | Separate regex scanner and component | Migrate demo/component consumer to package; remove duplicate scanner after equivalent coverage and an explicit legacy-import transition. Keep VS Code/Sublime/Tree-sitter/QuickLook tracks independent. |

Aeonite's light palette is confirmed in source: surface `#ffffff`, foreground
`#1b1b1b`, keys `#006f56`, types `#5d5a8d`, strings `#7a5c1f`, literals `#526c20`,
comments `#767676`. These existing semantic values form the light theme. Explicit
symbol/identity/address colours fill categories without previous styles. Browser
checks must prove the actual site still uses these values; package theme tests
are not site-adoption evidence. Its dirty README/specs-lock/test changes and
SANSA's independent work are preserved.

## Checklist

- [x] Create isolated ordinary worktree under `worktrees/aeon/` from merged main.
- [x] Add pure lexer renderer, optional explicit component and scoped themes.
- [x] Record both additional consumers and the distinct Aeonite light palette.
- [x] Add package to the existing TypeScript release roster and installed smoke;
  retain all original compatibility/target checks and performance ceilings.
- [x] Pass 14 renderer/public-API tests, 137 unchanged lexer tests and 33 existing
  version/release-workflow tests, plus two new side-effect-policy tests.
  Build/typecheck and dependency checks pass.
- [x] Verify final local tarballs in a fresh offline consumer: exact lexer
  dependency, SSR imports, DOM-free and browser declarations, CSS exports and
  byte-identical installed runtime files. Browser verifies both themes, source
  updates, empty/hostile/malformed input and exact Unicode source preservation.
- [ ] Review/merge the package independently of PR #197. Fresh frozen installation
  and owning CI remain required; local cached-toolchain checks cannot replace them.
- [ ] Migrate tooling and the AEON playground/website after their active reviews;
  select exact local artifacts without publishing or changing released defaults.
- [ ] Migrate Aeonite's AEON renderer while preserving its non-AEON languages,
  expansion UI and light colours; verify generated assets and browser behavior.
- [ ] Migrate SANSA's AEON panel using the selected AEON package; preserve its own
  selector syntax, adapters and compatibility/target checks.
- [ ] Verify the combined 0.17.0 artifacts and clean consumers, then obtain the
  existing release/adoption decision. Releases and deployment remain held.

## Verification limits

Fresh offline installation initially failed because cached registry metadata lacks
an unrelated pinned LSP version. With only the additive highlight workspace link
in the lockfile, frozen resolution succeeds, but a pinned `@types/node@26.6.6`
tarball is missing from the local store. No dependency ranges or pinned resolutions
were changed. Local compilation reuses the exact previously installed TypeScript
7.0.2 / Node types artifacts from the retained verification environment. A fresh
frozen install is still an open release gate. No benchmark or new V8 heap
qualification is claimed.

The [verification receipt](browser-highlighting-0.17.0.json) retains artifact
hashes, exact theme observations and limits. The live demonstration loads packed
consumer files; it does not use workspace module fallbacks. Copy permission,
all supported browser engines and full combined release qualification remain
consumer/release checks, not claims of this package-preparation checkpoint.

The existing package preflight also passes for an isolated two-package (lexer
and highlight) workspace. Negative controls reject JavaScript side effects in
the new package and CSS side effects in existing packages. The only metadata
exception is the highlight package’s two exact exported CSS assets, which
bundlers must retain. The full workspace preflight is still a combined release
gate; this scoped run does not claim it.
