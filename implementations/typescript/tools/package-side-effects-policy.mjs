// Existing libraries remain side-effect free. The highlighting package exports
// two opt-in CSS assets; no JavaScript module may register as a side effect.
export function packageSideEffectsAllowed(manifest) {
  if (manifest.name !== '@altopelago/aeon-highlight') return manifest.sideEffects === false;
  const assets = ['./dist/theme.css', './dist/theme-light.css'];
  return JSON.stringify(manifest.sideEffects) === JSON.stringify(assets) &&
    manifest.exports?.['./theme.css'] === assets[0] &&
    manifest.exports?.['./theme-light.css'] === assets[1];
}
