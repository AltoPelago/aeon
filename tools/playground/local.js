// Preserve the in-progress editor when a successful workspace rebuild reloads modules.
document.addEventListener('DOMContentLoaded', () => {
  const source = document.querySelector('[data-playground-source]');
  const profile = document.querySelector('[data-playground-profile]');
  const badge = document.querySelector('[data-local-build]');
  let restored;
  try {
    restored = JSON.parse(sessionStorage.getItem('aeon:local-reload') ?? 'null');
    sessionStorage.removeItem('aeon:local-reload');
    if (typeof restored?.source === 'string') source.value = restored.source;
    if (profile && Array.from(profile.options).some(option => option.value === restored?.profile)) {
      profile.value = restored.profile;
    }
  } catch { /* Storage can be unavailable; the editor remains usable. */ }
  window.addEventListener('aeon-playground-ready', () => {
    if (['transport', 'custom', 'strict'].includes(restored?.mode)) document.querySelector(`[data-mode="${restored.mode}"]`)?.click();
    if (['aes', 'finalized', 'annotations', 'canonical'].includes(restored?.view)) document.querySelector(`[data-output-view="${restored.view}"]`)?.click();
  }, {once:true});
  let revision, busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch('/__playground/status', {cache:'no-store', signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error('status unavailable');
      const state = await response.json();
      badge.textContent = state.error ?? (state.building ? 'Building local source…' : state.watching ? 'Local TypeScript · source watch' : 'Local TypeScript · manual rebuild');
      badge.classList.toggle('is-error', Boolean(state.error));
      if (revision !== undefined && state.revision !== revision && !state.building && !state.error) {
        try {
          sessionStorage.setItem('aeon:local-reload', JSON.stringify({source:source.value,
            profile:profile?.value,
            mode:document.querySelector('[data-mode].is-active')?.dataset.mode,
            view:document.querySelector('[data-output-view].is-active')?.dataset.outputView}));
          location.reload();
        } catch {
          badge.textContent = 'Source rebuilt · refresh to load it (copy your input first)';
        }
      }
      revision = state.revision;
    } catch { badge.textContent = 'Local server unavailable · displayed runtime may be stale'; }
    finally { busy = false; }
  };
  poll();
  setInterval(poll, 1000);
});
