const GP_PROFILE = "aeon.gp.profile.v1";
const PROFILE_STORAGE_KEY = "aeon:playground-profile";
const MAX_PROFILE_BYTES = 256 * 1024;

export function mountProfileControls(shell, { loadContract, onChange }) {
  const select = shell.querySelector("[data-playground-profile]");
  const loadedOption = shell.querySelector("[data-loaded-profile-option]");
  const choose = shell.querySelector("[data-load-profile]");
  const input = shell.querySelector("[data-profile-file]");
  const clear = shell.querySelector("[data-remove-profile]");
  const status = shell.querySelector("[data-profile-status]");
  let loadedProfile;
  let requestId = 0;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("is-error", isError);
  }

  function store(profileFile) {
    try {
      if (profileFile) sessionStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileFile));
      else sessionStorage.removeItem(PROFILE_STORAGE_KEY);
    } catch { /* The loaded profile still works without session storage. */ }
  }

  async function load(readFile, selectOnLoad) {
    const id = ++requestId;
    setStatus("Loading profile…");
    try {
      const file = await readFile();
      if (id !== requestId) return;
      if (file.source.length > MAX_PROFILE_BYTES) throw new Error("Profile exceeds 256 KiB.");
      const profile = await loadContract(file.source);
      if (id !== requestId) return;

      loadedProfile = profile;
      loadedOption.textContent = `${profile.id} · v${profile.version} (loaded)`;
      loadedOption.hidden = false;
      loadedOption.disabled = false;
      clear.hidden = false;
      if (selectOnLoad) {
        select.value = loadedOption.value;
        store(file);
        onChange();
      }
      setStatus(`Loaded ${file.name}.`);
    } catch (error) {
      if (id !== requestId) return;
      setStatus(`Could not load profile. ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  choose.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void load(async () => {
      if (file.size > MAX_PROFILE_BYTES) throw new Error("Profile exceeds 256 KiB.");
      return { name: file.name, source: await file.text() };
    }, true);
  });
  clear.addEventListener("click", () => {
    requestId++;
    if (select.value === loadedOption.value) select.value = GP_PROFILE;
    loadedProfile = undefined;
    loadedOption.hidden = true;
    loadedOption.disabled = true;
    clear.hidden = true;
    store(null);
    setStatus("Loaded profile removed.");
    onChange();
  });
  select.addEventListener("change", onChange);

  return {
    selectedProfile: () => select.value === loadedOption.value ? loadedProfile ?? GP_PROFILE : select.value,
    async restore() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(PROFILE_STORAGE_KEY) ?? "null");
        if (typeof saved?.name === "string" && typeof saved.source === "string") {
          await load(() => saved, false);
        }
      } catch { /* Storage can be disabled or contain stale data. */ }
    }
  };
}
