import {parseAddress, renderAddress} from "@altopelago/sansa";
import {formatClarifierValue} from "@aeon/parser";
import {createComposerPaths} from "./composer-paths.mjs";
const composerPaths = createComposerPaths({parseAddress, renderAddress});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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
    SeparatorLiteral: "sep",
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
  if (!base) return null;
  if (["n", "number"].includes(base)) return "NumberLiteral";
  if (["int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64"].includes(base)) return "IntegerLiteral";
  if (["float", "float32", "float64"].includes(base)) return "FloatLiteral";
  if (base === "string") return "StringLiteral";
  if (base === "trimtick" || base === "prose") return "TrimtickStringLiteral";
  if (base === "symbol") return "SymbolicLiteral";
  if (base === "boolean" || base === "bool") return "BooleanLiteral";
  if (base === "toggle") return "ToggleLiteral";
  if (base === "infinity") return "InfinityLiteral";
  if (base === "nan") return "NaNLiteral";
  if (base === "hex") return "HexLiteral";
  if (["radix", "decimal", "radix2", "radix6", "radix8", "radix12", "radix16"].includes(base)) return "RadixLiteral";
  if (["encoding", "base64", "embed", "inline"].includes(base)) return "EncodingLiteral";
  if (base === "date") return "DateLiteral";
  if (base === "time") return "TimeLiteral";
  if (base === "datetime") return "DateTimeLiteral";
  if (base === "wtc") return "DateTimeLiteral";
  if (base === "sep" || base === "kadot" || base === "separator") return "SeparatorLiteral";
  if (base === "tuple" || base === "triple") return "TupleNode";
  if (base === "list") return "ListNode";
  if (["object", "obj", "envelope", "o"].includes(base)) return "ObjectNode";
  if (base === "node") return "NodeLiteral";
  if (base === "null") return "NullLiteral";
  return null;
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

function isPlainAeonKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key ?? ""));
}

function formatSourceMemberPath(key) {
  return isPlainAeonKey(key) ? `.${key}` : `.[${JSON.stringify(String(key ?? ""))}]`;
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
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === "@" && bracketDepth === 0 && path[index + 1] !== ".") {
      output += output.endsWith(".") ? "@." : ".@.";
      continue;
    }
    output += char;
  }
  return output;
}

function sourceDisplayName(name, isAttribute = false) {
  if (name.startsWith("//") || /^\[\d+\]$/.test(name)) return name;
  if (isAttribute) {
    const key = name.replace(/^@/, "");
    return `@${isPlainAeonKey(key) ? key : JSON.stringify(key)}`;
  }
  return isPlainAeonKey(name) ? name : JSON.stringify(name);
}

function sourceParentPath(path) {
  return composerPaths.describe(path).parent;
}

function sourcePathIsAttribute(path) {
  return composerPaths.describe(path).kind === "attribute";
}

function sourcePathIsComment(path) {
  return composerPaths.describe(path).kind === "comment";
}

function sourcePathIsDescendant(path, parent) {
  return path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`) || path.startsWith(`${parent}#comment`);
}

function sourcePathName(path) {
  return composerPaths.describe(path).name;
}

function joinSourcePath(parent, name, kind = "member") {
  return composerPaths.join(parent, name, kind);
}

function sourceDepth(path) {
  return composerPaths.describe(path).depth;
}

function datatypeName(datatype) {
  if (typeof datatype === "string") return datatype;
  if (!datatype) return "";
  const generics = datatype.genericArgs?.length ? `<${datatype.genericArgs.join(", ")}>` : "";
  const clarifiers = datatype.clarifiers?.length ? `[${datatype.clarifiers.map(formatClarifierValue).join(", ")}]` : "";
  return `${datatype.name}${generics}${clarifiers}`;
}

