# Local AEON playground

The website's editor, AEON Composer, examples, mode controls and AES/Data/
Annotation Stream/Canonical views, served locally against this checkout's
TypeScript workspace. No PHP, website checkout, registry bundle or deployment is
required. UI provenance and adaptations are recorded in `provenance.json`.
This AEON page compiles and displays inert property literals; it has no Resolve
or Query action. For property evaluation, open the separate
[SANSA source playground](https://github.com/AltoPelago/sansa/blob/main/README.md#source-playground)
with a matching built AEON checkout. The
[property-selector matrix](../../docs/property-selector-support.md) distinguishes
these two pages and the intentional legacy CLI/LSP denials. Local source or
Composer/highlighter behavior does not establish deployed website or installed
editor support.

From the AEON repository root, with Node 20+ and pnpm available:

```sh
pnpm --dir implementations/typescript install --frozen-lockfile
npm run playground
```

Open <http://127.0.0.1:4175/tools/playground/>. The command builds the required
browser packages before serving, then watches package sources and TypeScript
configuration. A successful rebuild reloads the browser's modules, retaining the
editor input and selected mode/view when session storage is available. Build
failures are marked in the header; partial module outputs are not served while
building. UI asset edits appear on browser refresh. Restart after dependency,
package manifest or workspace layout changes.

The runtime is **local TypeScript**, and SANSA is the dependency selected by this
checkout's frozen workspace graph. Compiled modules, source maps and TypeScript
sources are served from their actual packages; the playground does not fetch or
replace dependency pins. It does not represent Rust, WASM or Python execution.
The identity and empty-key examples exercise the current read-only selector and
structural-reference boundaries; they do not introduce new selector semantics.
AEON highlighting uses the workspace lexer's token types and original source
spans. It has no separate AEON scanner or syntax fallback. Unknown token kinds,
lexical gaps and sources above 1,048,576 UTF-16 code units display as escaped
plain text; the compiler's validation and limits remain unchanged. The original key, datatype, tag, literal, reference and comment palette is retained
through presentation roles over lexer tokens; unclassified identifiers retain the
original default foreground. No AEON source is rescanned for highlighting.
JSON colouring and optional &ND decoration inside doc-comment tokens remain
separate presentation helpers.
The inherited Composer materializes values and cannot safely reconstruct reference
or SANSA literals. For those sources it keeps the editor text unchanged and asks
you to edit directly. All inspection/output views remain available.

Composer reads the runtime's value AST and preserves binding identities, typed
tuples, composite attribute contents and anonymous-element headers (identity,
attributes and datatype). SANSA's selected parser/renderer classifies and builds
its structural row paths, so a quoted body key such as `"@name"` remains a member.
Child rows are indexed once per render/build; the obsolete fallback Composer is
removed. Output formatting runs only for the selected view, including the padded
AES table. Header events are identified by the runtime source plane, never by
quoted key text. Typed WTC values use the runtime datetime value type while
retaining their authored datatype and raw value. Opening/reloading requires a
complete parse; Apply rechecks the current source and generated text before
replacing it. Strict/custom datatype repair still uses the actual relaxed parser,
and changed source requires reloading Composer. Large AES displays retain all
cell text in tab-separated columns when a cell exceeds 80 code units or total
alignment padding would exceed 64 KiB. These are presentation allowances, not
runtime or performance-budget changes. Mounted Composer regressions compare canonical output before/after
Apply through the actual runtime and canonicalizer. These UI repairs do not alter
runtime grammar, reference admission or selector semantics.

Its lexical preflight is capped at 1,048,576 UTF-16 source code units before
tokenization. This local composer allowance does not change runtime parser limits.

```sh
npm run playground -- --port 4176
npm run playground -- --no-build --no-watch
npm run test:playground
```

`--no-build` requires existing workspace outputs. `--no-watch` disables automatic
rebuilding; rebuild and refresh manually after source edits. Invalid sources and
unsupported JSON projections appear in Diagnostics. Valid AEON does not always
have a JSON representation; use AES or Canonical to inspect those values.

The server binds to loopback and serves only playground assets and selected
workspace package source/output directories. No official release, version,
registry publication or deployment is performed by these commands.

Highlighting delegates to the selected workspace `@altopelago/aeon-highlight`
package. The editor/diagnostic adapter remains local; there are no copied token
renderers or JSON/&ND helpers in this playground. The default build includes the
highlight package, and its public exports are served through the workspace map.

## Highlight themes

Use **Highlight theme** in the local header:

1. **Current** keeps the current palette, with blue node tag names (`#3DA2F3`) distinct from gold structural identities.
2. **Equal lightness & chroma** keeps each role's hue, with OKLCH L=0.78 and C=0.10 for all syntax colours.
3. **More chroma for values** keeps L=0.78, with C=0.07 for keys/types/metadata/comments/punctuation and C=0.14 for values.

Values here are strings, numeric/radix literals, booleans/other literals, temporal
values, symbols and SANSA address literals. Addresses continue to match symbols.
JSON keys use the key role and JSON values use the corresponding value roles;
JSON projection does not retain AEON-specific temporal/symbol token types.

**Adjust OKLCH** exposes shared lightness/chroma sliders; theme 3 additionally
exposes value chroma, kept strictly above base chroma. **Reset preset** restores
that preset's defaults. Settings persist for the current tab across refreshes and
source rebuilds when session storage is available. Hues are fixed, derived from
the existing sRGB palette. These experimental overrides affect local code
surfaces only; background and site UI colours remain unchanged. OKLCH channels
are authored values; the browser maps them to the display's gamut.

Choose **Examples → Highlight themes → Load example** to compare token roles.
Changing themes does not read/parse/rewrite source, change validation mode or
change results. This experiment does not change shared package defaults or ship
new themes to the websites. Releases and deployment remain held.

Node tag names use the blue hue from `#3DA2F3` (OKLCH approximately
`0.691 0.151 246.77`). In presets 2/3, the tag keeps hue 246.77 and
uses the shared structural lightness/chroma. Tag delimiters retain punctuation
colour; identities retain their separate gold hue.

## Property address literals

**Examples → Property address literals** exercises the selected implementation's
`&key("...")` / `&tag("...")` / `&headTag("...")` literal parsing, highlighting, AES representation,
JSON string projection and canonical output. These are inert SANSA values; this
AEON page does not evaluate selectors. The separate
[SANSA source playground](https://github.com/AltoPelago/sansa/blob/main/README.md#source-playground)
uses this SDK build for actual property Resolve and direct read-only Query, with
an independent logical property-inspection control and scope-aware examples.

AEON Composer continues to refuse lossy SANSA-literal reconstruction and keeps
source unchanged. Inspection views retain canonical scalar payloads rather than
serializing recursive qualifier convenience aliases. The Python CLI's detailed
compiled-AST JSON boundary remains closed for property literals; portable AES,
Telex and annotation-only output are the supported interchange alternatives.
These UI checks do not broaden Query/AEOS/mutation/reference admission or declare
full-profile/platform/performance readiness. Releases and deployment remain held.
