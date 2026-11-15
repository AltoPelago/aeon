import {escapeHtml, renderDocComment, highlightFromColumn} from './presentation-highlight.mjs';

// A presentation allowance only: larger inputs remain visible as escaped text.
// It does not change compiler, parser, reference or resolver limits.
export const MAX_HIGHLIGHT_SOURCE_CODE_UNITS = 1_048_576;

export function createAeonHighlighter({tokenize, TokenType}) {
  const styles = new Map([
    [TokenType.String, 'string'],
    [TokenType.StructuralIdentity, 'identity'],
    [TokenType.SansaAddressLiteral, 'sansa'],
    [TokenType.Identifier, 'identifier'],
    [TokenType.Tilde, 'binding'], [TokenType.TildeArrow, 'binding'],
    [TokenType.Equals, 'operator'],
    ...['Number', 'HexLiteral', 'RadixLiteral', 'EncodingLiteral', 'SeparatorLiteral',
      'SymbolicLiteral', 'True', 'False', 'Yes', 'No', 'On', 'Off', 'Date', 'DateTime', 'Time']
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

  function renderToken(text, token) {
    let style = styles.get(token.type);
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
      if (end === start) continue;
      output.push(escapeHtml(source.slice(cursor, start)));
      // Token values may be decoded. Only the original source slice is displayed.
      output.push(renderToken(source.slice(start, end), token));
      cursor = end;
    }
    output.push(escapeHtml(source.slice(cursor)));
    return output.join('');
  }

  function highlightAeon(source, diagnosticLine = null, diagnosticColumn = 1) {
    const html = renderSource(source);
    if (!Number.isInteger(diagnosticLine) || diagnosticLine < 1) return html;
    return html.split('\n').map((line, index) => index + 1 === diagnosticLine
      ? highlightFromColumn(line, diagnosticColumn) : line).join('\n');
  }
  return {highlightAeon};
}
