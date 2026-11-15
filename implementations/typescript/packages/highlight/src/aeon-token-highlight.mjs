import {escapeHtml, renderDocComment, highlightFromColumn} from './presentation-highlight.mjs';

// A presentation allowance only: larger inputs remain visible as escaped text.
// It does not change compiler, parser, reference or resolver limits.
export const MAX_HIGHLIGHT_SOURCE_CODE_UNITS = 1_048_576;

export function createAeonHighlighter({tokenize, TokenType}) {
  const styles = new Map([
    [TokenType.String, 'string'],
    [TokenType.StructuralIdentity, 'identity'],
    [TokenType.SansaAddressLiteral, 'sansa'],
    [TokenType.Tilde, 'binding'], [TokenType.TildeArrow, 'binding'],
    [TokenType.Equals, 'operator'],
    [TokenType.SymbolicLiteral, 'symbol'],
    ...['Number', 'HexLiteral', 'RadixLiteral'].map(name => [TokenType[name], 'number']),
    ...['Date', 'DateTime', 'Time'].map(name => [TokenType[name], 'temporal']),
    ...['EncodingLiteral', 'SeparatorLiteral', 'True', 'False', 'Yes', 'No', 'On', 'Off']
      .map(name => [TokenType[name], 'literal']),
    ...['LeftBrace', 'RightBrace', 'LeftBracket', 'RightBracket', 'LeftParen', 'RightParen',
      'LeftAngle', 'RightAngle', 'Colon', 'Comma', 'Dot', 'At', 'Caret', 'Hash', 'Dollar',
      'Question', 'Percent', 'Ampersand', 'Semicolon', 'Symbol'].map(name => [TokenType[name], 'punct']),
  ].filter(([type]) => type !== undefined));
  const comments = new Map([
    ['plain', 'comment'], ['doc', 'comment-doc'], ['annotation', 'comment-annotation'],
    ['hint', 'comment-hint'], ['host', 'comment-host'],
  ]);
  const reservedComments = new Map([
    ['structure', 'comment-structure'], ['profile', 'comment-profile'], ['instructions', 'comment-future'],
  ]);

  // Presentation roles over implementation tokens only. These do not validate,
  // split, consume or reinterpret AEON source, and are never used by execution.
  function presentationRoles(tokens) {
    const roles = new Map();
    const significant = tokens.filter(t => t.type !== TokenType.LineComment &&
      t.type !== TokenType.BlockComment && t.type !== TokenType.Newline && t.type !== TokenType.EOF);
    let datatype = false, typeDepth = 0, reference = false, referenceDepth = 0;
    let previous;
    const braces = [];
    for (let i = 0; i < significant.length; i++) {
      const token = significant[i], next = significant[i + 1];
      const type = token.type;
      const adjacent = previous && previous.span.end.offset === token.span.start.offset;
      if (reference && ((!adjacent && previous?.type !== TokenType.TildeArrow) || (referenceDepth === 0 &&
        [TokenType.Comma, TokenType.RightBrace, TokenType.RightAngle, TokenType.RightBracket, TokenType.Equals].includes(type)))) reference = false;
      if (type === TokenType.Tilde || type === TokenType.TildeArrow) {
        reference = true; referenceDepth = 0;
      }
      if (reference) {
        roles.set(token, 'binding');
        if (type === TokenType.LeftBracket) referenceDepth++;
        if (type === TokenType.RightBracket) referenceDepth--;
      } else {
        if (type === TokenType.Equals || type === TokenType.At ||
          (typeDepth === 0 && [TokenType.LeftBrace, TokenType.RightBrace, TokenType.Comma].includes(type))) datatype = false;
        if (type === TokenType.Colon) { datatype = true; typeDepth = 0; }
        else if (datatype) {
          roles.set(token, 'type');
          if (type === TokenType.LeftAngle || type === TokenType.LeftBracket) typeDepth++;
          if (type === TokenType.RightAngle || type === TokenType.RightBracket) typeDepth--;
        } else if (type === TokenType.Identifier || type === TokenType.String) {
          if (previous?.type === TokenType.LeftAngle) roles.set(token, 'tag');
          else if ([TokenType.Colon, TokenType.StructuralIdentity, TokenType.Equals, TokenType.At].includes(next?.type)) roles.set(token, 'key');
          else if (type === TokenType.Identifier && ['NaN', 'Infinity'].includes(token.value)) roles.set(token, 'number');
          else if (previous?.type === TokenType.Symbol && previous.value === '!') roles.set(token, 'literal');
        }
        if (type === TokenType.LeftBrace) {
          const attributes = previous?.type === TokenType.At;
          braces.push(attributes);
          if (attributes) { roles.set(previous, 'attribute-punct'); roles.set(token, 'attribute-punct'); }
        }
        if (type === TokenType.RightBrace && braces.pop()) roles.set(token, 'attribute-punct');
        if (type === TokenType.Symbol && token.value === '!') roles.set(token, 'literal');
      }
      previous = token;
    }
    for (let i = 0; i + 2 < significant.length; i++) {
      if (significant[i].type === TokenType.Identifier && significant[i].value === 'aeon' &&
        significant[i + 1].type === TokenType.Colon && significant[i + 2].type === TokenType.Identifier) {
        for (const t of significant.slice(i, i + 3)) roles.set(t, 'directive');
      }
    }
    return roles;
  }

  function renderToken(text, token, role) {
    let style = role ?? styles.get(token.type);
    if (token.type === TokenType.LineComment || token.type === TokenType.BlockComment) {
      style = token.comment?.channel === 'reserved'
        ? reservedComments.get(token.comment.subtype) ?? 'comment'
        : comments.get(token.comment?.channel) ?? 'comment';
      // Optional &ND decoration operates only inside lexer-classified doc comments.
      if (style === 'comment-doc') return renderDocComment(text);
    }
    if (!style) return escapeHtml(text);
    // Keep spans balanced on every line for diagnostics and editor scrolling.
    return text.split('\n').map(line => `<span class="tok-${style}">${escapeHtml(line)}</span>`).join('\n');
  }

  function renderSource(source) {
    if (source.length > MAX_HIGHLIGHT_SOURCE_CODE_UNITS) return escapeHtml(source);
    let tokens;
    try {
      tokens = tokenize(source, {includeComments:true, includeNewlines:true}).tokens;
    } catch {
      return escapeHtml(source);
    }
    if (!Array.isArray(tokens)) return escapeHtml(source);
    let cursor = 0;
    const output = [];
    for (const token of tokens) {
      const start = token.span?.start?.offset, end = token.span?.end?.offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end < start || end > source.length) {
        return escapeHtml(source);
      }
      cursor = end;
    }
    cursor = 0;
    const roles = presentationRoles(tokens);
    for (const token of tokens) {
      const start = token.span.start.offset, end = token.span.end.offset;
      if (end === start) continue;
      output.push(escapeHtml(source.slice(cursor, start)));
      // Token values may be decoded. Only the original source slice is displayed.
      output.push(renderToken(source.slice(start, end), token, roles.get(token)));
      cursor = end;
    }
    output.push(escapeHtml(source.slice(cursor)));
    return output.join('');
  }

  /** @param {string} source @param {number|null} diagnosticLine @param {number} diagnosticColumn */
  function highlightAeon(source, diagnosticLine = null, diagnosticColumn = 1) {
    const html = renderSource(source);
    if (!Number.isInteger(diagnosticLine) || diagnosticLine < 1) return html;
    return html.split('\n').map((line, index) => index + 1 === diagnosticLine
      ? highlightFromColumn(line, diagnosticColumn) : line).join('\n');
  }
  return {highlightAeon};
}