function formatEventPath(path) {
  if (typeof path === "string") return path;
  if (path && typeof path === "object" && typeof window.AeonFormatPath === "function") {
    return window.AeonFormatPath(path);
  }
  if (path?.segments) {
    let result = "";
    for (const segment of path.segments) {
      if (segment.type === "root") {
        result = "$";
      } else if (segment.type === "member") {
        result += formatSourceMemberPath(segment.key);
      } else if (segment.type === "index") {
        result += `[${segment.index}]`;
      }
    }
    return result || "$";
  }
  return String(path ?? "");
}

function sourceTypeForAeonValue(value) {
  return sourceTypeByValueType.get(value?.valueType ?? value?.type) ?? "StringLiteral";
}

function sourceTypeForEvent(event) {
  const value = event?.value ?? {};
  return sourceTypeForDatatype(event?.datatype)
    ?? sourceTypeByValueType.get(value.valueType ?? value.type ?? event?.valueType ?? event?.type)
    ?? "StringLiteral";
}

function sourceUiValueForAeonValue(value, type) {
  if (type === "StringLiteral" || type === "TrimtickStringLiteral") return value?.value ?? value?.raw ?? "";
  if (type === "SymbolicLiteral") {
    if (value?.value !== undefined) return String(value.value);
    const raw = String(value?.raw ?? sourceDefaultValue(type));
    return raw.startsWith("|") && raw.endsWith("|") ? raw.slice(1, -1) : raw;
  }
  if (type === "BooleanLiteral") return value?.value === false ? "false" : "true";
  if (type === "NullLiteral") {
    const raw = String(value?.raw ?? "");
    const literalValue = String(value?.value ?? raw.replace(/^!/, "") ?? "none");
    if (raw.startsWith('!"') || raw.startsWith("!'")) return `custom:${literalValue}`;
    return reservedNullValues.includes(literalValue) ? literalValue : `custom:${literalValue}`;
  }
  if (type === "NaNLiteral") return String(value?.raw ?? value?.value ?? "NaN");
  if (type === "InfinityLiteral") return String(value?.raw ?? value?.value ?? "Infinity");
  if (type === "NodeLiteral") return value?.tag ?? "node";
  if (type === "HexLiteral") return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^#/, "");
  if (type === "RadixLiteral") return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^%/, "");
  if (type === "EncodingLiteral") return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^&/, "");
  if (type === "SeparatorLiteral") return String(value?.raw ?? value?.value ?? sourceDefaultValue(type)).replace(/^\^/, "");
  if (sourceTypeAllowsChildren(type)) return "";
  return String(value?.raw ?? value?.value ?? sourceDefaultValue(type));
}

function sourceUiValueForEvent(event, type) {
  return sourceUiValueForAeonValue(event?.value ?? event, type);
}

function attributeEntries(attributes) {
  const output = [];
  if (attributes instanceof Map) return Array.from(attributes.entries());
  if (attributes && !Array.isArray(attributes) && typeof attributes === "object") return Object.entries(attributes);
  for (const attribute of attributes ?? []) {
    const entries = attribute?.entries instanceof Map
      ? attribute.entries
      : new Map(Object.entries(attribute?.entries ?? {}));
    for (const entry of entries) output.push(entry);
  }
  return output;
}

function aeonAttributeSource(value) {
  return value?.attributes ?? value?.annotations ?? [];
}

function addSourceAttributeRows(attributes, ownerPath, rows, seen) {
  for (const [key, entry] of attributeEntries(attributes)) {
    const path = joinSourcePath(ownerPath, key, "attribute");
    if (seen.has(path)) continue;
    const type = sourceTypeForDatatype(datatypeName(entry?.datatype)) ?? sourceTypeForAeonValue(entry?.value);
    rows.push({
      path,
      type,
      datatype: datatypeName(entry?.datatype) || "",
      identity: entry?.structuralId ?? entry?.identity,
      value: sourceUiValueForAeonValue(entry?.value, type),
      open: true
    });
    seen.add(path);
    addSourceAttributeRows(aeonAttributeSource(entry), path, rows, seen);
    addSourceAttributeRowsFromValue(entry?.value, path, rows, seen);
  }
}

