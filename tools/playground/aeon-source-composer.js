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
  if (["radix", "decimal", "radix2", "radix6", "radix8", "radix12"].includes(base)) return "RadixLiteral";
  if (["encoding", "base64", "embed", "inline"].includes(base)) return "EncodingLiteral";
  if (base === "date") return "DateLiteral";
  if (base === "time") return "TimeLiteral";
  if (base === "datetime") return "DateTimeLiteral";
  if (base === "wtc") return "WTCDateTimeLiteral";
  if (base === "sep" || base === "kadot" || base === "separator") return "SeparatorLiteral";
  if (base === "tuple" || base === "triple") return "TupleLiteral";
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

function pathSegments(path) {
  const segments = [];
  const tokenRe = /\.([A-Za-z_][A-Za-z0-9_]*)|\["((?:\\.|[^"\\])*)"\]|\[(\d+)\]/g;
  for (const match of String(path ?? "").matchAll(tokenRe)) {
    if (match[1] !== undefined) {
      segments.push(match[1]);
    } else if (match[2] !== undefined) {
      segments.push(parseQuotedPathKey(match[2]));
    } else if (match[3] !== undefined) {
      segments.push(Number.parseInt(match[3], 10));
    }
  }
  return segments;
}

function sourceParentPath(path) {
  const commentIndex = String(path).lastIndexOf("#comment");
  if (commentIndex > -1) return path.slice(0, commentIndex);
  const quotedSansaAttrMatch = String(path).match(/\.@\.\["((?:\\.|[^"\\])*)"\]$/);
  if (quotedSansaAttrMatch) return path.slice(0, quotedSansaAttrMatch.index);
  const plainSansaAttrMatch = String(path).match(/\.@\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (plainSansaAttrMatch) return path.slice(0, plainSansaAttrMatch.index);
  const indexMatch = String(path).match(/\[(\d+)\]$/);
  if (indexMatch) return path.slice(0, indexMatch.index);
  const quotedMemberMatch = String(path).match(/\.\["((?:\\.|[^"\\])*)"\]$/);
  if (quotedMemberMatch) return quotedMemberMatch.index > 1 ? path.slice(0, quotedMemberMatch.index) : "";
  const plainMemberMatch = String(path).match(/\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (plainMemberMatch && plainMemberMatch.index > 0) return plainMemberMatch.index > 1 ? path.slice(0, plainMemberMatch.index) : "";
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
  if (commentMatch) return `//${commentMatch[1]}`;
  const quotedSansaAttrMatch = String(path).match(/\.@\.\["((?:\\.|[^"\\])*)"\]$/);
  if (quotedSansaAttrMatch) return `@${parseQuotedPathKey(quotedSansaAttrMatch[1])}`;
  const sansaAttrMatch = String(path).match(/\.@\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (sansaAttrMatch) return `@${sansaAttrMatch[1]}`;
  const indexMatch = String(path).match(/\[(\d+)\]$/);
  if (indexMatch) return `[${indexMatch[1]}]`;
  const segments = pathSegments(path);
  const last = segments.at(-1);
  if (typeof last === "string") return last;
  if (typeof last === "number") return `[${last}]`;
  return String(path).replace(/^\$\.?/, "");
}

function joinSourcePath(parent, name) {
  if (!parent) return `$${formatSourceMemberPath(name)}`;
  if (/^\[\d+\]$/.test(name)) return `${parent}${name}`;
  if (name.startsWith("@")) return `${parent}${formatSourceAttributePath(name.replace(/^@/, ""))}`;
  if (name.startsWith("#comment")) return `${parent}${name}`;
  return `${parent}${formatSourceMemberPath(name)}`;
}

function sourceDepth(path) {
  return pathSegments(path).length + (sourcePathIsAttribute(path) || sourcePathIsComment(path) ? 1 : 0);
}

function datatypeName(datatype) {
  if (typeof datatype === "string") return datatype;
  return datatype?.name ?? "";
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
    const path = joinSourcePath(ownerPath, `@${key}`);
    if (seen.has(path)) continue;
    const type = sourceTypeForDatatype(entry?.datatype) ?? sourceTypeForAeonValue(entry?.value);
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
    if (!path || path === "$" || path.includes("[*]") || path.startsWith('$.["aeon:') || seen.has(path)) continue;
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
    if (!rows.some((row) => row.path === ownerPath)) continue;
    let index = 1;
    for (const comment of comments) {
      while (seen.has(joinSourcePath(ownerPath, `#comment${index}`))) index += 1;
      const path = joinSourcePath(ownerPath, `#comment${index}`);
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

function orderedSourceRows(rows) {
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const orderedChildren = (parentPath) => rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => sourceParentPath(row.path) === parentPath)
    .sort((left, right) => {
      const leftComment = sourcePathIsComment(left.row.path);
      const rightComment = sourcePathIsComment(right.row.path);
      if (leftComment !== rightComment) return leftComment ? -1 : 1;
      const leftAttr = sourcePathIsAttribute(left.row.path);
      const rightAttr = sourcePathIsAttribute(right.row.path);
      if (leftAttr !== rightAttr) return leftAttr ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ row }) => row);
  const output = [];
  const visit = (row) => {
    output.push(row);
    orderedChildren(row.path).forEach(visit);
  };
  rows.filter((row) => !byPath.has(sourceParentPath(row.path))).forEach(visit);
  return output;
}

