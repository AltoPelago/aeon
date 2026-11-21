// Datatype formatting can vary between SUTs. Quoted clarifiers are values.
export function normalizeDatatype(value) {
  const text = String(value);
  let normalized = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      normalized += char;
      if (char === '\\' && index + 1 < text.length) {
        index += 1;
        normalized += text[index];
      } else if (char === quote) {
        quote = null;
      }
    } else if (!/\s/u.test(char)) {
      normalized += char;
      if (char === '"' || char === "'" || char === '`') quote = char;
    }
  }
  return normalized;
}
