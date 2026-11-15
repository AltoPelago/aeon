// JSON colouring and &ND comment decoration; no AEON tokenization.
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
  let index = 0;
  let start = 0;
  let noClosingBracket = false;

  while (start < value.length) {
    let token;
    const next = value[start + 1];
    if (value[start] === '\\' && next !== undefined && '[]|\\'.includes(next)) {
      token = value.slice(start, start + 2);
    } else if (value[start] === '|') {
      token = '|';
    } else if (value[start] === '[' && next !== undefined
        && '*/$@ x=._<'.includes(next) && !noClosingBracket) {
      const end = value.indexOf(']', start + 2);
      // A failed search proves there is no closer for any later opener.
      // Complete tokens consume their whole searched interval.
      if (end === -1) noClosingBracket = true;
      else token = value.slice(start, end + 1);
    }
    if (token === undefined) { start += 1; continue; }
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
    start = index;
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

function highlightJson(source) {
  // Quoted text is walked once; no quote/escape repetition enters a regex.
  const pattern = /\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/y;
  let html = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"') {
      const start = index;
      let end = index + 1;
      let closed = false;
      while (end < source.length) {
        const ch = source[end];
        if (ch === '\\') end = Math.min(source.length, end + 2);
        else if (ch === '"') { end += 1; closed = true; break; }
        else end += 1;
      }
      if (!closed) { html += escapeHtml(source.slice(start)); break; }
      let colon = end;
      while (colon < source.length && ' \t\r\n'.includes(source[colon])) colon += 1;
      const isKey = source[colon] === ':';
      html += isKey
        ? `<span class="json-key">${escapeHtml(source.slice(start, end))}</span>`
        : `<span class="json-string">${escapeHtml(source.slice(start, end))}</span>`;
      if (isKey) { html += escapeHtml(source.slice(end, colon + 1)); index = colon + 1; }
      else index = end;
      continue;
    }
    pattern.lastIndex = index;
    const token = pattern.exec(source);
    if (!token) { html += escapeHtml(source[index++]); continue; }
    const [match, keyword, num, punct] = token;
    if (keyword) html += `<span class="json-${keyword === 'null' ? 'null' : 'bool'}">${escapeHtml(match)}</span>`;
    else if (num) html += `<span class="json-number">${escapeHtml(match)}</span>`;
    else if (punct) html += `<span class="json-punct">${escapeHtml(match)}</span>`;
    index = pattern.lastIndex;
  }
  return html;
}


export {escapeHtml, renderDocComment, highlightFromColumn, highlightJson};