function visibleSourceRows(rows) {
  return orderedSourceRows(rows).filter((row) => {
    let parent = sourceParentPath(row.path);
    while (parent) {
      const parentRow = rows.find((candidate) => candidate.path === parent);
      if (parentRow && parentRow.open === false) return false;
      parent = sourceParentPath(parent);
    }
    return true;
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

  const state = { rows: [], selectedPath: null };
  const runtimeReady = options.runtimeReady ?? import("@aeon/runtime");
  const getMode = options.getMode ?? (() => "transport");
  const runtimeConfig = options.runtimeConfig ?? ((text) => ({
    text,
    options: { mode: "loose", datatypePolicy: "reserved_only", includeAnnotations: true, output: "map" }
  }));
  const onError = options.onError ?? (() => {});
  const onApply = options.onApply ?? (() => {});

  const sourceChildren = (path, rows = state.rows) => rows.filter((row) => sourceParentPath(row.path) === path);
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
      return `${aeonKey(key)}${sourceIdentity(attr)}${datatype} = ${renderSourceBuilderValue(attr, rows)}`;
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

  function renderSourceBuilderValue(row, rows, depth = 0) {
    const children = sourceValueChildren(row.path, rows);
    if (row.type === "TrimtickStringLiteral") return trimtickValue(row.value, depth);
    if (row.type === "ListNode" || row.type === "TupleNode") {
      const open = row.type === "TupleNode" ? "(" : "[";
      const close = row.type === "TupleNode" ? ")" : "]";
      if (children.length === 0) return `${open}${close}`;
      const values = children.map((child) => `${"  ".repeat(depth + 1)}${sourceIdentity(child)}${child.identity ? " = " : ""}${renderSourceBuilderValue(child, rows, depth + 1)}`);
      return `${open}\n${values.join(",\n")}\n${"  ".repeat(depth)}${close}`;
    }
    if (row.type === "ObjectNode") {
      if (children.length === 0) return "{}";
      const values = children.map((child) => renderSourceBuilderBinding(child, rows, depth + 1));
      return `{\n${values.join("\n")}\n${"  ".repeat(depth)}}`;
    }
    if (row.type === "NodeLiteral") {
      if (children.length === 0) return aeonScalarValue(row);
      const values = children.map((child) => `${"  ".repeat(depth + 1)}${sourceIdentity(child)}${child.identity ? " = " : ""}${renderSourceBuilderValue(child, rows, depth + 1)}`);
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
    const rows = state.rows;
    if (!state.selectedPath || !rows.some((row) => row.path === state.selectedPath)) {
      state.selectedPath = rows[0]?.path ?? null;
    }
    tree.innerHTML = visibleSourceRows(rows).map((row) => {
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

  async function seedRows() {
    await options.validateSource?.(source.value);
    const runtime = await runtimeReady;
    const runRuntime = runtime.runRuntime;
    const mode = getMode();
    const normal = runtimeConfig(source.value, mode, false);
    let result = runRuntime(normal.text, normal.options);
    let rows = sourceRowsFromRuntimeResult(result);
    if (mode !== "transport" && (result.meta?.errors?.length ?? 0) > 0) {
      const relaxed = runtimeConfig(source.value, mode, true);
      const relaxedResult = runRuntime(relaxed.text, relaxed.options);
      const relaxedRows = sourceRowsFromRuntimeResult(relaxedResult);
      if (relaxedRows.length > 0) {
        result = relaxedResult;
        rows = relaxedRows;
      }
    }
    state.rows = rows;
    addStandaloneCommentRows(source.value, state.rows);
    if (mode !== "transport") {
      for (const row of state.rows) {
        if (row.kind !== "comment" && !row.datatype) row.datatype = datatypeForSourceType(row.type);
      }
    }
    state.selectedPath = state.rows[0]?.path ?? null;
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
      row.value = previousType === type ? String(data.get("value") ?? sourceDefaultValue(type)) : sourceDefaultValue(type);
    }
    const children = sourceValueChildren(row.path);
    const allowedTypes = previousType === "ListNode" || previousType === "TupleNode" ? ["ListNode", "TupleNode"] : [previousType];
    if (children.length > 0 && !allowedTypes.includes(type)) {
      row.type = previousType;
      row.datatype = datatypeForSourceType(row.type);
    }
    if (name && (!/^\[\d+\]$/.test(sourcePathName(row.path)) || isAttribute)) {
      const nextPath = joinSourcePath(parent, isAttribute ? `@${name.replace(/^@/, "")}` : name);
      if (nextPath !== previousPath && !state.rows.some((candidate) => candidate.path === nextPath)) {
        for (const candidate of state.rows) {
          if (candidate.path === previousPath || sourcePathIsDescendant(candidate.path, previousPath)) {
            candidate.path = `${nextPath}${candidate.path.slice(previousPath.length)}`;
          }
        }
        state.selectedPath = nextPath;
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
    const path = joinSourcePath(base, name);
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
    const rows = orderedSourceRows(state.rows);
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
      await options.validateSource?.(source.value);
      source.value = buildSource();
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