function addSourceValueRow(value, path, metadata, rows, seen) {
  if (!seen.has(path)) {
    const datatype = datatypeName(metadata?.datatype);
    const type = sourceTypeForDatatype(datatype) ?? sourceTypeForAeonValue(value);
    rows.push({path, type, datatype, identity:metadata?.structuralId,
      value:sourceUiValueForAeonValue(value, type), open:true});
    seen.add(path);
  }
  addSourceAttributeRows(aeonAttributeSource(metadata), path, rows, seen);
  addSourceAttributeRowsFromValue(value, path, rows, seen);
}

function addSourceAttributeRowsFromValue(value, path, rows, seen) {
  addSourceAttributeRows(aeonAttributeSource(value), path, rows, seen);
  if (value?.type === "ObjectNode") {
    for (const binding of value.bindings ?? []) {
      addSourceValueRow(binding.value, joinSourcePath(path, binding.key), binding, rows, seen);
    }
  }
  const elements = value?.type === "NodeLiteral" ? value.children
    : ["ListNode", "TupleNode", "TupleLiteral"].includes(value?.type) ? value.elements : [];
  for (const [index, element] of (elements ?? []).entries()) {
    const typed = element.type === "TypedValue";
    addSourceValueRow(typed ? element.value : element, joinSourcePath(path, index, "index"), typed ? element : null, rows, seen);
  }
}

function sourceRowsFromValue(value, path = "$.value", rows = []) {
  const type = value === null ? "NullLiteral"
    : Array.isArray(value) ? "ListNode"
      : value && typeof value === "object" ? "ObjectNode"
        : typeof value === "boolean" ? "BooleanLiteral"
          : typeof value === "number" ? Number.isInteger(value) ? "IntegerLiteral" : "FloatLiteral"
            : "StringLiteral";
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

function sourceRowsFromRuntimeResult(result) {
  const events = Array.isArray(result?.aes) ? result.aes : Array.isArray(result?.events) ? result.events : [];
  const rows = [];
  const seen = new Set();
  for (const event of events) {
    const path = normalizeSourceRuntimePath(formatEventPath(event.path));
    if (!path || path === "$" || event.sourcePlane === "header" || seen.has(path)) continue;
    const type = sourceTypeForEvent(event);
    rows.push({
      path,
      type,
      datatype: event.datatype ?? "",
      identity: event.structuralId ?? event.identity,
      value: sourceUiValueForEvent(event, type),
      open: true
    });
    seen.add(path);
    addSourceAttributeRows(aeonAttributeSource(event), path, rows, seen);
    addSourceAttributeRowsFromValue(event.value, path, rows, seen);
  }
  if (rows.length > 0) return rows;
  const document = result?.document;
  const root = document && typeof document === "object" && "payload" in document ? document.payload : document;
  if (!root || typeof root !== "object") return sourceRowsFromValue(root ?? "", "$.value");
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
      pending.push({ type: sourceCommentTypeByMarker[standalone[1]] ?? "doc", value: standalone[2] ?? "" });
      continue;
    }
    if (/\/\/[#@?{\[(]/.test(line)) continue;
    const binding = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*|"([^"\\]|\\.)*"|'([^'\\]|\\.)*')\s*(?:@\{[^}]*\}\s*)?(?::[^=]+)?=/);
    if (!binding) continue;
    const indent = binding[1].length;
    while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
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
    if (line.includes("{")) stack.push({ indent, path });
  }
  return commentsByPath;
}

