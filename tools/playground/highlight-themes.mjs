// Local presentation experiment. Does not read, parse or replace AEON source.
export const HIGHLIGHT_THEMES = Object.freeze({
  current: Object.freeze({theme:'current', lightness:78, chroma:0.10, valueChroma:0.10}),
  equal: Object.freeze({theme:'equal', lightness:78, chroma:0.10, valueChroma:0.10}),
  values: Object.freeze({theme:'values', lightness:78, chroma:0.07, valueChroma:0.14}),
});
export const HIGHLIGHT_THEME_STORAGE_KEY = 'aeon:highlight-theme:v1';

function bounded(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)) * 100) / 100 : fallback;
}
export function normalizeHighlightTheme(raw) {
  const theme = typeof raw?.theme === 'string' && Object.hasOwn(HIGHLIGHT_THEMES, raw.theme) ? raw.theme : 'current';
  const preset = HIGHLIGHT_THEMES[theme];
  const lightness = bounded(raw?.lightness, preset.lightness, 50, 95);
  const chroma = bounded(raw?.chroma, preset.chroma, 0, 0.20);
  // Equal means equal. The values preset always gives values more chroma.
  const valueChroma = theme === 'values'
    ? Math.max(Math.round((chroma + 0.01) * 100) / 100, bounded(raw?.valueChroma, preset.valueChroma, 0.01, 0.25))
    : chroma;
  return {theme, lightness, chroma, valueChroma};
}

export function mountHighlightThemes(doc) {
  const select = doc.querySelector('[data-highlight-theme-select]');
  const settings = doc.querySelector('[data-highlight-settings]');
  const lightness = doc.querySelector('[data-highlight-lightness]');
  const chroma = doc.querySelector('[data-highlight-chroma]');
  const valueChroma = doc.querySelector('[data-highlight-value-chroma]');
  if (!select || !settings || !lightness || !chroma || !valueChroma) return;
  let state = HIGHLIGHT_THEMES.current;
  const persist = () => {
    try { doc.defaultView.sessionStorage.setItem(HIGHLIGHT_THEME_STORAGE_KEY, JSON.stringify(state)); }
    catch { /* Storage is optional; the selected theme still works. */ }
  };
  const apply = (raw, save = true) => {
    state = normalizeHighlightTheme(raw);
    doc.documentElement.dataset.highlightTheme = state.theme;
    doc.documentElement.style.setProperty('--highlight-lightness', String(state.lightness / 100));
    doc.documentElement.style.setProperty('--highlight-chroma', String(state.chroma));
    doc.documentElement.style.setProperty('--highlight-value-chroma', String(state.valueChroma));
    select.value = state.theme;
    settings.hidden = state.theme === 'current';
    if (settings.hidden) settings.open = false;
    lightness.value = String(state.lightness);
    chroma.value = String(state.chroma);
    valueChroma.value = String(state.valueChroma);
    valueChroma.min = String(Math.round((state.chroma + 0.01) * 100) / 100);
    doc.querySelector('[data-highlight-values-control]').hidden = state.theme !== 'values';
    doc.querySelector('[data-highlight-lightness-output]').textContent = state.lightness + '%';
    doc.querySelector('[data-highlight-chroma-output]').textContent = state.chroma.toFixed(2);
    doc.querySelector('[data-highlight-value-chroma-output]').textContent = state.valueChroma.toFixed(2);
    if (save) persist();
  };
  select.addEventListener('change', () => apply({theme:select.value}));
  for (const input of [lightness, chroma, valueChroma]) input.addEventListener('input', () => apply({
    theme:select.value, lightness:Number(lightness.value), chroma:Number(chroma.value), valueChroma:Number(valueChroma.value),
  }));
  doc.querySelector('[data-highlight-reset]').addEventListener('click', () => apply({theme:select.value}));
  try { apply(JSON.parse(doc.defaultView.sessionStorage.getItem(HIGHLIGHT_THEME_STORAGE_KEY) ?? 'null'), false); }
  catch { apply(HIGHLIGHT_THEMES.current, false); }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountHighlightThemes(document), {once:true});
  else mountHighlightThemes(document);
}
