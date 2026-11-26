const STORAGE_KEY = "aeon:playground-parser-limits";

function storedLimit(input, value) {
  return Number.isSafeInteger(value) && value >= Number(input.min) && value <= Number(input.max)
    ? value : Number(input.defaultValue);
}

export function mountParserLimits(form, onChange) {
  const inputs = Array.from(form.querySelectorAll("input[name]"));
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch { /* Use the parser defaults when session storage is unavailable. */ }

  for (const input of inputs) {
    input.value = String(storedLimit(input, saved?.[input.name]));
  }
  // Leave defaults implicit so Core can distinguish them from explicit overrides.
  const readLimits = () => Object.fromEntries(inputs
    .filter(input => input.valueAsNumber !== Number(input.defaultValue))
    .map(input => [input.name, input.valueAsNumber]));
  let options = readLimits();

  function applyLimits() {
    if (!form.checkValidity()) return;
    options = readLimits();
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch { /* The limits still apply for the current page. */ }
    onChange();
  }

  form.addEventListener("input", applyLimits);
  form.addEventListener("change", () => form.reportValidity());
  form.addEventListener("submit", event => {
    event.preventDefault();
    applyLimits();
  });
  form.addEventListener("reset", event => {
    event.preventDefault();
    for (const input of inputs) input.value = input.defaultValue;
    applyLimits();
  });

  return { get options() { return options; } };
}