function addStandaloneCommentRows(text, rows) {
  const commentsByPath = parseStandaloneSemanticComments(text);
  const seen = new Set(rows.map((row) => row.path));
  for (const [ownerPath, comments] of commentsByPath) {
    if (!seen.has(ownerPath)) continue;
    let index = 1;
    for (const comment of comments) {
      while (seen.has(joinSourcePath(ownerPath, `#comment${index}`, "comment"))) index += 1;
      const path = joinSourcePath(ownerPath, `#comment${index}`, "comment");
      rows.push({ path, kind: "comment", commentType: comment.type, value: comment.value, open: true });
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
    if (/^\s*aeon\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) output.push(line);
  }
  return output.join("\n").trim();
}

function indexSourceRows(rows) {
  const byPath = new Map();
  const children = new Map();
  const descriptions = new Map();
  for (const row of rows) {
    const description = composerPaths.describe(row.path);
    byPath.set(row.path, row);
    descriptions.set(row.path, description);
    if (!children.has(description.parent)) children.set(description.parent, [[], [], []]);
    const priority = description.kind === "comment" ? 0 : description.kind === "attribute" ? 1 : 2;
    children.get(description.parent)[priority].push(row);
  }
  for (const [path, groups] of children) children.set(path, groups.flat());
  return {byPath, children, descriptions};
}

function orderedSourceRows(rows, index = indexSourceRows(rows)) {
  const roots = rows.filter(row => !index.byPath.has(index.descriptions.get(row.path).parent));
  const stack = roots.slice().reverse();
  const output = [];
  while (stack.length) {
    const row = stack.pop();
    output.push(row);
    const children = index.children.get(row.path) ?? [];
    for (let child = children.length - 1; child >= 0; child -= 1) stack.push(children[child]);
  }
  return output;
}

function visibleSourceRows(rows, index = indexSourceRows(rows)) {
  const visible = new Map();
  return orderedSourceRows(rows, index).filter(row => {
    const parent = index.descriptions.get(row.path).parent;
    const shown = !index.byPath.has(parent) || (visible.get(parent) && index.byPath.get(parent).open !== false);
    visible.set(row.path, shown);
    return shown;
  });
}

function aeonKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}

function trimtickValue(value, depth) {
  const indent = "  ".repeat(depth);
  const contentIndent = "  ".repeat(depth + 1);
  const lines = String(value ?? "").split(/\r?\n/);
  const body = lines.map((line) => `${contentIndent}${line}`).join("\n");
  return `>\`\n${body}\n${indent}\``;
}

function aeonScalarValue(row) {
  const value = String(row.value ?? sourceDefaultValue(row.type));
  if (row.type === "StringLiteral") return JSON.stringify(value);
  if (row.type === "TrimtickStringLiteral") return `>\`\n${value}\n\``;
  if (row.type === "SymbolicLiteral") {
    const payload = value || sourceDefaultValue(row.type);
    return `|${JSON.stringify(payload).slice(1, -1).replaceAll("|", "\\|")}|`;
  }
  if (row.type === "BooleanLiteral") return value === "false" ? "false" : "true";
  if (row.type === "ToggleLiteral") return ["off", "yes", "no"].includes(value) ? value : "on";
  if (row.type === "NullLiteral") {
    if (value.startsWith("custom:")) return `!${JSON.stringify(value.slice("custom:".length))}`;
    if (reservedNullValues.includes(value)) return `!${value}`;
    return value ? `!${JSON.stringify(value)}` : "!none";
  }
  if (row.type === "NaNLiteral") return value === "-NaN" ? "-NaN" : "NaN";
  if (row.type === "InfinityLiteral") return value === "-Infinity" ? "-Infinity" : "Infinity";
  if (row.type === "EncodingLiteral") return value.startsWith("&") ? value : `&${value}`;
  if (row.type === "SeparatorLiteral") return value.startsWith("^") ? value : `^${value || " "}`;
  if (row.type === "HexLiteral") return value.startsWith("#") ? value : `#${value || "00"}`;
  if (row.type === "RadixLiteral") return value.startsWith("%") ? value : `%${value || "0"}`;
  if (row.type === "ObjectNode") return "{}";
  if (row.type === "ListNode") return "[]";
  if (row.type === "TupleNode") return "()";
  if (row.type === "NodeLiteral") return `<${aeonKey(value || "node")}()>`;
  return value || sourceDefaultValue(row.type);
}

