(function () {
  const BLOCK_COMMENT_TYPES = [
    { begin: "/#", end: "#/", type: "comment-doc" },
    { begin: "/@", end: "@/", type: "comment-annotation" },
    { begin: "/?", end: "?/", type: "comment-hint" },
    { begin: "/{", end: "}/", type: "comment-structure" },
    { begin: "/[", end: "]/", type: "comment-profile" },
    { begin: "/(", end: ")/", type: "comment-future" },
    { begin: "/*", end: "*/", type: "comment" }
  ];

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function wrap(type, value) {
    return `<span class="tok-${type}">${escapeHtml(value)}</span>`;
  }

  function wrapRaw(type, html) {
    return `<span class="tok-${type}">${html}</span>`;
  }

  function renderAndInline(value) {
    const parts = [];
    const pattern = /(\\[\[\]|\\]|\[\*[\s\S]*?\]|\[\/[\s\S]*?\]|\[\$[\s\S]*?\]|\[@[\s\S]*?\]|\[(?: |x|=|\.|_|<)[^\]]*\]|\|)/g;
    let index = 0;

    for (const match of value.matchAll(pattern)) {
      const token = match[0];
      const start = match.index ?? 0;
      if (start > index) {
        parts.push(escapeHtml(value.slice(index, start)));
      }

      if (token.startsWith('\\')) {
        parts.push(wrap('and-escape', token));
      } else if (token === '|') {
        parts.push(wrap('and-table-pipe', token));
      } else if (/^\[(?: |x|=|\.|_|<)/.test(token)) {
        parts.push(wrap('and-invalid', token));
      } else if (token.startsWith('[*')) {
        parts.push(wrap('and-strong', token));
      } else if (token.startsWith('[/')) {
        parts.push(wrap('and-emphasis', token));
      } else if (token.startsWith('[$')) {
        parts.push(wrap('and-code', token));
      } else if (token.startsWith('[@')) {
        const link = /^(\[@)(.*?)(\|)(.*)(\])$/.exec(token);
        if (link) {
          parts.push(
            wrap('and-link', link[1] + link[2]) +
            wrap('and-link-separator', link[3]) +
            wrap('and-link-target', link[4]) +
            wrap('and-link', link[5])
          );
        } else {
          parts.push(wrap('and-link', token));
        }
      }
      index = start + token.length;
    }

    if (index < value.length) {
      parts.push(escapeHtml(value.slice(index)));
    }

    return parts.join('');
  }

  function renderDocComment(value) {
    return value
      .split('\n')
      .map((line) => {
        if (/^\s*(?:\/#|#\/)\s*$/.test(line)) {
          return wrap('comment-doc', line);
        }

        const header = /^(\s*)(&ND)(\s+v[0-9]+)?(.*)$/.exec(line);
        if (header) {
          return escapeHtml(header[1]) + wrap('and-header', header[2]) + (header[3] ? wrap('and-version', header[3]) : '') + wrapRaw('comment-doc', renderAndInline(header[4]));
        }

        const codeFence = /^(\s*)(`{3,})([A-Za-z0-9_+.-]+)?(.*)$/.exec(line);
        if (codeFence) {
          return escapeHtml(codeFence[1]) + wrap('and-fence', codeFence[2]) + (codeFence[3] ? wrap('and-fence-label', codeFence[3]) : '') + wrapRaw('comment-doc', renderAndInline(codeFence[4]));
        }

        const extensionFence = /^(\s*)(\+{3})([A-Za-z0-9_./+-]+|fallback)?(.*)$/.exec(line);
        if (extensionFence) {
          return escapeHtml(extensionFence[1]) + wrap('and-extension-fence', extensionFence[2]) + (extensionFence[3] ? wrap('and-extension-name', extensionFence[3]) : '') + wrapRaw('comment-doc', renderAndInline(extensionFence[4]));
        }

        const rule = /^(\s*)(---)(\s*)$/.exec(line);
        if (rule) {
          return escapeHtml(rule[1]) + wrap('and-rule', rule[2]) + escapeHtml(rule[3]);
        }

        const quote = /^(\s*(?:>\s*)+)(.*)$/.exec(line);
        if (quote) {
          return wrap('and-quote', quote[1]) + wrapRaw('and-quote-text', renderAndInline(quote[2]));
        }

        const heading = /^(\s{0,3})(#{1,6})(\s+.*)$/.exec(line);
        if (heading) {
          return escapeHtml(heading[1]) + wrap('and-heading-marker', heading[2]) + wrapRaw('and-heading', renderAndInline(heading[3]));
        }

        const list = /^(\s*)(-\s+|\d+\.\s+)(.*)$/.exec(line);
        if (list) {
          return escapeHtml(list[1]) + wrap('and-list-marker', list[2]) + wrapRaw('and-list-text', renderAndInline(list[3]));
        }

        return wrapRaw('comment-doc', renderAndInline(line));
      })
      .join('\n');
  }

  function findBlockCommentStart(line) {
    let match = null;
    for (const candidate of BLOCK_COMMENT_TYPES) {
      const index = line.indexOf(candidate.begin);
      if (index === -1) continue;
      if (!match || index < match.index) {
        match = { index, ...candidate };
      }
    }
    return match;
  }

  function tokenizeLine(line, state) {
    if (state.blockString) {
      const endIndex = line.indexOf("`");
      if (endIndex === -1) {
        return {
          html: wrap("string", line),
          state
        };
      }

      state.blockString = false;
      return {
        html: wrap("string", line.slice(0, endIndex + 1)) + tokenizeLine(line.slice(endIndex + 1), state).html,
        state
      };
    }

    if (state.blockComment) {
      const endIndex = line.indexOf(state.blockComment.end);
      if (endIndex === -1) {
        return {
          html: state.blockComment.type === "comment-doc" ? renderDocComment(line) : wrap(state.blockComment.type, line),
          state
        };
      }

      const current = state.blockComment;
      state.blockComment = null;
      return {
        html:
          (current.type === "comment-doc"
            ? renderDocComment(line.slice(0, endIndex + current.end.length))
            : wrap(current.type, line.slice(0, endIndex + current.end.length))) +
          tokenizeLine(line.slice(endIndex + current.end.length), state).html,
        state
      };
    }

    if (/^\s*\/\/#/.test(line)) return { html: renderDocComment(line), state };
    if (/^\s*\/\/@/.test(line)) return { html: wrap("comment-annotation", line), state };
    if (/^\s*\/\/\?/.test(line)) return { html: wrap("comment-hint", line), state };
    if (/^\s*\/\/!/.test(line)) return { html: wrap("comment-host", line), state };
    if (/^\s*\/\/\{/.test(line)) return { html: wrap("comment-structure", line), state };
    if (/^\s*\/\/\[/.test(line)) return { html: wrap("comment-profile", line), state };
    if (/^\s*\/\/\(/.test(line)) return { html: wrap("comment-future", line), state };
    if (/^\s*\/\//.test(line)) return { html: wrap("comment", line), state };

    const backtickIndex = line.indexOf("`");
    if (backtickIndex !== -1) {
      const before = tokenizeLine(line.slice(0, backtickIndex), state).html;
      const after = line.slice(backtickIndex);
      const endIndex = after.indexOf("`", 1);

      if (endIndex === -1) {
        state.blockString = true;
        return {
          html: before + wrap("string", after),
          state
        };
      }

      return {
        html: before + wrap("string", after.slice(0, endIndex + 1)) + tokenizeLine(after.slice(endIndex + 1), state).html,
        state
      };
    }

    const blockComment = findBlockCommentStart(line);
    if (blockComment) {
      const before = tokenizeLine(line.slice(0, blockComment.index), state).html;
      const after = line.slice(blockComment.index);
      const endIndex = after.indexOf(blockComment.end);

      if (endIndex === -1) {
        state.blockComment = blockComment;
        return {
          html: before + (blockComment.type === "comment-doc" ? renderDocComment(after) : wrap(blockComment.type, after)),
          state
        };
      }

      return {
        html:
          before +
          (blockComment.type === "comment-doc"
            ? renderDocComment(after.slice(0, endIndex + blockComment.end.length))
            : wrap(blockComment.type, after.slice(0, endIndex + blockComment.end.length))) +
          tokenizeLine(after.slice(endIndex + blockComment.end.length), state).html,
        state
      };
    }

    const patterns = [
      ["space", /\s+/y],
      ["directive", /\baeon:[A-Za-z][A-Za-z0-9_.:-]*\b/y],
      ["node-open", /<[A-Za-z_][A-Za-z0-9_:-]*/y],
      ["attr-open", /@\{/y],
      ["attr-close", /\}/y],
      ["key", /(?:[A-Za-z_][A-Za-z0-9_:-]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')(?=\\[A-Za-z0-9_-]+\\)/y],
      ["typed-key", /(?:[A-Za-z_][A-Za-z0-9_:-]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')(?=\s*:)/y],
      ["key", /(?:[A-Za-z_][A-Za-z0-9_:-]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')(?=\s*(?:@\{|=))/y],
      ["string-template", /`(?:\\.|[^`])*`/y],
      ["symbol", /\|(?:\\.|[^|\\\r\n])+\|/y],
      ["string", /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/y],
      ["datetime", /\b\d{4}-\d{2}-\d{2}T\d{2}(?::\d{2})?(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?&[A-Za-z0-9_./+-]+\b/y],
      ["datetime", /\b\d{4}-\d{2}-\d{2}T\d{2}(?::\d{2})?(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?\b/y],
      ["time", /\b\d{2}:(?:\d{2})?(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?\b/y],
      ["date", /\b(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{4}-)(?![0-9T-])/y],
      ["wtc", /\b(?:Z&|&)(?:[A-Za-z0-9_./+-]+)\b/y],
      ["null-reason", /!"(?:\\.|[^"])*"|![A-Za-z_][A-Za-z0-9_]*/y],
      ["nan", /[+-]?NaN\b/y],
      ["infinity", /[+-]?Infinity\b/y],
      ["bool", /\b(?:true|false)\b/y],
      ["switch", /\b(?:yes|no|on|off)\b/y],
      ["identity", /\\[A-Za-z0-9_-]+\\/y],
      ["sansa", /(?<![~A-Za-z0-9_$?])[$?](?:\.(?:\\[A-Za-z0-9_-]+\\|[A-Za-z_][A-Za-z0-9_]*|\*{1,2}|@|\["(?:\\.|[^"\\])*"\]|<"(?:\\.|[^"\\])*">)|\[(?:0|[1-9][0-9]*)\])*(?![A-Za-z0-9_])/y],
      ["number-sigil", /[#%$^][^\s,\])}]+/y],
      ["float", /(?<![A-Za-z0-9_])[+-]?\d[\d_]*\.[\d_]*(?:[eE][+-]?\d[\d_]*)?(?![A-Za-z0-9_])/y],
      ["number", /(?<![A-Za-z0-9_])[+-]?\d[\d_]*(?:[eE][+-]?\d[\d_]*)?(?![A-Za-z0-9_])/y],
      ["binding", /~>\s*\$?(?:\.?[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\["(?:\\.|[^"])*"\]|\.@\.(?:[A-Za-z_][A-Za-z0-9_]*|\["(?:\\.|[^"])*"\]))+/y],
      ["binding", /~\$?(?:\.?[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\["(?:\\.|[^"])*"\]|\.@\.(?:[A-Za-z_][A-Za-z0-9_]*|\["(?:\\.|[^"])*"\]))+/y],
      ["operator", /=/y],
      ["punct", /[<>.,()[\]{}]/y],
      ["type", /:[A-Za-z_][A-Za-z0-9_]*(?:<[^>\n]+>|\[[^\]\n]+\])?/y],
      ["attribute-key", /[A-Za-z_][A-Za-z0-9_:-]*(?=\s*=)/y],
      ["identifier", /[A-Za-z_][A-Za-z0-9_:-]*/y]
    ];

    let html = "";
    let index = 0;

    while (index < line.length) {
      let matched = false;

      for (const [type, re] of patterns) {
        re.lastIndex = index;
        const match = re.exec(line);
        if (!match) continue;

        matched = true;
        index = re.lastIndex;

        switch (type) {
          case "space":
            html += match[0];
            break;
          case "node-open":
            html += wrap("tag-punct", "<") + wrap("tag", match[0].slice(1));
            break;
          case "attr-open":
          case "attr-close":
            html += wrap("attribute-punct", match[0]);
            break;
          case "typed-key":
          case "key":
            html += wrap("key", match[0]);
            break;
          case "type":
            html += wrap("punct", ":") + wrap("type", match[0].slice(1));
            break;
          case "attribute-key":
            html += wrap("attribute", match[0]);
            break;
          case "directive":
            html += wrap("directive", match[0]);
            break;
          case "string":
          case "string-template":
            html += wrap("string", match[0]);
            break;
          case "symbol":
            html += wrap("symbol", match[0]);
            break;
          case "datetime":
          case "time":
          case "date":
          case "wtc":
          case "null-reason":
          case "nan":
          case "infinity":
          case "bool":
          case "switch":
          case "number-sigil":
          case "float":
          case "number":
            html += wrap("literal", match[0]);
            break;
          case "identity":
            html += wrap("identity", match[0]);
            break;
          case "sansa":
            html += wrap("sansa", match[0]);
            break;
          case "binding":
            html += wrap("binding", match[0]);
            break;
          case "operator":
            html += wrap("operator", match[0]);
            break;
          case "punct":
            html += wrap("punct", match[0]);
            break;
          default:
            html += escapeHtml(match[0]);
        }
        break;
      }

      if (!matched) {
        html += escapeHtml(line[index]);
        index += 1;
      }
    }

    return { html, state };
  }

  function highlightFromColumn(html, column) {
    const target = Math.max(0, column - 1);
    const openTags = [];
    let output = "";
    let index = 0;
    let visibleIndex = 0;
    let marked = false;
    let markedContent = false;

    const startMark = () => {
      for (let tagIndex = openTags.length - 1; tagIndex >= 0; tagIndex -= 1) {
        output += "</span>";
      }
      output += '<span class="aeon-diagnostic-line">';
      for (const tag of openTags) output += tag;
      marked = true;
    };

    while (index < html.length) {
      if (!marked && visibleIndex >= target) startMark();

      if (html[index] === "<") {
        const end = html.indexOf(">", index);
        if (end === -1) break;
        const tag = html.slice(index, end + 1);
        output += tag;
        if (tag.startsWith("</")) {
          openTags.pop();
        } else {
          openTags.push(tag);
        }
        index = end + 1;
        continue;
      }

      if (html[index] === "&") {
        const end = html.indexOf(";", index);
        if (end !== -1) {
          output += html.slice(index, end + 1);
          index = end + 1;
          visibleIndex += 1;
          if (marked) markedContent = true;
          continue;
        }
      }

      output += html[index];
      index += 1;
      visibleIndex += 1;
      if (marked) markedContent = true;
    }

    if (!marked) startMark();
    if (!markedContent) output += "&#8203;";
    return `${output}</span>`;
  }

  function highlightAeon(source, diagnosticLine = null, diagnosticColumn = 1) {
    const state = { blockComment: null, blockString: false };
    return source
      .split("\n")
      .map((line, index) => {
        const html = tokenizeLine(line, state).html;
        return index + 1 === diagnosticLine
          ? highlightFromColumn(html, diagnosticColumn)
          : html;
      })
      .join("\n");
  }

  function highlightJson(source) {
    return source.replace(
      /("(?:\\.|[^"])*")(\s*:)?|\b(true|false)\b|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g,
      (match, str, colon, bool, num, punct) => {
        if (str) {
          return colon
            ? `<span class="json-key">${escapeHtml(str)}</span>${escapeHtml(colon)}`
            : `<span class="json-string">${escapeHtml(str)}</span>`;
        }
        if (bool) return `<span class="json-bool">${match}</span>`;
        if (match === "null") return '<span class="json-null">null</span>';
        if (num) return `<span class="json-number">${match}</span>`;
        if (punct) return `<span class="json-punct">${match}</span>`;
        return escapeHtml(match);
      }
    );
  }

  function attachHighlightEditor(textarea, backdrop) {
    const editor = textarea.closest(".highlight-editor");
    let gutter = editor?.querySelector(".highlight-line-numbers") ?? null;
    if (editor && !gutter) {
      gutter = document.createElement("div");
      gutter.className = "highlight-line-numbers";
      gutter.setAttribute("aria-hidden", "true");
      editor.insertBefore(gutter, editor.firstChild);
    }

    const sync = () => {
      const code = backdrop.querySelector("code");
      const diagnosticLine = Number.parseInt(textarea.dataset.aeonDiagnosticLine ?? "", 10);
      const diagnosticColumn = Number.parseInt(textarea.dataset.aeonDiagnosticColumn ?? "", 10);
      code.innerHTML = highlightAeon(
        textarea.value,
        Number.isInteger(diagnosticLine) && diagnosticLine > 0 ? diagnosticLine : null,
        Number.isInteger(diagnosticColumn) && diagnosticColumn > 0 ? diagnosticColumn : 1
      ) + "\n";
      if (gutter) {
        const lineCount = Math.max(1, textarea.value.split("\n").length);
        gutter.innerHTML = Array.from({ length: lineCount }, (_, index) => {
          const line = index + 1;
          const className = line === diagnosticLine ? ' class="has-diagnostic"' : "";
          return `<span${className}>${line}</span>`;
        }).join("");
      }
    };

    textarea.addEventListener("input", sync);
    textarea.addEventListener("aeon:diagnostic-change", sync);
    textarea.addEventListener("scroll", () => {
      backdrop.scrollTop = textarea.scrollTop;
      backdrop.scrollLeft = textarea.scrollLeft;
      if (gutter) {
        gutter.scrollTop = textarea.scrollTop;
      }
    });

    sync();
  }

  function setEditorDiagnosticLine(textarea, line, column = null) {
    if (Number.isInteger(line) && line > 0) {
      textarea.dataset.aeonDiagnosticLine = String(line);
      if (Number.isInteger(column) && column > 0) {
        textarea.dataset.aeonDiagnosticColumn = String(column);
      } else {
        delete textarea.dataset.aeonDiagnosticColumn;
      }
    } else {
      delete textarea.dataset.aeonDiagnosticLine;
      delete textarea.dataset.aeonDiagnosticColumn;
    }
    textarea.dispatchEvent(new Event("aeon:diagnostic-change"));
  }

  function renderStaticBlocks() {
    document.querySelectorAll("[data-aeon-static]").forEach((block) => {
      block.innerHTML = highlightAeon(block.textContent || "") + "\n";
    });
  }

  window.AeonWebHighlight = {
    highlightAeon,
    highlightJson,
    attachHighlightEditor,
    setEditorDiagnosticLine,
    renderStaticBlocks
  };
})();
