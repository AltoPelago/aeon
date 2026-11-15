# @altopelago/aeon-highlight

Optional lexer-backed AEON rendering for browsers and server-side HTML generation.
Prepared for the TypeScript 0.17.0 release; publication is on hold.

```js
import {highlightAeon} from '@altopelago/aeon-highlight';
const html = highlightAeon('name\\id\\:string="Hello"');
```

The renderer uses `@altopelago/aeon-lexer`, original UTF-16 source spans and escaped
source text. It preserves text, gaps and malformed input; it has no custom AEON
scanner. Sources above `MAX_HIGHLIGHT_SOURCE_CODE_UNITS` (1,048,576) render as
escaped plain text without lexing. This presentation allowance does not change
compiler/parser limits. This API renders text; it does not validate documents or
resolve references or identities.

`highlightAeon(source, {diagnosticLine, diagnosticColumn})` optionally marks a
one-based line and UTF-16 column. `highlightJson(source)` is a separate presentation
helper. Optional &ND decoration is confined to lexer-classified doc comments.
Both JavaScript entry points can be imported without a DOM. Core/runtime packages do
not depend on this package.

## Optional custom element

```js
import {defineAeonCodeBlock} from '@altopelago/aeon-highlight/element';
defineAeonCodeBlock(); // Explicit, idempotent browser registration.
const block = document.createElement('aeon-code-block');
block.setAttribute('theme', 'light'); // Omit for dark.
block.setAttribute('title', 'Example');
block.code = source; // Exact source, including empty strings and trailing newlines.
document.body.append(block);
```

`code` property overrides the `code` attribute; otherwise source comes from a
nested `script[type="text/plain"]`, a template's content, or text content. Empty
attributes are respected. Source is not trimmed. For arbitrary source use the
property rather than interpolating HTML. Light-DOM edits and edits within the selected template content update the display;
disconnecting the element disconnects its observer. `show-copy="false"` hides
the copy button. Register only one implementation per tag; a foreign existing
definition is rejected rather than assumed to support this API. Copy uses the browser clipboard API following a button click;
unavailable clipboard access is reported in a live status region.

The component is an AEON code block. Site-specific expansion controls, JSON,
TypeScript, grammar rendering and navigation remain consumer responsibilities.

## Themes

For renderer output, load either exported stylesheet and wrap it in
`<pre class="aeon-highlight"><code>…rendered HTML…</code></pre>`:

- `@altopelago/aeon-highlight/theme.css`: existing AEON dark palette.
- `@altopelago/aeon-highlight/theme-light.css`: existing Aeonite light palette.

Styles are scoped to `.aeon-highlight`. The component carries equivalent shadow
styles and uses `theme="light"` for the light palette. Consumers can override
`--aeon-*` custom properties on the wrapper/element. Names used as keys, types or
tags retain their distinct existing colours; unclassified identifiers retain the
foreground. Symbols, identities and SANSA addresses have explicit theme colours.

## Development

From `implementations/typescript`:

```sh
pnpm --filter @altopelago/aeon-highlight... build
pnpm --filter @altopelago/aeon-highlight... typecheck
pnpm --filter @altopelago/aeon-highlight... test
```

The [consumer migration checklist](../../../../docs/browser-highlighting-0.17.0.md)
keeps adoption separate from package preparation and PR #197.

### Browser lifecycle regression

`test/browser/element-lifecycle.html` and its module execute real DOM mutation
cases, including selected-template edits/replacement, source precedence, script
type changes and disconnect/reconnect. Copy both files into the root of a local
packed consumer alongside `node_modules`, serve that root over loopback, open the
page and press **Run lifecycle tests**. The import map uses the installed package
and lexer; it has no workspace fallback. This browser fixture is separate from
the Node-only test command above. Clipboard permissions and the browser-engine
matrix remain release qualification checks.

## Hosts with a selected lexer

`@altopelago/aeon-highlight/renderer` exports `createHighlighter(lexer)` and the
`Highlighter`, `LexerProvider` and diagnostic option types. This entry loads no
lexer or DOM. Supply the actual implementation namespace selected by the host:

```js
import * as lexer from '@aeon/lexer'; // The host page's existing import map.
import {createHighlighter} from '@altopelago/aeon-highlight/renderer';
const {highlightAeon, highlightJson} = createHighlighter(lexer);
```

This keeps legacy website 0.16 and candidate 0.17 tokenization tied to their own
selected runtimes. Consumers must test those exact provider artifacts. The root
and element entries retain their matching 0.17 lexer dependency and unchanged
APIs. Provider rendering does not add a parser or a fallback scanner.

Numbers (including radix/hex literals) use `tok-number` / `--aeon-number`;
dates, times and datetimes use `tok-temporal` / `--aeon-temporal`. Dark defaults
are cyan `#7dd3fc` and light yellow `#f5e6a8`; light-theme equivalents are
`#006b80` and `#806500`. SANSA address literals retain `tok-sansa` and inherit
`--aeon-symbol`. Booleans and other literals retain `--aeon-literal`. JSON
numbers use the numeric colour too. These are presentation roles over existing
lexer tokens and do not change parsing or reference semantics.