function mountAeonSourceComposer(options) {
  const shell = options.shell;
  const source = options.source;
  const modal = shell.querySelector("[data-source-builder-modal]");
  const tree = shell.querySelector("[data-source-builder-tree]");
  const detail = shell.querySelector("[data-source-builder-detail]");
  const closeButtons = shell.querySelectorAll("[data-source-builder-close]");
  const openButton = shell.querySelector("[data-source-builder-open]");
  const reloadButton = shell.querySelector("[data-source-builder-reload]");
  const applyButton = shell.querySelector("[data-source-builder-apply]");
  const addPeerButton = shell.querySelector("[data-source-builder-add-peer]");
  const addChildButton = shell.querySelector("[data-source-builder-add-child]");
  const addAttributeButton = shell.querySelector("[data-source-builder-add-attribute]");
  const addCommentButton = shell.querySelector("[data-source-builder-add-comment]");
  const removeButton = shell.querySelector("[data-source-builder-remove]");
  if (!source || !modal || !tree || !detail) return null;

  const state = { rows: [], selectedPath: null, sourceText: null };
  const runtimeReady = options.runtimeReady ?? import("@aeon/runtime");
  const getMode = options.getMode ?? (() => "transport");
  const runtimeConfig = options.runtimeConfig ?? ((text) => ({
    text,
    options: { mode: "loose", datatypePolicy: "reserved_only", includeAnnotations: true, output: "map" }
  }));
  const onError = options.onError ?? (() => {});
  const onApply = options.onApply ?? (() => {});

  // One index per render/build operation, shared by every recursive formatter.
  let rowIndex = indexSourceRows(state.rows);
  const refreshRowIndex = () => { rowIndex = indexSourceRows(state.rows); };
  const sourceChildren = (path) => rowIndex.children.get(path) ?? [];
  const sourceValueChildren = (path, rows = state.rows) => sourceChildren(path, rows).filter((row) => !sourcePathIsAttribute(row.path) && !sourcePathIsComment(row.path));
  const sourceTypeOptionsForRow = (row, rows) => {
    if (sourceValueChildren(row.path, rows).length === 0) return sourceTypes;
    if (row.type === "ListNode" || row.type === "TupleNode") return ["ListNode", "TupleNode"];
    return [row.type];
  };

  function sourceIdentity(row) {
    return row.identity ? String.fromCharCode(92) + row.identity + String.fromCharCode(92) : "";
  }

  function renderSourceBuilderAttributes(row, rows) {
    const attrs = sourceChildren(row.path, rows).filter((child) => sourcePathIsAttribute(child.path));
    if (attrs.length === 0) return "";
    const values = attrs.map((attr) => {
      const key = sourcePathName(attr.path).replace(/^@/, "");
      const datatype = attr.datatype ? `:${attr.datatype}` : "";
      return `${aeonKey(key)}${sourceIdentity(attr)}${renderSourceBuilderAttributes(attr, rows)}${datatype} = ${renderSourceBuilderValue(attr, rows)}`;
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

  function renderSourceBuilderElement(row, rows, depth) {
    const datatype = row.datatype ? `:${row.datatype}` : "";
    const header = `${sourceIdentity(row)}${renderSourceBuilderAttributes(row, rows)}${datatype}`;
    return `${"  ".repeat(depth)}${header}${header ? " = " : ""}${renderSourceBuilderValue(row, rows, depth)}`;
  }

  function renderSourceBuilderValue(row, rows, depth = 0) {
    const children = sourceValueChildren(row.path, rows);
    if (row.type === "TrimtickStringLiteral") return trimtickValue(row.value, depth);
    if (row.type === "ListNode" || row.type === "TupleNode") {
      const open = row.type === "TupleNode" ? "(" : "[";
      const close = row.type === "TupleNode" ? ")" : "]";
      if (children.length === 0) return `${open}${close}`;
      const values = children.map((child) => renderSourceBuilderElement(child, rows, depth + 1));
      return `${open}\n${values.join(",\n")}\n${"  ".repeat(depth)}${close}`;
    }
    if (row.type === "ObjectNode") {
      if (children.length === 0) return "{}";
      const values = children.map((child) => renderSourceBuilderBinding(child, rows, depth + 1));
      return `{\n${values.join("\n")}\n${"  ".repeat(depth)}}`;
    }
    if (row.type === "NodeLiteral") {
      if (children.length === 0) return aeonScalarValue(row);
      const values = children.map((child) => renderSourceBuilderElement(child, rows, depth + 1));
      return `<${aeonKey(row.value || "node")}(\n${values.join("\n")}\n${"  ".repeat(depth)})>`;
    }
    return aeonScalarValue(row);
  }

  function renderSourceBuilderBinding(row, rows, depth = 0) {
    const name = sourcePathName(row.path);
    const datatype = row.datatype ? `:${row.datatype}` : "";
    const attrs = renderSourceBuilderAttributes(row, rows);
    const comments = renderSourceBuilderComments(row, rows, depth);
    const binding = `${"  ".repeat(depth)}${aeonKey(name)}${sourceIdentity(row)}${attrs}${datatype} = ${renderSourceBuilderValue(row, rows, depth)}`;
    return [comments, binding].filter(Boolean).join("\n");
  }

  function render() {
    refreshRowIndex();
    const rows = state.rows;
    if (!state.selectedPath || !rows.some((row) => row.path === state.selectedPath)) {
      state.selectedPath = rows[0]?.path ?? null;
    }
    tree.innerHTML = visibleSourceRows(rows, rowIndex).map((row) => {
      const selected = row.path === state.selectedPath;
      const hasChildren = sourceValueChildren(row.path, rows).length > 0;
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

    const selected = rows.find((row) => row.path === state.selectedPath);
    if (!selected) {
      if (removeButton) {
        removeButton.disabled = true;
        removeButton.textContent = "Remove binding";
      }
      detail.innerHTML = "<p class=\"source-builder-empty\">No binding selected.</p>";
      return;
    }
    if (selected.kind === "comment") {
      if (addChildButton) addChildButton.disabled = true;
      if (addAttributeButton) addAttributeButton.disabled = true;
      if (addCommentButton) addCommentButton.disabled = true;
      if (removeButton) {
        removeButton.disabled = false;
        removeButton.textContent = "Remove comment";
      }
      detail.innerHTML = `
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
    if (addChildButton) addChildButton.disabled = isAttribute || !sourceTypeAllowsChildren(selected.type);
    if (addAttributeButton) addAttributeButton.disabled = isAttribute;
    if (addCommentButton) addCommentButton.disabled = isAttribute;
    if (removeButton) {
      removeButton.disabled = false;
      removeButton.textContent = "Remove binding";
    }
    detail.innerHTML = `
      <label>
        <span>Key</span>
        <input name="name" type="text" value="${escapeHtml(isAttribute ? sourcePathName(selected.path).slice(1) : sourcePathName(selected.path))}" ${composerPaths.describe(selected.path).kind === "index" ? "disabled" : ""} />
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

  async function parseSource(text, mode) {
    await options.validateSource?.(text);
    const {runRuntime} = await runtimeReady;
    const config = runtimeConfig(text, mode, false);
    let result = runRuntime(config.text, config.options);
    if (mode !== "transport" && (result.meta?.errors?.length ?? 0) > 0) {
      // Keep the existing strict/custom repair flow, but only when the actual
      // relaxed parser accepts the complete source without recovery errors.
      const relaxed = runtimeConfig(text, mode, true);
      result = runRuntime(relaxed.text, relaxed.options);
    }
    // Semantic errors can be repaired in the relaxed editor. Parser recovery is
    // never an editable AST: it may omit unfinished authored bindings.
    if ((result.meta?.errors ?? []).some(diag => !Number.isInteger(diag.phase) || diag.phase <= 5)) {
      throw new Error("Fix the source syntax before using AEON Composer. The source text has been kept unchanged.");
    }
    return result;
  }

  async function seedRows() {
    const text = source.value;
    const mode = getMode();
    const result = await parseSource(text, mode);
    const rows = sourceRowsFromRuntimeResult(result);
    if (source.value !== text) throw new Error("Source changed; reload AEON Composer before applying edits.");
    state.sourceText = text;
    state.rows = rows;
    addStandaloneCommentRows(text, state.rows);
    if (mode !== "transport") {
      for (const row of state.rows) {
        if (row.kind !== "comment" && !row.datatype) row.datatype = datatypeForSourceType(row.type);
      }
    }
    state.selectedPath = state.rows[0]?.path ?? null;
    refreshRowIndex();
  }

  async function open(trigger = openButton) {
    await seedRows();
    render();
    window.AeonAccessibility?.openModal(modal, trigger);
  }

  function close() {
    window.AeonAccessibility?.closeModal(modal);
  }

  function syncDetail() {
    if (!state.selectedPath) return;
    const row = state.rows.find((candidate) => candidate.path === state.selectedPath);
    if (!row) return;
    const data = new FormData(detail);
    if (row.kind === "comment") {
      row.commentType = String(data.get("commentType") || "doc");
      row.value = String(data.get("value") ?? "");
      return;
    }
    const previousPath = row.path;
    const previousType = row.type;
    const previousDatatype = row.datatype;
    const type = String(data.get("type") || row.type);
    const pathInfo = composerPaths.describe(row.path);
    const name = String(data.get("name") ?? (pathInfo.kind === "attribute" ? pathInfo.name.slice(1) : pathInfo.name));
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
      row.value = previousType === type ? String(data.get("value") ?? sourceDefaultValue(type)) : sourceDefaultValue(type);
    }
    const children = sourceValueChildren(row.path);
    const allowedTypes = previousType === "ListNode" || previousType === "TupleNode" ? ["ListNode", "TupleNode"] : [previousType];
    if (children.length > 0 && !allowedTypes.includes(type)) {
      row.type = previousType;
      row.datatype = datatypeForSourceType(row.type);
    }
    if (pathInfo.kind !== "index") {
      const nextPath = joinSourcePath(parent, name, isAttribute ? "attribute" : "member");
      if (nextPath !== previousPath && !state.rows.some((candidate) => candidate.path === nextPath)) {
        for (const candidate of state.rows) {
          if (candidate.path === previousPath || sourcePathIsDescendant(candidate.path, previousPath)) {
            candidate.path = `${nextPath}${candidate.path.slice(previousPath.length)}`;
          }
        }
        state.selectedPath = nextPath;
        refreshRowIndex();
      }
    }
  }

  function addRow(kind) {
    syncDetail();
    const rows = state.rows;
    const selected = rows.find((row) => row.path === state.selectedPath) ?? rows[0];
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
    while (attrNames.has(`@attr${attrIndex}`)) attrIndex += 1;
    let commentIndex = commentNames.size + 1;
    while (commentNames.has(`//${commentIndex}`)) commentIndex += 1;
    const name = kind === "comment"
      ? `#comment${commentIndex}`
      : kind === "attribute"
        ? `@attr${attrIndex}`
        : parent?.type === "ListNode" || parent?.type === "TupleNode" || parent?.type === "NodeLiteral" ? `[${childIndex}]` : `field${childIndex + 1}`;
    const pathKind = kind === "attribute" || kind === "comment" ? kind
      : ["ListNode", "TupleNode", "NodeLiteral"].includes(parent?.type) ? "index" : "member";
    const pathName = pathKind === "attribute" ? name.slice(1) : pathKind === "index" ? childIndex : name;
    const path = joinSourcePath(base, pathName, pathKind);
    rows.push({
      path,
      ...(kind === "comment" ? { kind: "comment", commentType: "doc" } : {}),
      type: "StringLiteral",
      datatype: getMode() === "transport" || kind === "comment" ? "" : "string",
      value: kind === "comment" ? "Comment" : "",
      open: true
    });
    if (parent) parent.open = true;
    state.selectedPath = path;
    render();
  }

  function removeRow() {
    const path = state.selectedPath;
    if (!path) return;
    const visibleBeforeRemove = visibleSourceRows(state.rows);
    const removedIndex = visibleBeforeRemove.findIndex((row) => row.path === path);
    const nextSelectedPath = removedIndex > 0
      ? visibleBeforeRemove[removedIndex - 1]?.path
      : visibleBeforeRemove.find((row, index) => index > removedIndex && !sourcePathIsDescendant(row.path, path))?.path;
    state.rows = state.rows.filter((row) => row.path !== path && !sourcePathIsDescendant(row.path, path));
    state.selectedPath = nextSelectedPath && state.rows.some((row) => row.path === nextSelectedPath)
      ? nextSelectedPath
      : state.rows[0]?.path ?? null;
    render();
  }

  function buildSource() {
    syncDetail();
    refreshRowIndex();
    const rows = orderedSourceRows(state.rows, rowIndex);
    const header = preservedHeaderSource(source.value);
    const body = rows
      .filter((row) => !sourceParentPath(row.path) && !sourcePathIsAttribute(row.path) && !sourcePathIsComment(row.path))
      .map((row) => renderSourceBuilderBinding(row, rows))
      .join("\n");
    return [header, body].filter(Boolean).join("\n");
  }

  openButton?.addEventListener("click", () => open().catch((error) => onError(error)));
  reloadButton?.addEventListener("click", () => seedRows().then(render).catch((error) => onError(error)));
  applyButton?.addEventListener("click", async () => {
    try {
      const text = source.value;
      const mode = getMode();
      await parseSource(text, mode);
      if (text !== state.sourceText || source.value !== text) {
        throw new Error("Source changed; reload AEON Composer before applying edits. The source text has been kept unchanged.");
      }
      const candidate = buildSource();
      await parseSource(candidate, mode);
      if (source.value !== text) throw new Error("Source changed; reload AEON Composer before applying edits.");
      source.value = candidate;
      source.dispatchEvent(new Event("input", { bubbles: true }));
      close();
      onApply(source.value);
    } catch (error) { onError(error); }
  });
  addPeerButton?.addEventListener("click", () => addRow("peer"));
  addChildButton?.addEventListener("click", () => addRow("child"));
  addAttributeButton?.addEventListener("click", () => addRow("attribute"));
  addCommentButton?.addEventListener("click", () => addRow("comment"));
  removeButton?.addEventListener("click", removeRow);
  closeButtons.forEach((button) => button.addEventListener("click", close));

  tree.addEventListener("click", (event) => {
    const item = event.target.closest("[data-source-builder-path]");
    if (!item) return;
    syncDetail();
    const path = item.dataset.sourceBuilderPath;
    state.selectedPath = path;
    if (event.target.closest(".source-builder-twist")) {
      const row = state.rows.find((candidate) => candidate.path === path);
      if (row && sourceValueChildren(row.path).length > 0) row.open = row.open === false;
    }
    render();
  });

  detail.addEventListener("input", (event) => {
    if (event.target?.name === "type") return;
    syncDetail();
    if (event.target?.name === "commentType" || state.rows.find((row) => row.path === state.selectedPath)?.kind === "comment") {
      render();
      detail.querySelector(`[name="${event.target?.name}"]`)?.focus();
    }
  });
  detail.addEventListener("change", (event) => {
    if (event.target?.name === "commentType") {
      syncDetail();
      render();
      detail.querySelector('[name="commentType"]')?.focus();
      return;
    }
    if (event.target?.name === "nullMode") {
      syncDetail();
      render();
      detail.querySelector('[name="nullMode"]')?.focus();
      return;
    }
    if (event.target?.name === "type") {
      syncDetail();
      render();
    }
  });

  const keydown = (event) => {
    if (event.key === "Escape" && !modal.hidden) close();
  };
  document.addEventListener("keydown", keydown);

  return { open, close, destroy: () => document.removeEventListener("keydown", keydown) };
}

window.AeonSourceComposer = { mount: mountAeonSourceComposer };
