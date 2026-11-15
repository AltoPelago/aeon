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
- [x] Pass 15 renderer/public-API tests, 137 unchanged lexer tests and 33 existing
  version/release-workflow tests, plus two new side-effect-policy tests.
  Build/typecheck and dependency checks pass.
- [x] Verify final local tarballs in a fresh offline consumer: exact lexer
  dependency, SSR imports, DOM-free and browser declarations, CSS exports and
  byte-identical installed runtime files. Browser verifies both themes, source
  updates, empty/hostile/malformed input and exact Unicode source preservation.
- [x] Merge the package in #198 and local playground in #197. Fresh frozen installation
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

CI follow-up: the publish-surface guard requires its recognized release-policy
record for a new public package; that record is now in
[release strategy](release-strategy.md#optional-browser-highlighting-package-in-typescript-0170).
The inherited JSON helper’s quoted-string regex was replaced with a bounded
string walk, with escaped-quote/key-spacing/malformed-tail regressions. This
separate JSON presentation helper does not tokenize AEON. No guard, security
query or target check is suppressed.

## QA-2026-0072 remediation

The initial component did not observe the selected template's separate content
fragment. The real-browser lifecycle fixture reproduces the reviewed head with
3/11 passing controls and 8 stale-display failures. The fix watches the selected
fragment, changes that watch when source priority/selection changes, observes
script type changes, and disconnects both observers when detached. All 11 browser
cases pass against a freshly installed local tarball, including ordinary text,
script, empty-attribute and property controls. Getter/display source consistency
is verified; no real clipboard write or full browser matrix is claimed. Node
renderer/API tests and TypeScript build/typecheck still pass. The shared runtime,
reference/target guards and performance budgets are unchanged.

## Shared consumer integration

The AEON playground now delegates to the public package and builds it by default;
its local adapter retains positional diagnostic calls. Existing 68 playground,
composer/version/release checks and 17 package tests pass. Duplicate renderer and
JSON/&ND files are removed. The additive provider-only `./renderer` entry allows
legacy and candidate websites to bind the same rendering logic to their actual
selected lexer. It loads neither a lexer nor a DOM itself, preserving the released
0.16 graph while the default package/element remain on the matching 0.17 graph.
Consumer checks must prove both profiles; no silent runtime upgrade is implied.

### Consumer migration review checkpoint — 16 November 2026

- [x] Prepare AEON playground/provider entry in [#199](https://github.com/AltoPelago/aeon/pull/199). 17 package + 68 existing tooling checks pass.
- [x] Prepare website [#12](https://github.com/AltoPelago/aeon-website/pull/12), preserving released/candidate lexer graphs; 72 tests pass.
- [x] Prepare tooling [#3](https://github.com/AltoPelago/aeon-tooling/pull/3); 11 highlighter + 3 converter checks pass. Converter tests use a worktree sibling-path loader.
- [x] Prepare Aeonite website [#8](https://github.com/AltoPelago/aeonite-website/pull/8); 56 pinned-input tests and reproducible bundle check pass. Retain light theme and site language/expansion controls.
- [x] Prepare SANSA playground [#47](https://github.com/AltoPelago/sansa/pull/47); 548 pass, 92 optional-runtime skips.
- [x] Browser-smoke the two source playgrounds, default website and tooling demo; verify Aeonite light rendering and expansion close/focus return. Preserve all 11 original helper hashes and frozen performance manifest.
- [ ] Complete owning review/current-head CI and merge #199 before its dependent migrations; verify the resulting main combination.
- [ ] Replace development-only SHA-pinned tarballs with qualified exact registry artifacts at release; complete fresh install, clipboard/browser matrix and final release acceptance.

These are source integration results, not full native/registry acceptance or new
performance measurements. Compatibility and target-preservation checks and
1.15× latency/1.20× memory ceilings are unchanged. Releases/deployment stay held.

## Numeric, temporal and address colours — 16 November 2026

- [x] Distinguish lexer numeric/hex/radix (`tok-number`) and date/time/datetime
  (`tok-temporal`) tokens; retain other literal roles and source spans.
- [x] Add cyan/light-yellow dark defaults and readable cyan/ochre light defaults.
  SANSA address literals inherit the symbol colour. JSON numbers use numeric colour.
- [x] Pass 19 package tests and 68 playground/release checks; consumer suites pass
  (website72, tooling14, Aeonite56, SANSA548 with92 optional skips).
- [x] Verify actual computed dark/light colours and Aeonite expanded-code colours;
  refresh exact development archives, staged renderer and generated bundle.
- [ ] Complete owning PR reviews/CI/merges and resulting-main verification.

This changes presentation only. Existing compatibility/target-preservation checks
and performance budgets remain unchanged. Releases and deployment stay held.
