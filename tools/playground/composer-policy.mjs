// The inherited composer edits materialized values; these forms need source edits.
// Tokenize rather than looking for punctuation inside strings, comments or keys.
export const COMPOSER_MAX_SOURCE_CODE_UNITS = 1_048_576;
export function composerUnsupportedReason(source, tokenize) {
  if (source.length > COMPOSER_MAX_SOURCE_CODE_UNITS) return 'Source is too large for AEON Composer. Edit this source directly.';
  const result = tokenize(source);
  if (result.errors.length) return 'Fix the source syntax before opening AEON Composer.';
  if (result.tokens.some(token => ['Tilde', 'TildeArrow', 'SansaAddressLiteral'].includes(token.type))) {
    return 'AEON Composer cannot yet preserve references or SANSA address literals. Edit this source directly; its text has been kept unchanged.';
  }
  return undefined;
}
