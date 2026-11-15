document.addEventListener("DOMContentLoaded", () => {
  const shell = document.querySelector("[data-playground-shell]");
  if (!shell) {
    return;
  }

  const source = shell.querySelector("[data-playground-source]");
  const output = shell.querySelector("[data-playground-output]");
  const errors = shell.querySelector("[data-playground-errors]");
  const outputTitle = shell.querySelector("[data-playground-output-title]");
  const loading = shell.querySelector("[data-playground-loading]");
  const modeButtons = shell.querySelectorAll("[data-mode]");
  const viewButtons = shell.querySelectorAll("[data-output-view]");
  const examplesOpen = shell.querySelector("[data-examples-open]");
  const examplesModal = shell.querySelector("[data-examples-modal]");
  const exampleTabs = shell.querySelectorAll("[data-example-key]");
  const exampleCode = shell.querySelector("[data-example-code]");
  const exampleLoad = shell.querySelector("[data-example-load]");
  const examplesClose = shell.querySelectorAll("[data-examples-close]");
  const sourceBuilderOpen = shell.querySelector("[data-source-builder-open]");

  if (!source || !output || !errors || !outputTitle || !loading) {
    return;
  }

  const examples = window.AeonPlaygroundExamples || {
    transport: {
      mode: "transport",
      source: [
        "//# Transport example",
        "name = \"Alice\"",
        "count = 3",
        "tags = [\"draft\", \"public\"]",
        "",
        "note = >`",
        "  Transport mode can carry broad AEON-shaped data.",
        "`"
      ].join("\n")
    },
    custom: {
      mode: "custom",
      source: [
        "aeon:mode = \"custom\"",
        "",
        "location:geoPoint = {",
        "  lat:number = -37.8136",
        "  lon:number = 144.9631",
        "}",
        "",
        "status:trafficLight = \"green\""
      ].join("\n")
    },
    strict: {
      mode: "strict",
      source: [
        "aeon:mode = \"strict\"",
        "",
        "contact:object = {",
        "  name:string = \"Bob\"",
        "  active:boolean = true",
        "}",
        "",
        "measurements:list<number> = [3, 4, 5]"
      ].join("\n")
    },
    full: {
      mode: "strict",
      source: [
        "aeon:mode = \"strict\"",
        "aeon:profile = \"example.daily.v1\"",
        "",
        "entry:object = {",
        "  title:string = \"Daily check\"",
        "  published:boolean = false",
        "  state:toggle = on",
        "  count:number = 3",
        "  tags:list<string> = [\"field\", \"review\"]",
        "  point:tuple<number, number> = (12, 42)",
        "  note:prose = >`",
        "    AEON keeps the readable source, the typed value,",
        "    and later interpretation visibly separate.",
        "  `",
        "}",
        "",
        "copy:string = ~entry.title"
      ].join("\n")
    }
  };

  const state = {
    mode: "transport",
    view: "finalized",
    example: "transport",
    requestId: 0
  };
  const runtimeProfile = "aeon.gp.profile.v1";
  try {
    const transferredSource = window.sessionStorage.getItem("aeon:playground-source");
    if (transferredSource) {
      source.value = transferredSource;
      window.sessionStorage.removeItem("aeon:playground-source");
    }
  } catch {
  }
  const runtimeReady = import("@aeon/runtime");
  const canonicalReady = import("@aeon/canonical");
  function visibleDiagnosticLine(diagnostic, lineOffset = 0) {
    const line = diagnostic?.span?.start?.line;
    if (!Number.isInteger(line)) return null;
    const visibleLine = line - lineOffset;
    return visibleLine > 0 ? visibleLine : null;
  }

  function diagnosticContext(diagnostic, lineOffset = 0) {
    const parts = [];
    const line = visibleDiagnosticLine(diagnostic, lineOffset);
    const column = diagnostic?.span?.start?.column;
    if (line !== null) {
      parts.push(Number.isInteger(column) ? `line ${line}, column ${column}` : `line ${line}`);
    }
    if (diagnostic?.phase !== undefined && diagnostic?.phase !== null) {
      parts.push(`phase ${diagnostic.phase}`);
    }
    return parts.length > 0 ? ` [${parts.join("; ")}]` : "";
  }

  function formatDiagnostic(diag, level, lineOffset = 0) {
    return `${level}${diagnosticContext(diag, lineOffset)} ${diag.code ? `${diag.code}: ` : ""}${diag.message}`;
  }

  function appendDiagnosticGroup(lines, title, groupErrors, groupWarnings, lineOffset, emptyMessage) {
    if (groupErrors.length === 0 && groupWarnings.length === 0) {
      lines.push(`${title}: ${emptyMessage}`);
      return;
    }

    lines.push(`${title}:`);
    for (const diag of groupErrors) {
      lines.push(`  ${formatDiagnostic(diag, "error", lineOffset)}`);
    }
    for (const diag of groupWarnings) {
      lines.push(`  ${formatDiagnostic(diag, "warning", lineOffset)}`);
    }
  }

  function formatDiagnostics(meta, lineOffset = 0, view = "finalized", canonicalErrors = []) {
    const errors = meta?.errors ?? [];
    const warnings = meta?.warnings ?? [];
    const sourceErrors = errors.filter((diag) => diag.phase !== 8);
    const sourceWarnings = warnings.filter((diag) => diag.phase !== 8);
    const finalizationErrors = errors.filter((diag) => diag.phase === 8);
    const finalizationWarnings = warnings.filter((diag) => diag.phase === 8);
    const lines = [];

    appendDiagnosticGroup(lines, "Source validation", sourceErrors, sourceWarnings, lineOffset, "valid.");

    if (view === "finalized") {
      lines.push("");
      if (sourceErrors.length > 0) {
        lines.push("JSON projection: not attempted.");
      } else {
        appendDiagnosticGroup(
          lines,
          "JSON projection",
          finalizationErrors,
          finalizationWarnings,
          lineOffset,
          "compatible."
        );
      }
    } else if (view === "canonical") {
      lines.push("");
      appendDiagnosticGroup(lines, "Canonical output", canonicalErrors, [], lineOffset, "valid.");
    }

    return lines;
  }

  function mapMode(mode) {
    if (mode === "transport") {
      return {
        runtimeMode: "loose",
        datatypePolicy: "reserved_only"
      };
    }

    if (mode === "custom") {
      return {
        runtimeMode: "strict",
        datatypePolicy: "allow_custom"
      };
    }

    return {
      runtimeMode: "strict",
      datatypePolicy: "reserved_only"
    };
  }

  function sourceForMode(text, mode) {
    const sourceText = String(text ?? "");
    if (mode === "transport" || /^\s*aeon\s*:\s*header\s*=/im.test(sourceText)) {
      return sourceText;
    }

    const headerMode = mode === "custom" ? "custom" : "strict";
    const withoutModeHeader = sourceText.replace(/^\s*aeon:mode\s*=\s*["'](?:transport|custom|strict)["']\s*(?:\r?\n)?/i, "");
    return `aeon:mode = "${headerMode}"\n${withoutModeHeader}`;
  }

  function sourceDiagnosticLineOffset(text, mode) {
    const sourceText = String(text ?? "");
    if (mode === "transport"
      || /^\s*aeon\s*:\s*header\s*=/im.test(sourceText)
      || /^\s*aeon:mode\s*=\s*["'](?:transport|custom|strict)["']/i.test(sourceText)) {
      return 0;
    }
    return 1;
  }

  function showFirstSourceError(meta, lineOffset = 0) {
    const first = meta?.errors?.find((diagnostic) => visibleDiagnosticLine(diagnostic, lineOffset) !== null);
    window.AeonWebHighlight?.setEditorDiagnosticLine?.(
      source,
      first ? visibleDiagnosticLine(first, lineOffset) : null,
      first?.span?.start?.column
    );
  }

  function sourceForBuilderSeed(text) {
    return String(text ?? "").replace(/^\s*aeon:mode\s*=\s*["'](?:transport|custom|strict)["']\s*(?:\r?\n)?/i, "");
  }

  const sharedSourceComposer = window.AeonSourceComposer?.mount({
    shell,
    source,
    runtimeReady,
    validateSource: async (text) => {
      const [{ tokenize }, { composerUnsupportedReason }] = await Promise.all([
        import('@aeon/lexer'), import('./composer-policy.mjs')
      ]);
      const reason = composerUnsupportedReason(text, tokenize);
      if (reason) throw new Error(reason);
    },
    getMode: () => state.mode,
    runtimeConfig: (text, mode, relaxed = false) => {
      if (relaxed) {
        return {
          text: sourceForBuilderSeed(text),
          options: { profile: runtimeProfile, mode: "loose", datatypePolicy: "reserved_only", includeAnnotations: true, output: "map" }
        };
      }
      const mapping = mapMode(mode);
      return {
        text: sourceForMode(text, mode),
        options: { profile: runtimeProfile, mode: mapping.runtimeMode, datatypePolicy: mapping.datatypePolicy, includeAnnotations: true, output: "map" }
      };
    },
    onApply: () => render(),
    onError: (error) => {
      errors.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  function formatRuntimeResult(result, view) {
    return {
      sourceOk: (result.meta?.errors ?? []).every((diag) => diag.phase === 8),
      finalized: view === "finalized" && result.document !== undefined ? JSON.stringify(result.document, null, 2) : "",
      aes: view === "aes" ? renderAesTable(result.aes ?? [], result.document) : "",
      annotations: view === "annotations" ? JSON.stringify(annotationsForDisplay(result.annotations ?? []), null, 2) : "",
      errors: []
    };
  }

  function annotationsForDisplay(annotations) {
    return annotations.map(({ kind, subtype, form, ...rest }) => subtype == null
      ? { kind, form, ...rest }
      : { kind, subtype, form, ...rest });
  }

  function formatAesCell(value) {
    if (value === null || value === undefined || value === "") {
      return "·";
    }
    if (typeof value === "string") {
      return value.replace(/\s+/g, " ");
    }
    return JSON.stringify(value);
  }

  function formatEventPath(path) {
    if (typeof path === "string") {
      return path;
    }
    if (path && typeof path === "object" && typeof window.AeonFormatPath === "function") {
      return window.AeonFormatPath(path);
    }
    if (path?.segments) {
      let result = "";
      for (const segment of path.segments) {
        if (segment.type === "root") {
          result = "$";
        } else if (segment.type === "member") {
          result += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.key)
            ? `.${segment.key}`
            : `.[${JSON.stringify(segment.key)}]`;
        } else if (segment.type === "index") {
          result += `[${segment.index}]`;
        } else if (segment.type === "attribute") {
          result += formatSourceAttributePath(segment.key);
        }
      }
      return result || "$";
    }
    return formatAesCell(path);
  }

  function readNestedValue(root, segments) {
    let value = root;
    for (const segment of segments) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[segment];
    }
    return value;
  }

  function valueFromFinalizedPath(path, document) {
    // The runtime already supplies typed event paths. Never reparse display text.
    if (!document || !path?.segments) return undefined;
    const segments = [];
    for (const segment of path.segments) {
      if (segment.type === "member") segments.push(segment.key);
      else if (segment.type === "index") segments.push(segment.index);
      else if (segment.type !== "root") return undefined;
    }
    if (segments.length === 0) {
      return document;
    }
    const bodyRoot = document && typeof document === "object" && "payload" in document
      ? document.payload
      : document;
    return readNestedValue(bodyRoot, segments);
  }

  function aesValueType(event) {
    return event.valueType ?? event.type ?? event.value?.type ?? "·";
  }

  function aesRawValue(event) {
    const value = event.value;
    if (event.raw !== null && event.raw !== undefined) {
      return event.raw;
    }
    if (value && typeof value === "object") {
      return value.raw ?? value.value ?? undefined;
    }
    return event.value;
  }

  function formatAesValue(event, document) {
    const raw = aesRawValue(event);
    if (raw !== null && raw !== undefined) {
      return formatAesCell(raw);
    }
    const finalizedValue = valueFromFinalizedPath(event.path, document);
    if (finalizedValue !== undefined && (finalizedValue === null || typeof finalizedValue !== "object")) {
      return formatAesCell(finalizedValue);
    }
    return "·";
  }

  function aesAttributeEntries(attributes) {
    if (attributes instanceof Map) {
      return Array.from(attributes.entries());
    }
    if (attributes && !Array.isArray(attributes) && typeof attributes === "object") {
      return Object.entries(attributes);
    }
    return [];
  }

  function formatSourceAttributePath(key) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.@.${key}` : `.@.[${JSON.stringify(key)}]`;
  }

  function aesAttributePath(basePath, key) {
    return `${basePath}${formatSourceAttributePath(key)}`;
  }

  function pushAesRows(rows, event, rowNumber, path, document) {
    rows.push([
      rowNumber,
      formatAesCell(path),
      formatAesCell(aesValueType(event)),
      formatAesCell(event.datatype),
      formatAesValue(event, document)
    ]);

    let attributeIndex = 1;
    for (const [key, entry] of aesAttributeEntries(event?.annotations ?? event?.attributes)) {
      const attributePath = aesAttributePath(path, key);
      pushAesRows(rows, entry, `${rowNumber}.${attributeIndex}`, attributePath, document);
      attributeIndex += 1;
    }
  }

  function padCell(value, width) {
    const text = String(value);
    return `${text}${" ".repeat(Math.max(0, width - text.length))}`;
  }

  function renderAesTable(events, document) {
    if (!events || events.length === 0) {
      return "No AES events available.";
    }
    const rows = [];
    events.forEach((event, index) => pushAesRows(rows, event, String(index + 1), formatEventPath(event.path), document));
    const headers = ["#", "Path", "Value Type", "Datatype", "Value"];
    const widths = headers.map(header => header.length);
    for (const row of rows) {
      for (let column = 0; column < widths.length; column += 1) {
        widths[column] = Math.max(widths[column], row[column].length);
      }
    }
    const formatRow = (row) => row.map((cell, column) => padCell(cell, widths[column])).join("  ");
    const divider = widths.map((width) => "-".repeat(width)).join("  ");
    return [
      formatRow(headers),
      divider,
      ...rows.map(formatRow)
    ].join("\n");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  const applyViewState = () => {
    const titles = {
      finalized: "Data",
      aes: "AES",
      annotations: "Annotation Stream",
      canonical: "Canonical"
    };
    outputTitle.textContent = titles[state.view] || "Data";

    modeButtons.forEach((button) => {
      const isActive = button.dataset.mode === state.mode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    viewButtons.forEach((button) => {
      const isActive = button.dataset.outputView === state.view;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  };

  const highlightExample = (text) => {
    if (!exampleCode) {
      return;
    }

    if (window.AeonWebHighlight && typeof window.AeonWebHighlight.highlightAeon === "function") {
      exampleCode.innerHTML = window.AeonWebHighlight.highlightAeon(text) + "\n";
    } else {
      exampleCode.textContent = text;
    }
  };

  const applyExampleState = () => {
    const current = examples[state.example] || examples.transport;
    exampleTabs.forEach((button) => {
      const isActive = button.dataset.exampleKey === state.example;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    highlightExample(current.source);
  };

  const openExamples = () => {
    if (!examplesModal) {
      return;
    }

    applyExampleState();
    window.AeonAccessibility?.openModal(examplesModal, examplesOpen);
  };

  const closeExamples = () => {
    if (examplesModal) {
      window.AeonAccessibility?.closeModal(examplesModal);
    }
  };

  const loadExample = () => {
    const current = examples[state.example] || examples.transport;
    source.value = current.source;
    state.mode = current.mode;
    source.dispatchEvent(new Event("input", { bubbles: true }));
    closeExamples();
  };

  const render = async () => {
    const text = source.value;
    const requestId = ++state.requestId;
    applyViewState();

    loading.hidden = false;
    errors.textContent = "Checking...";

    try {
      const { runRuntime } = await runtimeReady;
      const mapping = mapMode(state.mode);
      const runtimeSource = sourceForMode(text, state.mode);
      const lineOffset = sourceDiagnosticLineOffset(text, state.mode);
      const runtimeResult = runRuntime(runtimeSource, {
        profile: runtimeProfile,
        mode: mapping.runtimeMode,
        datatypePolicy: mapping.datatypePolicy,
        includeAnnotations: true,
        output: "json"
      });
      const payload = formatRuntimeResult(runtimeResult, state.view);
      const sourceErrors = (runtimeResult.meta?.errors ?? []).filter((diag) => diag.phase !== 8);
      let relevantErrors = sourceErrors;
      if (state.view === "canonical") {
        const { canonicalize } = await canonicalReady;
        const canonical = canonicalize(runtimeSource);
        payload.canonical = canonical.text;
        payload.errors = formatDiagnostics(runtimeResult.meta, lineOffset, state.view, canonical.errors);
        if (relevantErrors.length === 0) relevantErrors = canonical.errors;
      } else {
        payload.errors = formatDiagnostics(runtimeResult.meta, lineOffset, state.view);
        if (state.view === "finalized" && relevantErrors.length === 0) {
          relevantErrors = (runtimeResult.meta?.errors ?? []).filter((diag) => diag.phase === 8);
        }
      }
      if (requestId !== state.requestId) {
        return;
      }

      loading.hidden = true;
      showFirstSourceError({ errors: relevantErrors }, lineOffset);
      output.classList.toggle("is-aes-table", state.view === "aes");
      const jsonSource = state.view === "aes"
        ? payload.aes || "[]"
        : state.view === "annotations"
          ? payload.annotations || "[]"
          : state.view === "canonical"
            ? payload.canonical || ""
            : payload.sourceOk ? (payload.finalized || "") : "";
      if (state.view === "aes") {
        output.textContent = jsonSource;
      } else if (state.view === "canonical" && window.AeonWebHighlight && typeof window.AeonWebHighlight.highlightAeon === "function") {
        output.innerHTML = window.AeonWebHighlight.highlightAeon(jsonSource);
      } else if (window.AeonWebHighlight && typeof window.AeonWebHighlight.highlightJson === "function") {
        output.innerHTML = window.AeonWebHighlight.highlightJson(jsonSource);
      } else {
        output.textContent = jsonSource;
      }
      errors.textContent = Array.isArray(payload.errors) && payload.errors.length > 0
        ? payload.errors.join("\n")
        : "No errors detected.";
    } catch (error) {
      if (requestId !== state.requestId) {
        return;
      }

      loading.hidden = true;
      showFirstSourceError(null);
      output.textContent = "";
      errors.textContent = error instanceof Error ? error.message : String(error);
    }
  };

  source.addEventListener("input", () => {
    render();
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode || "transport";
      render();
    });
  });

  viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.outputView || "finalized";
      render();
    });
  });

  if (examplesOpen) {
    examplesOpen.addEventListener("click", openExamples);
  }

  // The shared Composer is the only editing implementation. If its module fails
  // to load, do not silently fall back to the old lossy source rewriter.
  if (!sharedSourceComposer && sourceBuilderOpen) {
    sourceBuilderOpen.disabled = true;
    sourceBuilderOpen.title = "Composer unavailable; reload after checking the local build.";
  }

  exampleTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.example = button.dataset.exampleKey || "transport";
      applyExampleState();
    });
  });

  if (exampleLoad) {
    exampleLoad.addEventListener("click", loadExample);
  }

  examplesClose.forEach((button) => {
    button.addEventListener("click", closeExamples);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && examplesModal && !examplesModal.hidden) {
      closeExamples();
    }
  });

  render();
  window.dispatchEvent(new Event('aeon-playground-ready'));
});
