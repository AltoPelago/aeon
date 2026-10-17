// Runs against the real generated binary in both browser execution contexts.
export function checkCanonical(runtime) {
  const check = (condition, message) => {
    if (!condition) throw new Error(`standalone canonicalization: ${message}`);
  };
  const source = 'z=|Sofía 🌊|\na=~z';
  const options = { ordering: 'reference-safe-v1' };
  const historical = runtime.canonicalize(source, { ordering: 'lexical-v1' });
  check(historical.errors.length === 0, 'historical diagnostics');
  check(historical.text.endsWith('a = ~z\nz = |Sofía 🌊|\n'), 'historical bytes');
  const result = runtime.canonicalize(source, options);
  check(runtime.canonicalize(source).text === result.text, 'default bytes');
  check(result.errors.length === 0, 'opt-in diagnostics');
  check(result.text.endsWith('z = |Sofía 🌊|\na = ~z\n'), 'opt-in bytes');
  check(runtime.canonicalize(result.text, options).text === result.text, 'fixed-point bytes');
  const failure = runtime.canonicalize('a=~z\nz=1', options);
  check(failure.text === '' && failure.errors[0]?.code === 'FORWARD_REFERENCE', 'fail closed');
  const exhausted = runtime.canonicalize(source, { ...options, maxOrderingEdges: 0 });
  check(exhausted.text === '' && exhausted.errors[0]?.code === 'CANONICAL_ORDERING_LIMIT_EXCEEDED', 'edge budget');
  return { ordering: options.ordering, fixedPoint: true, failuresClosed: true };
}
