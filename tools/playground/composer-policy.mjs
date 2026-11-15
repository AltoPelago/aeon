// The inherited composer edits materialized values; these forms need source edits.
// Tokenize rather than looking for punctuation inside strings, comments or keys.
export function composerUnsupportedReason(source, tokenize) {
  const result = tokenize(source);
  if (result.errors.length) return 'Fix the source syntax before opening AEON Composer.';
  if (result.tokens.some(token => ['Tilde', 'TildeArrow', 'SansaAddressLiteral'].includes(token.type))) {
    return 'AEON Composer cannot yet preserve references or SANSA address literals. Edit this source directly; its text has been kept unchanged.';
  }
  return undefined;
}
