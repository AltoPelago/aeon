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
  const sourceBuilderModal = shell.querySelector("[data-source-builder-modal]");
  const sourceBuilderTree = shell.querySelector("[data-source-builder-tree]");
  const sourceBuilderDetail = shell.querySelector("[data-source-builder-detail]");
  const sourceBuilderClose = shell.querySelectorAll("[data-source-builder-close]");
  const sourceBuilderReload = shell.querySelector("[data-source-builder-reload]");
  const sourceBuilderApply = shell.querySelector("[data-source-builder-apply]");
  const sourceBuilderAddPeer = shell.querySelector("[data-source-builder-add-peer]");
  const sourceBuilderAddChild = shell.querySelector("[data-source-builder-add-child]");
  const sourceBuilderAddAttribute = shell.querySelector("[data-source-builder-add-attribute]");
  const sourceBuilderAddComment = shell.querySelector("[data-source-builder-add-comment]");
  const sourceBuilderRemove = shell.querySelector("[data-source-builder-remove]");

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
    requestId: 0,
    lastRuntimeResult: null,
    sourceBuilderRows: [],
    sourceBuilderSelectedPath: null
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
  const sourceTypes = [
    "StringLiteral",
    "TrimtickStringLiteral",
    "SymbolicLiteral",
    "NumberLiteral",
    "IntegerLiteral",
    "FloatLiteral",
    "BooleanLiteral",
    "ToggleLiteral",
    "NullLiteral",
    "NaNLiteral",
    "InfinityLiteral",
    "ObjectNode",
    "ListNode",
    "TupleNode",
    "NodeLiteral",
    "HexLiteral",
    "EncodingLiteral",
    "RadixLiteral",
    "SeparatorLiteral",
    "DateLiteral",
    "TimeLiteral",
    "DateTimeLiteral"
  ];
  const reservedNullValues = ["none", "notSet", "notApplicable", "tombstone"];
  const sourceCommentTypes = [
    ["doc", "Doc"],
    ["annotation", "Annotation"],
    ["hint", "Hint"],
    ["structure", "Structure"],
    ["profile", "Profile"],
    ["instructions", "Instructions"]
  ];
  const sourceCommentMarkers = {
    doc: "#",
    annotation: "@",
    hint: "?",
    structure: "{",
    profile: "[",
    instructions: "("
  };
  const sourceCommentTypeByMarker = Object.fromEntries(
    Object.entries(sourceCommentMarkers).map(([type, marker]) => [marker, type])
  );
  const sourceTypeByValueType = new Map([
    ["StringLiteral", "StringLiteral"],
    ["TrimtickStringLiteral", "TrimtickStringLiteral"],
    ["SymbolicLiteral", "SymbolicLiteral"],
    ["NumberLiteral", "NumberLiteral"],
    ["IntegerLiteral", "IntegerLiteral"],
    ["FloatLiteral", "FloatLiteral"],
    ["BooleanLiteral", "BooleanLiteral"],
    ["ToggleLiteral", "ToggleLiteral"],
    ["NullLiteral", "NullLiteral"],
    ["NaNLiteral", "NaNLiteral"],
    ["InfinityLiteral", "InfinityLiteral"],
    ["ObjectNode", "ObjectNode"],
    ["ListNode", "ListNode"],
    ["TupleLiteral", "TupleNode"],
    ["TupleNode", "TupleNode"],
    ["NodeLiteral", "NodeLiteral"],
    ["HexLiteral", "HexLiteral"],
    ["EncodingLiteral", "EncodingLiteral"],
    ["RadixLiteral", "RadixLiteral"],
    ["SeparatorLiteral", "SeparatorLiteral"],
    ["DateLiteral", "DateLiteral"],
    ["TimeLiteral", "TimeLiteral"],
    ["DateTimeLiteral", "DateTimeLiteral"],
    ["WTCDateTimeLiteral", "DateTimeLiteral"]
  ]);

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

  function formatRuntimeResult(result) {
    return {
      sourceOk: (result.meta?.errors ?? []).every((diag) => diag.phase === 8),
      finalized: result.document !== undefined ? JSON.stringify(result.document, null, 2) : "",
      aes: renderAesTable(result.aes ?? [], result.document),
      annotations: JSON.stringify(annotationsForDisplay(result.annotations ?? []), null, 2),
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

  function pathSegments(path) {
    const segments = [];
    const tokenRe = /\.([A-Za-z_][A-Za-z0-9_]*)|\["((?:\\.|[^"\\])*)"\]|\[(\d+)\]/g;
    for (const match of String(path ?? "").matchAll(tokenRe)) {
      if (match[1] !== undefined) {
        segments.push(match[1]);
      } else if (match[2] !== undefined) {
        try {
          segments.push(JSON.parse(`"${match[2]}"`));
        } catch {
          segments.push(match[2]);
        }
      } else if (match[3] !== undefined) {
        segments.push(Number.parseInt(match[3], 10));
      }
    }
    return segments;
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
    const formattedPath = formatEventPath(path);
    if (!document || typeof formattedPath !== "string" || formattedPath.includes("@")) {
      return undefined;
    }
    const segments = pathSegments(formattedPath);
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
    const widths = headers.map((header, column) => Math.max(
      header.length,
      ...rows.map((row) => row[column].length)
    ));
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

  function datatypeForSourceType(type) {
    return {
      StringLiteral: "string",
      TrimtickStringLiteral: "trimtick",
      SymbolicLiteral: "symbol",
      NumberLiteral: "number",
      IntegerLiteral: "integer",
      FloatLiteral: "float",
      BooleanLiteral: "boolean",
      ToggleLiteral: "toggle",
      NullLiteral: "null",
      NaNLiteral: "nan",
      InfinityLiteral: "infinity",
      ObjectNode: "object",
      ListNode: "list",
      TupleNode: "tuple",
      NodeLiteral: "node",
      HexLiteral: "hex",
      EncodingLiteral: "encoding",
      RadixLiteral: "radix",
      SeparatorLiteral: "separator",
      DateLiteral: "date",
      TimeLiteral: "time",
      DateTimeLiteral: "datetime"
    }[type] || "";
  }

  function datatypeBase(datatype) {
    const text = String(datatype ?? "").trim().toLowerCase();
    const genericIndex = text.indexOf("<");
    const bracketIndex = text.indexOf("[");
    const endIndex = [genericIndex, bracketIndex]
      .filter((index) => index >= 0)
      .reduce((min, index) => Math.min(min, index), text.length);
    return text.slice(0, endIndex);
  }

  function sourceTypeForDatatype(datatype) {
    const base = datatypeBase(datatype);
    if (!base) {
      return null;
    }
    if (["n", "number"].includes(base)) {
      return "NumberLiteral";
    }
    if (["int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64"].includes(base)) {
      return "IntegerLiteral";
    }
    if (["float", "float32", "float64"].includes(base)) {
      return "FloatLiteral";
    }
    if (base === "string") {
      return "StringLiteral";
    }
    if (base === "trimtick" || base === "prose") {
      return "TrimtickStringLiteral";
    }
    if (base === "symbol") {
      return "SymbolicLiteral";
    }
    if (base === "boolean" || base === "bool") {
      return "BooleanLiteral";
    }
    if (base === "toggle") {
      return "ToggleLiteral";
    }
    if (base === "infinity") {
      return "InfinityLiteral";
    }
    if (base === "nan") {
      return "NaNLiteral";
    }
    if (base === "hex") {
      return "HexLiteral";
    }
    if (["radix", "decimal", "radix2", "radix6", "radix8", "radix12"].includes(base)) {
      return "RadixLiteral";
    }
    if (["encoding", "base64", "embed", "inline"].includes(base)) {
      return "EncodingLiteral";
    }
    if (base === "date") {
      return "DateLiteral";
    }
    if (base === "time") {
      return "TimeLiteral";
    }
    if (base === "datetime" || base === "wtc") {
      return "DateTimeLiteral";
    }
    if (base === "sep" || base === "kadot") {
      return "SeparatorLiteral";
    }
    if (base === "tuple") {
      return "TupleNode";
    }
    if (base === "list") {
      return "ListNode";
    }
    if (["object", "obj", "envelope", "o"].includes(base)) {
      return "ObjectNode";
    }
    if (base === "node") {
      return "NodeLiteral";
    }
    if (base === "null") {
      return "NullLiteral";
    }
    return null;
  }

  function sourceTypeForEvent(event) {
    const value = event?.value ?? {};
    return sourceTypeForDatatype(event?.datatype)
      ?? sourceTypeByValueType.get(value.valueType ?? value.type ?? event?.valueType ?? event?.type)
      ?? "StringLiteral";
  }

  function sourceUiValueForEvent(event, type) {
    const value = event?.value ?? {};
    if (type === "StringLiteral" || type === "TrimtickStringLiteral") {
      return value.value ?? value.raw ?? "";
    }
    if (type === "SymbolicLiteral") {
      if (value.value !== undefined) return String(value.value);
      const raw = String(value.raw ?? sourceDefaultValue(type));
      return raw.startsWith("|") && raw.endsWith("|") ? raw.slice(1, -1) : raw;
    }
    if (type === "BooleanLiteral") {
      return value.value === false ? "false" : "true";
    }
    if (type === "NullLiteral") {
      const raw = String(value.raw ?? "");
      const literalValue = String(value.value ?? raw.replace(/^!/, "") ?? "none");
      if (raw.startsWith('!"') || raw.startsWith("!'")) {
        return `custom:${literalValue}`;
      }
      return reservedNullValues.includes(literalValue) ? literalValue : `custom:${literalValue}`;
    }
    if (type === "NaNLiteral") {
      return String(value.raw ?? value.value ?? "NaN");
    }
    if (type === "InfinityLiteral") {
      return String(value.raw ?? value.value ?? "Infinity");
    }
    if (type === "NodeLiteral") {
      return value.tag ?? "node";
    }
    if (type === "HexLiteral") {
      return String(value.raw ?? value.value ?? sourceDefaultValue(type)).replace(/^#/, "");
    }
    if (type === "RadixLiteral") {
      return String(value.raw ?? value.value ?? sourceDefaultValue(type)).replace(/^%/, "");
    }
    if (type === "EncodingLiteral") {
      return String(value.raw ?? value.value ?? sourceDefaultValue(type)).replace(/^&/, "");
    }
    if (type === "SeparatorLiteral") {
      return String(value.raw ?? value.value ?? sourceDefaultValue(type)).replace(/^\^/, "");
    }
    if (sourceTypeAllowsChildren(type)) {
      return "";
    }
    return String(value.raw ?? value.value ?? sourceDefaultValue(type));
  }

  function datatypeName(datatype) {
    if (typeof datatype === "string") {
      return datatype;
    }
    return datatype?.name ?? "";
  }

  function sourceTypeForAeonValue(value) {
    return sourceTypeByValueType.get(value?.valueType ?? value?.type) ?? "StringLiteral";
  }

  function sourceUiValueForAeonValue(value, type) {
    if (type === "StringLiteral" || type === "TrimtickStringLiteral") {
      return value?.value ?? value?.raw ?? "";
    }
    if (type === "SymbolicLiteral") {
      if (value?.value !== undefined) return String(value.value);
      const raw = String(value?.raw ?? sourceDefaultValue(type));
      return raw.startsWith("|") && raw.endsWith("|") ? raw.slice(1, -1) : raw;
    }
    if (type === "BooleanLiteral") {
      return value?.value === false ? "false" : "true";
    }
    if (type === "NullLiteral") {
      const raw = String(value?.raw ?? "");
      const literalValue = String(value?.value ?? raw.replace(/^!/, "") ?? "none");
      if (raw.startsWith('!"') || raw.startsWith("!'")) {
        return `custom:${literalValue}`;
      }
      return reservedNullValues.includes(literalValue) ? literalValue : `custom:${literalValue}`;
    }
    if (type === "NaNLiteral") {
      return String(value?.raw ?? value?.value ?? "NaN");
    }
    if (type === "InfinityLiteral") {
      return String(value?.raw ?? value?.value ?? "Infinity");
    }
    if (type === "NodeLiteral") {
      return value?.tag ?? "node";
    }
    if (type === "HexLiteral") {
      return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^#/, "");
    }
    if (type === "RadixLiteral") {
      return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^%/, "");
    }
    if (type === "EncodingLiteral") {
      return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^&/, "");
    }
    if (type === "SeparatorLiteral") {
      return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^\^/, "");
    }
    if (sourceTypeAllowsChildren(type)) {
      return "";
    }
    return String(value?.raw ?? value?.value ?? sourceDefaultValue(type));
  }

  function sourceTypeForValue(value) {
    if (value === null) {
      return "NullLiteral";
    }
    if (Array.isArray(value)) {
      return "ListNode";
    }
    if (typeof value === "object") {
      return "ObjectNode";
    }
    if (typeof value === "boolean") {
      return "BooleanLiteral";
    }
    if (typeof value === "number") {
      return Number.isInteger(value) ? "IntegerLiteral" : "FloatLiteral";
    }
    return "StringLiteral";
  }

  function sourceDefaultValue(type) {
    return {
      StringLiteral: "",
      TrimtickStringLiteral: "",
      SymbolicLiteral: "symbol",
      NumberLiteral: "0",
      IntegerLiteral: "0",
      FloatLiteral: "0.0",
      BooleanLiteral: "true",
      ToggleLiteral: "on",
      NullLiteral: "none",
      NaNLiteral: "NaN",
      InfinityLiteral: "Infinity",
      ObjectNode: "",
      ListNode: "",
      TupleNode: "",
      NodeLiteral: "node",
      HexLiteral: "00",
      EncodingLiteral: "",
      RadixLiteral: "0",
      SeparatorLiteral: " ",
      DateLiteral: "2026-01-01",
      TimeLiteral: "12:00:00",
      DateTimeLiteral: "2026-01-01T12:00:00Z"
    }[type] ?? "";
  }

  function valuePrefixForSourceType(type) {
    return {
      HexLiteral: "#",
      RadixLiteral: "%",
      SeparatorLiteral: "^",
      SymbolicLiteral: "|...|",
      NullLiteral: "!",
      EncodingLiteral: "&"
    }[type] ?? "";
  }

  function sourceTypeAllowsChildren(type) {
    return type === "ObjectNode" || type === "ListNode" || type === "TupleNode" || type === "NodeLiteral";
  }

  function sourceTypeOptionsForRow(row, rows) {
    if (sourceValueChildren(row.path, rows).length === 0) {
      return sourceTypes;
    }
    if (row.type === "ListNode" || row.type === "TupleNode") {
      return ["ListNode", "TupleNode"];
    }
    return [row.type];
  }

  function isPlainAeonKey(key) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key ?? ""));
  }

  function parseQuotedPathKey(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value;
    }
  }

  function formatSourceMemberPath(key) {
    return isPlainAeonKey(key) ? `.${key}` : `.[${JSON.stringify(String(key ?? ""))}]`;
  }

  function formatSourceAttributePath(key) {
    return isPlainAeonKey(key) ? `.@.${key}` : `.@.[${JSON.stringify(String(key ?? ""))}]`;
  }

  function normalizeSourceRuntimePath(path) {
    let output = "";
    let bracketDepth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < String(path ?? "").length; index += 1) {
      const char = path[index];
      if (inString) {
        output += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        output += char;
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
      }
      if (char === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }
      if (char === "@" && bracketDepth === 0 && path[index + 1] !== ".") {
        output += output.endsWith(".") ? "@." : ".@.";
        continue;
      }
      output += char;
    }
    return output;
  }

  function sourceDisplayName(name, isAttribute = false) {
    if (name.startsWith("//") || /^\[\d+\]$/.test(name)) {
      return name;
    }
    if (isAttribute) {
      const key = name.replace(/^@/, "");
      return `@${isPlainAeonKey(key) ? key : JSON.stringify(key)}`;
    }
    return isPlainAeonKey(name) ? name : JSON.stringify(name);
  }

  function sourcePathSegments(path) {
    return pathSegments(path);
  }

  function sourceParentPath(path) {
    const commentIndex = path.lastIndexOf("#comment");
    if (commentIndex > -1) {
      return path.slice(0, commentIndex);
    }
    const quotedSansaAttrMatch = String(path).match(/\.@\.\["((?:\\.|[^"\\])*)"\]$/);
    if (quotedSansaAttrMatch) {
      return path.slice(0, quotedSansaAttrMatch.index);
    }
    const plainSansaAttrMatch = String(path).match(/\.@\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (plainSansaAttrMatch) {
      return path.slice(0, plainSansaAttrMatch.index);
    }
    const indexMatch = String(path).match(/\[(\d+)\]$/);
    if (indexMatch) {
      return path.slice(0, indexMatch.index);
    }
    const quotedMemberMatch = String(path).match(/\.\["((?:\\.|[^"\\])*)"\]$/);
    if (quotedMemberMatch) {
      return quotedMemberMatch.index > 1 ? path.slice(0, quotedMemberMatch.index) : "";
    }
    const plainMemberMatch = String(path).match(/\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (plainMemberMatch && plainMemberMatch.index > 0) {
      return plainMemberMatch.index > 1 ? path.slice(0, plainMemberMatch.index) : "";
    }
    return "";
  }

  function sourcePathIsAttribute(path) {
    return sourcePathName(path).startsWith("@");
  }

  function sourcePathIsComment(path) {
    return sourcePathName(path).startsWith("//");
  }

  function sourcePathIsDescendant(path, parent) {
    return path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`) || path.startsWith(`${parent}#comment`);
  }

  function sourcePathName(path) {
    const commentMatch = String(path).match(/#comment(\d+)$/);
    if (commentMatch) {
      return `//${commentMatch[1]}`;
    }
    const quotedSansaAttrMatch = String(path).match(/\.@\.\["((?:\\.|[^"\\])*)"\]$/);
    if (quotedSansaAttrMatch) {
      return `@${parseQuotedPathKey(quotedSansaAttrMatch[1])}`;
    }
    const sansaAttrMatch = String(path).match(/\.@\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (sansaAttrMatch) {
      return `@${sansaAttrMatch[1]}`;
    }
    const indexMatch = String(path).match(/\[(\d+)\]$/);
    if (indexMatch) {
      return `[${indexMatch[1]}]`;
    }
    const segments = pathSegments(path);
    const last = segments.at(-1);
    if (typeof last === "string") {
      return last;
    }
    if (typeof last === "number") {
      return `[${last}]`;
    }
    return path.replace(/^\$\.?/, "");
  }

  function joinSourcePath(parent, name) {
    if (!parent) {
      return `$${formatSourceMemberPath(name)}`;
    }
    if (/^\[\d+\]$/.test(name)) {
      return `${parent}${name}`;
    }
    if (name.startsWith("@")) {
      return `${parent}${formatSourceAttributePath(name.replace(/^@/, ""))}`;
    }
    if (name.startsWith("#comment")) {
      return `${parent}${name}`;
    }
    return `${parent}${formatSourceMemberPath(name)}`;
  }

  function sourceDepth(path) {
    return sourcePathSegments(path).length + (sourcePathIsAttribute(path) || sourcePathIsComment(path) ? 1 : 0);
  }

  function sourceChildren(path, rows = state.sourceBuilderRows) {
    return rows.filter((row) => sourceParentPath(row.path) === path);
  }

  function sourceValueChildren(path, rows = state.sourceBuilderRows) {
    return sourceChildren(path, rows).filter((row) => !sourcePathIsAttribute(row.path) && !sourcePathIsComment(row.path));
  }

  function sourceRowsFromValue(value, path = "$.value", rows = []) {
    const type = sourceTypeForValue(value);
    rows.push({
      path,
      type,
      datatype: "",
      value: sourceTypeAllowsChildren(type) ? "" : String(value ?? sourceDefaultValue(type)),
      open: true
    });

    if (Array.isArray(value)) {
      value.forEach((child, index) => sourceRowsFromValue(child, `${path}[${index}]`, rows));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => sourceRowsFromValue(child, joinSourcePath(path, key), rows));
    }
    return rows;
  }

  function attributeEntries(attributes) {
    const output = [];
    if (attributes instanceof Map) {
      return Array.from(attributes.entries());
    }
    if (attributes && !Array.isArray(attributes) && typeof attributes === "object") {
      return Object.entries(attributes);
    }
    for (const attribute of attributes ?? []) {
      const entries = attribute?.entries instanceof Map
        ? attribute.entries
        : new Map(Object.entries(attribute?.entries ?? {}));
      for (const entry of entries) {
        output.push(entry);
      }
    }
    return output;
  }

  function aeonAttributeSource(value) {
    return value?.attributes ?? value?.annotations ?? [];
  }

  function addSourceAttributeRows(attributes, ownerPath, rows, seen) {
    for (const [key, entry] of attributeEntries(attributes)) {
      const path = joinSourcePath(ownerPath, `@${key}`);
      if (seen.has(path)) {
        continue;
      }
      const type = sourceTypeForDatatype(entry?.datatype) ?? sourceTypeForAeonValue(entry?.value);
      rows.push({
        path,
        type,
        datatype: datatypeName(entry?.datatype) || "",
        value: sourceUiValueForAeonValue(entry?.value, type),
        open: true
      });
      seen.add(path);
      addSourceAttributeRows(aeonAttributeSource(entry), path, rows, seen);
      addSourceAttributeRowsFromValue(entry?.value, path, rows, seen);
    }
  }

  function addSourceAttributeRowsFromValue(value, path, rows, seen) {
    addSourceAttributeRows(aeonAttributeSource(value), path, rows, seen);
    if (value?.type === "ObjectNode") {
      for (const binding of value.bindings ?? []) {
        const child = joinSourcePath(path, binding.key);
        addSourceAttributeRows(aeonAttributeSource(binding), child, rows, seen);
        addSourceAttributeRowsFromValue(binding.value, child, rows, seen);
      }
    }
    if (value?.type === "ListNode" || value?.type === "TupleNode") {
      for (const [index, element] of (value.elements ?? []).entries()) {
        addSourceAttributeRowsFromValue(element, `${path}[${index}]`, rows, seen);
      }
    }
    if (value?.type === "NodeLiteral") {
      for (const [index, child] of (value.children ?? []).entries()) {
        addSourceAttributeRowsFromValue(child, `${path}[${index}]`, rows, seen);
      }
    }
  }

  function sourceRowsFromRuntimeResult(result) {
    const events = Array.isArray(result?.aes) ? result.aes : Array.isArray(result?.events) ? result.events : [];
    const rows = [];
    const seen = new Set();
    for (const event of events) {
      const path = normalizeSourceRuntimePath(formatEventPath(event.path));
      if (!path || path === "$" || path.includes("[*]") || path.startsWith('$.["aeon:') || seen.has(path)) {
        continue;
      }
      const type = sourceTypeForEvent(event);
      rows.push({
        path,
        type,
        datatype: event.datatype ?? "",
        value: sourceUiValueForEvent(event, type),
        open: true
      });
      seen.add(path);
      addSourceAttributeRows(aeonAttributeSource(event), path, rows, seen);
      addSourceAttributeRowsFromValue(event.value, path, rows, seen);
    }
    if (rows.length > 0) {
      return rows;
    }
    const document = result?.document;
    const root = document && typeof document === "object" && "payload" in document ? document.payload : document;
    if (!root || typeof root !== "object") {
      return sourceRowsFromValue(root ?? "", "$.value");
    }
    return Object.entries(root).flatMap(([key, value]) => sourceRowsFromValue(value, `$.${key}`));
  }

  function parseStandaloneSemanticComments(text) {
    const commentsByPath = new Map();
    const pending = [];
    const stack = [];
    const lines = String(text ?? "").split(/\r?\n/);
    for (const line of lines) {
      const standalone = line.match(/^\s*\/\/([#@?{\[(])\s?(.*)$/);
      if (standalone) {
        pending.push({
          type: sourceCommentTypeByMarker[standalone[1]] ?? "doc",
          value: standalone[2] ?? ""
        });
        continue;
      }
      if (/\/\/[#@?{\[(]/.test(line)) {
        continue;
      }
      const binding = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*|"([^"\\]|\\.)*"|'([^'\\]|\\.)*')\s*(?:@\{[^}]*\}\s*)?(?::[^=]+)?=/);
      if (!binding) {
        continue;
      }
      const indent = binding[1].length;
      while (stack.length > 0 && stack.at(-1).indent >= indent) {
        stack.pop();
      }
      const rawKey = binding[2];
      let key = rawKey;
      if (rawKey.startsWith('"') || rawKey.startsWith("'")) {
        try {
          key = JSON.parse(rawKey.startsWith("'") ? `"${rawKey.slice(1, -1).replaceAll('"', '\\"')}"` : rawKey);
        } catch {
          key = rawKey.slice(1, -1);
        }
      }
      const parent = stack.at(-1)?.path ?? "";
      const path = joinSourcePath(parent, key);
      if (pending.length > 0) {
        commentsByPath.set(path, [...(commentsByPath.get(path) ?? []), ...pending.splice(0)]);
      }
      if (line.includes("{")) {
        stack.push({ indent, path });
      }
    }
    return commentsByPath;
  }

  function addStandaloneCommentRows(text, rows) {
    const commentsByPath = parseStandaloneSemanticComments(text);
    const seen = new Set(rows.map((row) => row.path));
    for (const [ownerPath, comments] of commentsByPath) {
      if (!rows.some((row) => row.path === ownerPath)) {
        continue;
      }
      let index = 1;
      for (const comment of comments) {
        while (seen.has(joinSourcePath(ownerPath, `#comment${index}`))) {
          index += 1;
        }
        const path = joinSourcePath(ownerPath, `#comment${index}`);
        rows.push({
          path,
          kind: "comment",
          commentType: comment.type,
          value: comment.value,
          open: true
        });
        seen.add(path);
        index += 1;
      }
    }
  }

  function preservedHeaderSource(text) {
    const lines = String(text ?? "").split(/\r?\n/);
    const output = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*aeon\s*:\s*header\s*=/.test(line)) {
        output.push(line);
        let depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        while (depth > 0 && index + 1 < lines.length) {
          index += 1;
          output.push(lines[index]);
          depth += (lines[index].match(/\{/g) ?? []).length - (lines[index].match(/\}/g) ?? []).length;
        }
        continue;
      }
      if (/^\s*aeon\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
        output.push(line);
      }
    }
    return output.join("\n").trim();
  }

  function orderedSourceRows(rows) {
    const byPath = new Map(rows.map((row) => [row.path, row]));
    const orderedChildren = (parentPath) => rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => sourceParentPath(row.path) === parentPath)
      .sort((left, right) => {
        const leftComment = sourcePathIsComment(left.row.path);
        const rightComment = sourcePathIsComment(right.row.path);
        if (leftComment !== rightComment) {
          return leftComment ? -1 : 1;
        }
        const leftAttr = sourcePathIsAttribute(left.row.path);
        const rightAttr = sourcePathIsAttribute(right.row.path);
        if (leftAttr !== rightAttr) {
          return leftAttr ? -1 : 1;
        }
        return left.index - right.index;
      })
      .map(({ row }) => row);
    const visit = (row, output) => {
      output.push(row);
      orderedChildren(row.path).forEach((child) => visit(child, output));
    };
    const output = [];
    rows
      .filter((row) => !byPath.has(sourceParentPath(row.path)))
      .forEach((row) => visit(row, output));
    return output;
  }

  function visibleSourceRows(rows) {
    return orderedSourceRows(rows).filter((row) => {
      let parent = sourceParentPath(row.path);
      while (parent) {
        const parentRow = rows.find((candidate) => candidate.path === parent);
        if (parentRow && parentRow.open === false) {
          return false;
        }
        parent = sourceParentPath(parent);
      }
      return true;
    });
  }

  function renderSourceBuilder() {
    if (!sourceBuilderTree || !sourceBuilderDetail) {
      return;
    }
    const rows = state.sourceBuilderRows;
    if (!state.sourceBuilderSelectedPath || !rows.some((row) => row.path === state.sourceBuilderSelectedPath)) {
      state.sourceBuilderSelectedPath = rows[0]?.path ?? null;
    }
    sourceBuilderTree.innerHTML = visibleSourceRows(rows).map((row) => {
      const selected = row.path === state.sourceBuilderSelectedPath;
    const hasChildren = sourceChildren(row.path, rows).length > 0;
    const name = sourcePathName(row.path);
    const isAttribute = sourcePathIsAttribute(row.path);
    const isComment = sourcePathIsComment(row.path);
    const displayName = isComment ? `//${sourceCommentMarkers[row.commentType ?? "doc"]} ${row.value ?? ""}` : sourceDisplayName(name, isAttribute);
    return `
        <button class="source-builder-tree-item${selected ? " is-selected" : ""}${isAttribute ? " is-attribute" : ""}${isComment ? " is-comment" : ""}" type="button" data-source-builder-path="${escapeHtml(row.path)}" style="--source-depth:${Math.max(0, sourceDepth(row.path) - 1)}">
          <span class="source-builder-twist">${isAttribute ? "" : hasChildren ? (row.open === false ? "+" : "-") : ""}</span>
          <span class="source-builder-name">${escapeHtml(displayName)}</span>
          <span class="source-builder-type">${isComment ? escapeHtml(row.commentType ?? "doc") : escapeHtml(row.datatype || datatypeForSourceType(row.type))}</span>
        </button>`;
    }).join("");

    const selected = rows.find((row) => row.path === state.sourceBuilderSelectedPath);
    if (!selected) {
      if (sourceBuilderRemove) {
        sourceBuilderRemove.disabled = true;
        sourceBuilderRemove.textContent = "Remove binding";
      }
      sourceBuilderDetail.innerHTML = "<p class=\"source-builder-empty\">No binding selected.</p>";
      return;
    }
    if (selected.kind === "comment") {
      if (sourceBuilderAddChild) {
        sourceBuilderAddChild.disabled = true;
      }
      if (sourceBuilderAddAttribute) {
        sourceBuilderAddAttribute.disabled = true;
      }
      if (sourceBuilderAddComment) {
        sourceBuilderAddComment.disabled = true;
      }
      if (sourceBuilderRemove) {
        sourceBuilderRemove.disabled = false;
        sourceBuilderRemove.textContent = "Remove comment";
      }
      sourceBuilderDetail.innerHTML = `
        <label>
          <span>Comment type</span>
          <select name="commentType">
            ${sourceCommentTypes.map(([value, label]) => `<option value="${value}"${value === selected.commentType ? " selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label class="source-builder-value-field">
          <span>Value</span>
          <textarea name="value">${escapeHtml(selected.value)}</textarea>
        </label>
      `;
      return;
    }
    const hasChildren = sourceValueChildren(selected.path, rows).length > 0;
    const valueDisabled = selected.type !== "NodeLiteral" && (sourceTypeAllowsChildren(selected.type) || hasChildren) ? " disabled" : "";
    const valueLabel = selected.type === "NodeLiteral" ? "Tag" : "Value";
    const valuePrefix = valuePrefixForSourceType(selected.type);
    const typeOptions = sourceTypeOptionsForRow(selected, rows);
    const isAttribute = sourcePathIsAttribute(selected.path);
    const nullValue = String(selected.value ?? "none");
    const nullMode = nullValue.startsWith("custom:") ? "custom" : nullValue;
    if (sourceBuilderAddChild) {
      sourceBuilderAddChild.disabled = isAttribute || !sourceTypeAllowsChildren(selected.type);
    }
    if (sourceBuilderAddAttribute) {
      sourceBuilderAddAttribute.disabled = isAttribute;
    }
    if (sourceBuilderAddComment) {
      sourceBuilderAddComment.disabled = isAttribute;
    }
    if (sourceBuilderRemove) {
      sourceBuilderRemove.disabled = false;
      sourceBuilderRemove.textContent = "Remove binding";
    }
    sourceBuilderDetail.innerHTML = `
      <label>
        <span>Key</span>
        <input name="name" type="text" value="${escapeHtml(sourcePathName(selected.path).replace(/^@/, "").replace(/^\[|\]$/g, ""))}" ${/^\[\d+\]$/.test(sourcePathName(selected.path)) && !isAttribute ? "disabled" : ""} />
      </label>
      <label>
        <span>Type</span>
        <select name="type">
          ${typeOptions.map((type) => `<option value="${type}"${type === selected.type ? " selected" : ""}>${type}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>Datatype</span>
        <input name="datatype" type="text" value="${escapeHtml(selected.datatype ?? datatypeForSourceType(selected.type))}" />
      </label>
      ${selected.type === "NullLiteral" ? `
        <label>
          <span>Value !</span>
          <select name="nullMode">
            ${[...reservedNullValues, "custom"].map((value) => `<option value="${value}"${value === nullMode ? " selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
        <label class="source-builder-value-field${nullMode === "custom" ? "" : " is-hidden"}">
          <span>Custom null</span>
          <input name="value" type="text" value="${escapeHtml(nullValue.startsWith("custom:") ? nullValue.slice("custom:".length) : "")}" />
        </label>
      ` : selected.type === "BooleanLiteral" ? `
        <label>
          <span>Value</span>
          <select name="value"${valueDisabled}>
            ${["true", "false"].map((value) => `<option value="${value}"${value === String(selected.value ?? "true") ? " selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
      ` : selected.type === "ToggleLiteral" ? `
        <label>
          <span>Value</span>
          <select name="value"${valueDisabled}>
            ${["yes", "no", "on", "off"].map((value) => `<option value="${value}"${value === String(selected.value ?? "on") ? " selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
      ` : selected.type === "InfinityLiteral" ? `
        <label>
          <span>Value</span>
          <select name="value"${valueDisabled}>
            ${["Infinity", "-Infinity"].map((value) => `<option value="${value}"${value === String(selected.value ?? "Infinity") ? " selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
      ` : selected.type === "NaNLiteral" ? `
        <label>
          <span>Value</span>
          <select name="value"${valueDisabled}>
            ${["NaN", "-NaN"].map((value) => `<option value="${value}"${value === String(selected.value ?? "NaN") ? " selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
      ` : `
      <label class="source-builder-value-field">
        <span>${valuePrefix ? `${valueLabel} ${valuePrefix}` : valueLabel}</span>
        <textarea name="value"${valueDisabled}>${escapeHtml(selected.value)}</textarea>
      </label>
      `}
    `;
  }

  async function seedSourceBuilderRows() {
    const { runRuntime } = await runtimeReady;
    const mapping = mapMode(state.mode);
    let result = runRuntime(sourceForMode(source.value, state.mode), {
      profile: runtimeProfile,
      mode: mapping.runtimeMode,
      datatypePolicy: mapping.datatypePolicy,
      includeAnnotations: true,
      output: "map"
    });
    let rows = sourceRowsFromRuntimeResult(result);
    if (state.mode !== "transport" && (result.meta?.errors?.length ?? 0) > 0) {
      const seedResult = runRuntime(sourceForBuilderSeed(source.value), {
        profile: runtimeProfile,
        mode: "loose",
        datatypePolicy: "reserved_only",
        includeAnnotations: true,
        output: "map"
      });
      const seedRows = sourceRowsFromRuntimeResult(seedResult);
      if (seedRows.length > 0) {
        result = seedResult;
        rows = seedRows;
      }
    }
    state.lastRuntimeResult = result;
    state.sourceBuilderRows = rows;
    addStandaloneCommentRows(source.value, state.sourceBuilderRows);
    if (state.mode !== "transport") {
      for (const row of state.sourceBuilderRows) {
        if (row.kind !== "comment" && !row.datatype) {
          row.datatype = datatypeForSourceType(row.type);
        }
      }
    }
    state.sourceBuilderSelectedPath = state.sourceBuilderRows[0]?.path ?? null;
  }

  async function openSourceBuilder() {
    if (!sourceBuilderModal) {
      return;
    }
    await seedSourceBuilderRows();
    renderSourceBuilder();
    window.AeonAccessibility?.openModal(sourceBuilderModal, sourceBuilderOpen);
  }

  function closeSourceBuilder() {
    if (sourceBuilderModal) {
      window.AeonAccessibility?.closeModal(sourceBuilderModal);
    }
  }

  function syncSourceBuilderDetail() {
    if (!sourceBuilderDetail || !state.sourceBuilderSelectedPath) {
      return;
    }
    const row = state.sourceBuilderRows.find((candidate) => candidate.path === state.sourceBuilderSelectedPath);
    if (!row) {
      return;
    }
    const data = new FormData(sourceBuilderDetail);
    if (row.kind === "comment") {
      row.commentType = String(data.get("commentType") || "doc");
      row.value = String(data.get("value") ?? "");
      return;
    }
    const previousPath = row.path;
    const previousType = row.type;
    const previousDatatype = row.datatype;
    const type = String(data.get("type") || row.type);
    const name = String(data.get("name") || sourcePathName(row.path)).trim();
    const parent = sourceParentPath(row.path);
    const isAttribute = sourcePathIsAttribute(row.path);
    const defaultPreviousDatatype = datatypeForSourceType(previousType);
    const defaultNextDatatype = datatypeForSourceType(type);
    const previousDatatypeWasReservedForType = sourceTypeForDatatype(previousDatatype) === previousType;
    row.type = type;
    row.datatype = previousType === type
      ? String(data.get("datatype") ?? "")
      : previousDatatype === defaultPreviousDatatype || previousDatatypeWasReservedForType ? defaultNextDatatype : String(data.get("datatype") || "");
    if (type === "NullLiteral") {
      const nullMode = String(data.get("nullMode") || "none");
      row.value = nullMode === "custom" ? `custom:${String(data.get("value") ?? "")}` : nullMode;
    } else {
      row.value = previousType === type
        ? String(data.get("value") ?? sourceDefaultValue(type))
        : sourceDefaultValue(type);
    }
    const children = sourceValueChildren(row.path);
    const allowedTypes = previousType === "ListNode" || previousType === "TupleNode"
      ? ["ListNode", "TupleNode"]
      : [previousType];
    if (children.length > 0 && !allowedTypes.includes(type)) {
      row.type = previousType;
      row.datatype = datatypeForSourceType(row.type);
    }
    if (name && (!/^\[\d+\]$/.test(sourcePathName(row.path)) || isAttribute)) {
      const nextPath = joinSourcePath(parent, isAttribute ? `@${name.replace(/^@/, "")}` : name);
      if (nextPath !== previousPath && !state.sourceBuilderRows.some((candidate) => candidate.path === nextPath)) {
        for (const candidate of state.sourceBuilderRows) {
          if (candidate.path === previousPath || sourcePathIsDescendant(candidate.path, previousPath)) {
            candidate.path = `${nextPath}${candidate.path.slice(previousPath.length)}`;
          }
        }
        state.sourceBuilderSelectedPath = nextPath;
      }
    }
  }

  function addSourceBuilderRow(kind) {
    syncSourceBuilderDetail();
    const rows = state.sourceBuilderRows;
    const selected = rows.find((row) => row.path === state.sourceBuilderSelectedPath) ?? rows[0];
    const selectedIsAttribute = sourcePathIsAttribute(selected?.path ?? "");
    const selectedIsComment = sourcePathIsComment(selected?.path ?? "");
    const base = kind === "attribute" && selected && !selectedIsAttribute
      ? selected.path
      : kind === "comment" && selected && !selectedIsAttribute && !selectedIsComment
        ? selected.path
      : kind === "child" && selected && !selectedIsAttribute && sourceTypeAllowsChildren(selected.type)
        ? selected.path
        : sourceParentPath(selected?.path ?? "");
    const parent = rows.find((row) => row.path === base);
    const childIndex = sourceValueChildren(base, rows).length;
    const attrNames = new Set(sourceChildren(base, rows).filter((row) => sourcePathIsAttribute(row.path)).map((row) => sourcePathName(row.path)));
    const commentNames = new Set(sourceChildren(base, rows).filter((row) => sourcePathIsComment(row.path)).map((row) => sourcePathName(row.path)));
    let attrIndex = attrNames.size + 1;
    while (attrNames.has(`@attr${attrIndex}`)) {
      attrIndex += 1;
    }
    let commentIndex = commentNames.size + 1;
    while (commentNames.has(`//${commentIndex}`)) {
      commentIndex += 1;
    }
    const name = kind === "comment"
      ? `#comment${commentIndex}`
      : kind === "attribute"
      ? `@attr${attrIndex}`
      : parent?.type === "ListNode" || parent?.type === "TupleNode" || parent?.type === "NodeLiteral" ? `[${childIndex}]` : `field${childIndex + 1}`;
    const path = joinSourcePath(base, name);
    rows.push({
      path,
      ...(kind === "comment" ? { kind: "comment", commentType: "doc" } : {}),
      type: "StringLiteral",
      datatype: state.mode === "transport" || kind === "comment" ? "" : "string",
      value: kind === "comment" ? "Comment" : "",
      open: true
    });
    if (parent) {
      parent.open = true;
    }
    state.sourceBuilderSelectedPath = path;
    renderSourceBuilder();
  }

  function removeSourceBuilderRow() {
    const path = state.sourceBuilderSelectedPath;
    if (!path) {
      return;
    }
    const visibleBeforeRemove = visibleSourceRows(state.sourceBuilderRows);
    const removedIndex = visibleBeforeRemove.findIndex((row) => row.path === path);
    const nextSelectedPath = removedIndex > 0
      ? visibleBeforeRemove[removedIndex - 1]?.path
      : visibleBeforeRemove.find((row, index) => index > removedIndex && !sourcePathIsDescendant(row.path, path))?.path;
    state.sourceBuilderRows = state.sourceBuilderRows.filter((row) => row.path !== path && !sourcePathIsDescendant(row.path, path));
    state.sourceBuilderSelectedPath = nextSelectedPath && state.sourceBuilderRows.some((row) => row.path === nextSelectedPath)
      ? nextSelectedPath
      : state.sourceBuilderRows[0]?.path ?? null;
    renderSourceBuilder();
  }

  function aeonKey(key) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
  }

  function renderSourceBuilderAttributes(row, rows) {
    const attrs = sourceChildren(row.path, rows).filter((child) => sourcePathIsAttribute(child.path));
    if (attrs.length === 0) {
      return "";
    }
    const values = attrs.map((attr) => {
      const key = sourcePathName(attr.path).replace(/^@/, "");
      const datatype = attr.datatype ? `:${attr.datatype}` : "";
      return `${aeonKey(key)}${datatype} = ${renderSourceBuilderValue(attr, rows)}`;
    });
    return ` @{${values.join(", ")}}`;
  }

  function renderSourceBuilderComments(row, rows, depth = 0) {
    return sourceChildren(row.path, rows)
      .filter((child) => sourcePathIsComment(child.path))
      .map((comment) => {
        const marker = sourceCommentMarkers[comment.commentType ?? "doc"] ?? "#";
        return `${"  ".repeat(depth)}//${marker} ${String(comment.value ?? "").replace(/\r?\n/g, " ")}`;
      })
      .join("\n");
  }

  function aeonScalarValue(row) {
    const value = String(row.value ?? sourceDefaultValue(row.type));
    if (row.type === "StringLiteral") {
      return JSON.stringify(value);
    }
    if (row.type === "TrimtickStringLiteral") {
      return `>\`\n${value}\n\``;
    }
    if (row.type === "SymbolicLiteral") {
      const payload = value || sourceDefaultValue(row.type);
      return `|${JSON.stringify(payload).slice(1, -1).replaceAll("|", "\\|")}|`;
    }
    if (row.type === "BooleanLiteral") {
      return value === "false" ? "false" : "true";
    }
    if (row.type === "ToggleLiteral") {
      return ["off", "yes", "no"].includes(value) ? value : "on";
    }
    if (row.type === "NullLiteral") {
      if (value.startsWith("custom:")) {
        return `!${JSON.stringify(value.slice("custom:".length))}`;
      }
      if (reservedNullValues.includes(value)) {
        return `!${value}`;
      }
      return value ? `!${JSON.stringify(value)}` : "!none";
    }
    if (row.type === "NaNLiteral") {
      return value === "-NaN" ? "-NaN" : "NaN";
    }
    if (row.type === "InfinityLiteral") {
      return value === "-Infinity" ? "-Infinity" : "Infinity";
    }
    if (row.type === "EncodingLiteral") {
      return value.startsWith("&") ? value : `&${value}`;
    }
    if (row.type === "SeparatorLiteral") {
      return value.startsWith("^") ? value : `^${value || " "}`;
    }
    if (row.type === "HexLiteral") {
      return value.startsWith("#") ? value : `#${value || "00"}`;
    }
    if (row.type === "RadixLiteral") {
      return value.startsWith("%") ? value : `%${value || "0"}`;
    }
    if (row.type === "ObjectNode") {
      return "{}";
    }
    if (row.type === "ListNode") {
      return "[]";
    }
    if (row.type === "TupleNode") {
      return "()";
    }
    if (row.type === "NodeLiteral") {
      return `<${aeonKey(value || "node")}()>`;
    }
    return value || sourceDefaultValue(row.type);
  }

  function trimtickValue(value, depth) {
    const indent = "  ".repeat(depth);
    const contentIndent = "  ".repeat(depth + 1);
    const lines = String(value ?? "").split(/\r?\n/);
    const body = lines.map((line) => `${contentIndent}${line}`).join("\n");
    return `>\`\n${body}\n${indent}\``;
  }

  function renderSourceBuilderValue(row, rows, depth = 0) {
    const children = sourceValueChildren(row.path, rows);
    if (row.type === "TrimtickStringLiteral") {
      return trimtickValue(row.value, depth);
    }
    if (row.type === "ListNode" || row.type === "TupleNode") {
      const open = row.type === "TupleNode" ? "(" : "[";
      const close = row.type === "TupleNode" ? ")" : "]";
      if (children.length === 0) {
        return `${open}${close}`;
      }
      const values = children.map((child) => `${"  ".repeat(depth + 1)}${renderSourceBuilderValue(child, rows, depth + 1)}`);
      return `${open}\n${values.join(",\n")}\n${"  ".repeat(depth)}${close}`;
    }
    if (row.type === "ObjectNode") {
      if (children.length === 0) {
        return "{}";
      }
      const values = children.map((child) => renderSourceBuilderBinding(child, rows, depth + 1));
      return `{\n${values.join("\n")}\n${"  ".repeat(depth)}}`;
    }
    if (row.type === "NodeLiteral") {
      if (children.length === 0) {
        return aeonScalarValue(row);
      }
      const values = children.map((child) => `${"  ".repeat(depth + 1)}${renderSourceBuilderValue(child, rows, depth + 1)}`);
      return `<${aeonKey(row.value || "node")}(\n${values.join("\n")}\n${"  ".repeat(depth)})>`;
    }
    return aeonScalarValue(row);
  }

  function renderSourceBuilderBinding(row, rows, depth = 0) {
    const name = sourcePathName(row.path);
    const datatype = row.datatype ? `:${row.datatype}` : "";
    const attrs = renderSourceBuilderAttributes(row, rows);
    const comments = renderSourceBuilderComments(row, rows, depth);
    const binding = `${"  ".repeat(depth)}${aeonKey(name)}${attrs}${datatype} = ${renderSourceBuilderValue(row, rows, depth)}`;
    return [comments, binding].filter(Boolean).join("\n");
  }

  function buildSourceFromBuilder() {
    syncSourceBuilderDetail();
    const rows = orderedSourceRows(state.sourceBuilderRows);
    const header = preservedHeaderSource(source.value);
    const body = rows
      .filter((row) => !sourceParentPath(row.path) && !sourcePathIsAttribute(row.path) && !sourcePathIsComment(row.path))
      .map((row) => renderSourceBuilderBinding(row, rows))
      .join("\n");
    return [header, body].filter(Boolean).join("\n");
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
      const payload = formatRuntimeResult(runtimeResult);
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

  if (!sharedSourceComposer && sourceBuilderOpen) {
    sourceBuilderOpen.addEventListener("click", () => {
      openSourceBuilder().catch((error) => {
        errors.textContent = error instanceof Error ? error.message : String(error);
      });
    });
  }

  if (!sharedSourceComposer && sourceBuilderReload) {
    sourceBuilderReload.addEventListener("click", () => {
      seedSourceBuilderRows()
        .then(renderSourceBuilder)
        .catch((error) => {
          errors.textContent = error instanceof Error ? error.message : String(error);
        });
    });
  }

  if (!sharedSourceComposer && sourceBuilderApply) {
    sourceBuilderApply.addEventListener("click", () => {
      source.value = buildSourceFromBuilder();
      source.dispatchEvent(new Event("input", { bubbles: true }));
      closeSourceBuilder();
    });
  }

  if (!sharedSourceComposer && sourceBuilderAddPeer) {
    sourceBuilderAddPeer.addEventListener("click", () => addSourceBuilderRow("peer"));
  }

  if (!sharedSourceComposer && sourceBuilderAddChild) {
    sourceBuilderAddChild.addEventListener("click", () => addSourceBuilderRow("child"));
  }

  if (!sharedSourceComposer && sourceBuilderAddAttribute) {
    sourceBuilderAddAttribute.addEventListener("click", () => addSourceBuilderRow("attribute"));
  }

  if (!sharedSourceComposer && sourceBuilderAddComment) {
    sourceBuilderAddComment.addEventListener("click", () => addSourceBuilderRow("comment"));
  }

  if (!sharedSourceComposer && sourceBuilderRemove) {
    sourceBuilderRemove.addEventListener("click", removeSourceBuilderRow);
  }

  if (!sharedSourceComposer && sourceBuilderTree) {
    sourceBuilderTree.addEventListener("click", (event) => {
      const item = event.target.closest("[data-source-builder-path]");
      if (!item) {
        return;
      }
      syncSourceBuilderDetail();
      const path = item.dataset.sourceBuilderPath;
      state.sourceBuilderSelectedPath = path;
      if (event.target.closest(".source-builder-twist")) {
        const row = state.sourceBuilderRows.find((candidate) => candidate.path === path);
        if (row && sourceValueChildren(row.path).length > 0) {
          row.open = row.open === false;
        }
      }
      renderSourceBuilder();
    });
  }

  if (!sharedSourceComposer && sourceBuilderDetail) {
    sourceBuilderDetail.addEventListener("input", (event) => {
      if (event.target?.name === "type") {
        return;
      }
      syncSourceBuilderDetail();
      if (event.target?.name === "commentType" || state.sourceBuilderRows.find((row) => row.path === state.sourceBuilderSelectedPath)?.kind === "comment") {
        renderSourceBuilder();
        sourceBuilderDetail.querySelector(`[name="${event.target?.name}"]`)?.focus();
      }
    });
    sourceBuilderDetail.addEventListener("change", (event) => {
      if (event.target?.name === "commentType") {
        syncSourceBuilderDetail();
        renderSourceBuilder();
        sourceBuilderDetail.querySelector('[name="commentType"]')?.focus();
        return;
      }
      if (event.target?.name === "nullMode") {
        syncSourceBuilderDetail();
        renderSourceBuilder();
        sourceBuilderDetail.querySelector('[name="nullMode"]')?.focus();
        return;
      }
      if (event.target?.name === "type") {
        syncSourceBuilderDetail();
        renderSourceBuilder();
      }
    });
    sourceBuilderDetail.addEventListener("click", (event) => {
      if (event.target.closest("[data-source-builder-remove]")) {
        removeSourceBuilderRow();
      }
    });
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

  if (!sharedSourceComposer) {
    sourceBuilderClose.forEach((button) => {
      button.addEventListener("click", closeSourceBuilder);
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && examplesModal && !examplesModal.hidden) {
      closeExamples();
    }
    if (!sharedSourceComposer && event.key === "Escape" && sourceBuilderModal && !sourceBuilderModal.hidden) {
      closeSourceBuilder();
    }
  });

  render();
  window.dispatchEvent(new Event('aeon-playground-ready'));
});
