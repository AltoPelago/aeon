/**
 * AEON 52-Cards Feature Model
 *
 * Each feature is a fragment generator that produces a snippet of valid
 * (or intentionally invalid) AEON text. Features are composable: the
 * generation engine combines them into complete documents.
 *
 * Derived from specs/04-official/v1/.
 */

// ── Helpers ──────────────────────────────────────────────────────────

let _keyCounter = 0;

export function resetKeyCounter() {
  _keyCounter = 0;
}

function uniqueKey(prefix = 'k') {
  return `${prefix}${_keyCounter++}`;
}

function wrap(fragment, datatype, key) {
  const k = key ?? uniqueKey();
  const dt = datatype ? `:${datatype}` : '';
  return `${k}${dt} = ${fragment}`;
}

// ── Feature definition ───────────────────────────────────────────────

/**
 * @typedef {Object} FeatureFragment
 * @property {string}  text        — raw AEON text (binding or value fragment)
 * @property {boolean} expectPass  — true if the fragment should compile without errors
 * @property {boolean} isBinding   — true if the fragment is a full key = value binding
 * @property {Object}  metadata    — feature metadata for reporting
 */

/**
 * @typedef {Object} Feature
 * @property {string}   id
 * @property {string}   category
 * @property {string}   priority   — 'high' | 'medium' | 'low'
 * @property {string[]} contexts   — allowed contexts: 'top', 'object', 'list', 'tuple', 'node'
 * @property {function(Object): FeatureFragment} generate
 */

// ── Value features ───────────────────────────────────────────────────

const valueFeatures = [
  {
    id: 'string-double',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('str');
      return { text: `${k}:string = "hello world"`, expectPass: true, isBinding: true, metadata: { valueType: 'StringLiteral' } };
    },
  },
  {
    id: 'string-single',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('str');
      return { text: `${k}:string = 'single quoted'`, expectPass: true, isBinding: true, metadata: { valueType: 'StringLiteral' } };
    },
  },
  {
    id: 'string-backtick',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('str');
      return { text: `${k}:string = \`multi\nline\``, expectPass: true, isBinding: true, metadata: { valueType: 'StringLiteral' } };
    },
  },
  {
    id: 'string-escape-sequences',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('esc');
      return { text: `${k}:string = "tab\\there\\nnewline\\u0041"`, expectPass: true, isBinding: true, metadata: { valueType: 'StringLiteral' } };
    },
  },
  {
    id: 'number-integer',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = 42`, expectPass: true, isBinding: true, metadata: { valueType: 'NumberLiteral' } };
    },
  },
  {
    id: 'number-float',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = 3.14`, expectPass: true, isBinding: true, metadata: { valueType: 'NumberLiteral' } };
    },
  },
  {
    id: 'number-scientific',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = 1.5e3`, expectPass: true, isBinding: true, metadata: { valueType: 'NumberLiteral' } };
    },
  },
  {
    id: 'number-underscore',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = 1_000_000`, expectPass: true, isBinding: true, metadata: { valueType: 'NumberLiteral' } };
    },
  },
  {
    id: 'boolean-true',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object', 'list', 'tuple', 'node'],
    generate() {
      const k = uniqueKey('bool');
      return { text: `${k}:boolean = true`, expectPass: true, isBinding: true, metadata: { valueType: 'BooleanLiteral' } };
    },
  },
  {
    id: 'boolean-false',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('bool');
      return { text: `${k}:boolean = false`, expectPass: true, isBinding: true, metadata: { valueType: 'BooleanLiteral' } };
    },
  },
  {
    id: 'switch-on',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('sw');
      return { text: `${k}:switch = on`, expectPass: true, isBinding: true, metadata: { valueType: 'SwitchLiteral' } };
    },
  },
  {
    id: 'switch-off',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('sw');
      return { text: `${k}:switch = off`, expectPass: true, isBinding: true, metadata: { valueType: 'SwitchLiteral' } };
    },
  },
  {
    id: 'hex-literal',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('hex');
      return { text: `${k}:hex = #ff00aa`, expectPass: true, isBinding: true, metadata: { valueType: 'HexLiteral' } };
    },
  },
  {
    id: 'radix-literal',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('rdx');
      return { text: `${k}:radix2 = %1011`, expectPass: true, isBinding: true, metadata: { valueType: 'RadixLiteral' } };
    },
  },
  {
    id: 'encoding-literal',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('enc');
      return { text: `${k}:base64 = $QmFzZTY0IQ==`, expectPass: true, isBinding: true, metadata: { valueType: 'EncodingLiteral' } };
    },
  },
  {
    id: 'date-literal',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('dt');
      return { text: `${k}:date = 2025-01-15`, expectPass: true, isBinding: true, metadata: { valueType: 'DateLiteral' } };
    },
  },
  {
    id: 'datetime-literal',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('ts');
      return { text: `${k}:datetime = 2025-01-15T09:30:00Z`, expectPass: true, isBinding: true, metadata: { valueType: 'DateTimeLiteral' } };
    },
  },
  {
    id: 'zrut-literal',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('zr');
      return { text: `${k}:zrut = 2025-01-15T09:30:00Z&Australia/Sydney`, expectPass: true, isBinding: true, metadata: { valueType: 'DateTimeLiteral' } };
    },
  },
  {
    id: 'zrut-local-literal',
    category: 'values',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('zr');
      return { text: `${k}:zrut = 2025-01-15T09:30:00&Local`, expectPass: true, isBinding: true, metadata: { valueType: 'DateTimeLiteral', local: true } };
    },
  },
  {
    id: 'separator-literal',
    category: 'values',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('sep');
      return {
        text: `${k}:dim[x] = ^300x250`,
        expectPass: false,
        isBinding: true,
        metadata: { valueType: 'SeparatorLiteral', negative: true, reason: 'custom-separator-type-not-allowed' },
      };
    },
  },
];

// ── Container features ───────────────────────────────────────────────

const containerFeatures = [
  {
    id: 'object-simple',
    category: 'containers',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('obj');
      return {
        text: `${k}:object = {\n  name:string = "inner"\n  count:number = 1\n}`,
        expectPass: true,
        isBinding: true,
        metadata: { containerType: 'ObjectNode' },
      };
    },
  },
  {
    id: 'object-empty',
    category: 'containers',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('obj');
      return { text: `${k}:object = {}`, expectPass: true, isBinding: true, metadata: { containerType: 'ObjectNode' } };
    },
  },
  {
    id: 'list-inline',
    category: 'containers',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('lst');
      return { text: `${k}:list = [1, 2, 3]`, expectPass: true, isBinding: true, metadata: { containerType: 'ListNode' } };
    },
  },
  {
    id: 'list-multiline',
    category: 'containers',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('lst');
      return {
        text: `${k}:list = [\n  "a"\n  "b"\n  "c"\n]`,
        expectPass: true,
        isBinding: true,
        metadata: { containerType: 'ListNode' },
      };
    },
  },
  {
    id: 'list-empty',
    category: 'containers',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('lst');
      return { text: `${k}:list = []`, expectPass: true, isBinding: true, metadata: { containerType: 'ListNode' } };
    },
  },
  {
    id: 'tuple-inline',
    category: 'containers',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('tpl');
      return { text: `${k}:tuple = (10, 20)`, expectPass: true, isBinding: true, metadata: { containerType: 'TupleLiteral' } };
    },
  },
  {
    id: 'tuple-multiline',
    category: 'containers',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('tpl');
      return {
        text: `${k}:tuple = (\n  1\n  2\n  3\n)`,
        expectPass: true,
        isBinding: true,
        metadata: { containerType: 'TupleLiteral' },
      };
    },
  },
  {
    id: 'node-simple',
    category: 'containers',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('nd');
      return { text: `${k}:node = <div("hello")>`, expectPass: true, isBinding: true, metadata: { containerType: 'NodeLiteral' } };
    },
  },
  {
    id: 'node-nested',
    category: 'containers',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('nd');
      return {
        text: `${k}:node = <div(<span("hello", <br()>, "world")>)>`,
        expectPass: true,
        isBinding: true,
        metadata: { containerType: 'NodeLiteral' },
      };
    },
  },
  {
    id: 'node-with-attrs',
    category: 'containers',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('nd');
      return {
        text: `${k}:node = <span@{id="text", class="dark"}:node("hello")`,
        expectPass: true,
        isBinding: true,
        metadata: { containerType: 'NodeLiteral' },
      };
    },
  },
];

// ── Key features ─────────────────────────────────────────────────────

const keyFeatures = [
  {
    id: 'key-bare',
    category: 'keys',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('bare');
      return { text: `${k}:number = 1`, expectPass: true, isBinding: true, metadata: { keyForm: 'bare' } };
    },
  },
  {
    id: 'key-single-quoted',
    category: 'keys',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = `'quoted key ${_keyCounter++}'`;
      return { text: `${k}:string = "value"`, expectPass: true, isBinding: true, metadata: { keyForm: 'single-quoted' } };
    },
  },
  {
    id: 'key-double-quoted',
    category: 'keys',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = `"quoted.key.${_keyCounter++}"`;
      return { text: `${k}:string = "value"`, expectPass: true, isBinding: true, metadata: { keyForm: 'double-quoted' } };
    },
  },
  {
    id: 'key-backtick-invalid',
    category: 'keys',
    priority: 'high',
    contexts: ['top'],
    generate() {
      return { text: '`backtick_key`:string = "invalid"', expectPass: false, isBinding: true, metadata: { keyForm: 'backtick', negative: true } };
    },
  },
  {
    id: 'key-invalid-escape',
    category: 'keys',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      return { text: '"bad\\q":string = "invalid"', expectPass: false, isBinding: true, metadata: { keyForm: 'double-quoted', negative: true, reason: 'invalid-escape' } };
    },
  },
];

// ── Attribute features ───────────────────────────────────────────────

const attributeFeatures = [
  {
    id: 'attr-single',
    category: 'attributes',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}@{role:string="admin"}:boolean = true`, expectPass: true, isBinding: true, metadata: { attrCount: 1 } };
    },
  },
  {
    id: 'attr-multi-comma',
    category: 'attributes',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}@{id:string="a1", class:string="dark"}:number = 42`, expectPass: true, isBinding: true, metadata: { attrCount: 2, separator: 'comma' } };
    },
  },
  {
    id: 'attr-multi-newline',
    category: 'attributes',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('at');
      return {
        text: `${k}@{\n  id:string = "a2"\n  class:string = "light"\n}:number = 99`,
        expectPass: true,
        isBinding: true,
        metadata: { attrCount: 2, separator: 'newline' },
      };
    },
  },
  {
    id: 'attr-empty',
    category: 'attributes',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}@{}:string = "empty attrs"`, expectPass: true, isBinding: true, metadata: { attrCount: 0 } };
    },
  },
  {
    id: 'attr-trailing-comma',
    category: 'attributes',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}@{x:number=1,}:boolean = true`, expectPass: true, isBinding: true, metadata: { attrCount: 1, trailing: true } };
    },
  },
  {
    id: 'attr-reversed-order-invalid',
    category: 'attributes',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}:boolean@{id:string="a3"} = true`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'reversed-order' } };
    },
  },
  {
    id: 'attr-on-container',
    category: 'attributes',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}@{meta:string="list-meta"}:list = [1, 2]`, expectPass: true, isBinding: true, metadata: { attrCount: 1, containerValue: true } };
    },
  },
  {
    id: 'attr-postfix-literal-invalid',
    category: 'attributes',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('at');
      return { text: `${k}:list = [0]@{b=2}`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'postfix-literal-attr' } };
    },
  },
];

// ── Type annotation features ─────────────────────────────────────────

const typeAnnotationFeatures = [
  {
    id: 'type-reserved',
    category: 'types',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:string = "typed"`, expectPass: true, isBinding: true, metadata: { typeKind: 'reserved' } };
    },
  },
  {
    id: 'type-custom',
    category: 'types',
    priority: 'high',
    contexts: ['top', 'object'],
    needsCustomDatatypes: true,
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:myCustom = true`, expectPass: true, isBinding: true, metadata: { typeKind: 'custom', needsCustomDatatypes: true } };
    },
  },
  {
    id: 'type-generic-args',
    category: 'types',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:list<number> = [1, 2, 3]`, expectPass: true, isBinding: true, metadata: { typeKind: 'generic' } };
    },
  },
  {
    id: 'type-separator-spec',
    category: 'types',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('tp');
      return {
        text: `${k}:dim[x] = ^100x200`,
        expectPass: false,
        isBinding: true,
        metadata: { typeKind: 'separator-spec', negative: true, reason: 'custom-separator-type-not-allowed' },
      };
    },
  },
  {
    id: 'type-multi-separator-spec',
    category: 'types',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('tp');
      return {
        text: `${k}:dim[x][y] = ^100x200y300`,
        expectPass: false,
        isBinding: true,
        metadata: { typeKind: 'multi-separator-spec', depth: 2, negative: true, reason: 'custom-separator-type-not-allowed' },
      };
    },
  },
  {
    id: 'type-switch-custom-invalid',
    category: 'types',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:mySwitch = yes`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'switch-custom-type' } };
    },
  },
  {
    id: 'type-transport-mismatch-invalid',
    category: 'types',
    priority: 'high',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:switch = true`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'transport-explicit-datatype-mismatch' } };
    },
  },
  {
    id: 'type-separator-char-comma-invalid',
    category: 'types',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:dim[,] = ^1,2`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'invalid-separator-char-comma' } };
    },
  },
  {
    id: 'type-separator-char-semicolon-invalid',
    category: 'types',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:dim[;] = ^1;2`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'invalid-separator-char-semicolon' } };
    },
  },
  {
    id: 'type-separator-char-lbracket-invalid',
    category: 'types',
    priority: 'low',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:dim[[] = ^1[2`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'invalid-separator-char-lbracket' } };
    },
  },
  {
    id: 'type-separator-char-rbracket-invalid',
    category: 'types',
    priority: 'low',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('tp');
      return { text: `${k}:dim[]] = ^1]2`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'invalid-separator-char-rbracket' } };
    },
  },
];

// ── Reference features ───────────────────────────────────────────────

const referenceFeatures = [
  {
    id: 'ref-clone-simple',
    category: 'references',
    priority: 'high',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const srcKey = uniqueKey('rsrc');
      const refKey = uniqueKey('ref');
      return {
        text: `${srcKey} = 42\n${refKey} = ~${srcKey}`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', target: srcKey },
      };
    },
  },
  {
    id: 'ref-pointer',
    category: 'references',
    priority: 'high',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const srcKey = uniqueKey('rsrc');
      const refKey = uniqueKey('ref');
      return {
        text: `${srcKey} = 42\n${refKey} = ~>${srcKey}`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'pointer', target: srcKey },
      };
    },
  },
  {
    id: 'ref-dotted-path',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const objKey = uniqueKey('robj');
      const refKey = uniqueKey('ref');
      return {
        text: `${objKey} = {\n  inner = 99\n}\n${refKey} = ~${objKey}.inner`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', dottedPath: true },
      };
    },
  },
  {
    id: 'ref-indexed-path',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const lstKey = uniqueKey('rlst');
      const refKey = uniqueKey('ref');
      return {
        text: `${lstKey} = [10, 20, 30]\n${refKey} = ~${lstKey}[1]`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', indexedPath: true },
      };
    },
  },
  {
    id: 'ref-quoted-segment',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const refKey = uniqueKey('ref');
      return {
        text: `"a.b" = 5\n${refKey} = ~["a.b"]`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', quotedSegment: true },
      };
    },
  },
  {
    id: 'ref-root-qualified',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const srcKey = uniqueKey('rsrc');
      const refKey = uniqueKey('ref');
      return {
        text: `${srcKey} = 42\n${refKey} = ~$.${srcKey}`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', rootQualified: true },
      };
    },
  },
  {
    id: 'ref-mixed-quoted-path',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const objKey = uniqueKey('robj');
      const refKey = uniqueKey('ref');
      return {
        text: `${objKey} = {\n  "b.c" = 99\n}\n${refKey} = ~${objKey}.["b.c"]`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', mixedQuotedPath: true },
      };
    },
  },
  {
    id: 'ref-attr-selector',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const srcKey = uniqueKey('rsrc');
      const refKey = uniqueKey('ref');
      return {
        text: `${srcKey}@{meta="val"} = 1\n${refKey} = ~${srcKey}@meta`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', attrSelector: true },
      };
    },
  },
  {
    id: 'ref-quoted-attr-selector',
    category: 'references',
    priority: 'medium',
    contexts: ['top'],
    needsTransport: true,
    generate() {
      const srcKey = uniqueKey('rsrc');
      const refKey = uniqueKey('ref');
      return {
        text: `${srcKey}@{"x.y" = 1} = 2\n${refKey} = ~${srcKey}@["x.y"]`,
        expectPass: true,
        isBinding: true,
        metadata: { refType: 'clone', quotedAttrSelector: true },
      };
    },
  },
  {
    id: 'ref-forward-invalid',
    category: 'references',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const futureKey = uniqueKey('future');
      const refKey = uniqueKey('ref');
      return {
        text: `${refKey}:number = ~${futureKey}\n${futureKey}:number = 1`,
        expectPass: false,
        isBinding: true,
        metadata: { negative: true, reason: 'forward-reference' },
      };
    },
  },
  {
    id: 'ref-self-invalid',
    category: 'references',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('self');
      return {
        text: `${k}:number = ~${k}`,
        expectPass: false,
        isBinding: true,
        metadata: { negative: true, reason: 'self-reference' },
      };
    },
  },
  {
    id: 'ref-missing-invalid',
    category: 'references',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('ref');
      return {
        text: `${k}:number = ~nonexistent`,
        expectPass: false,
        isBinding: true,
        metadata: { negative: true, reason: 'missing-target' },
      };
    },
  },
];

// ── Comment / annotation features ────────────────────────────────────

const commentFeatures = [
  {
    id: 'comment-plain-line',
    category: 'comments',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `// plain line comment\n${k}:number = 1`, expectPass: true, isBinding: true, metadata: { commentType: 'plain-line' } };
    },
  },
  {
    id: 'comment-plain-block',
    category: 'comments',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/* plain block comment */\n${k}:number = 2`, expectPass: true, isBinding: true, metadata: { commentType: 'plain-block' } };
    },
  },
  {
    id: 'comment-doc-line',
    category: 'comments',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `//# documentation comment\n${k}:number = 3`, expectPass: true, isBinding: true, metadata: { commentType: 'doc-line', channel: 'doc' } };
    },
  },
  {
    id: 'comment-doc-block',
    category: 'comments',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/# block doc comment #/\n${k}:number = 4`, expectPass: true, isBinding: true, metadata: { commentType: 'doc-block', channel: 'doc' } };
    },
  },
  {
    id: 'comment-annotation-line',
    category: 'comments',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `//@ annotation comment\n${k}:number = 5`, expectPass: true, isBinding: true, metadata: { commentType: 'annotation-line', channel: 'annotation' } };
    },
  },
  {
    id: 'comment-annotation-block',
    category: 'comments',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/@ block annotation @/\n${k}:string = "ann"`, expectPass: true, isBinding: true, metadata: { commentType: 'annotation-block', channel: 'annotation' } };
    },
  },
  {
    id: 'comment-hint-line',
    category: 'comments',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `${k}:number = 6 //? hint comment`, expectPass: true, isBinding: true, metadata: { commentType: 'hint-line', channel: 'hint' } };
    },
  },
  {
    id: 'comment-hint-block',
    category: 'comments',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/? block hint ?/\n${k}:number = 7`, expectPass: true, isBinding: true, metadata: { commentType: 'hint-block', channel: 'hint' } };
    },
  },
  {
    id: 'comment-reserved-structure',
    category: 'comments',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/{ structure reserved }/\n${k}:number = 8`, expectPass: true, isBinding: true, metadata: { commentType: 'reserved-structure', channel: 'reserved' } };
    },
  },
  {
    id: 'comment-reserved-profile',
    category: 'comments',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/[ profile reserved ]/\n${k}:number = 9`, expectPass: true, isBinding: true, metadata: { commentType: 'reserved-profile', channel: 'reserved' } };
    },
  },
  {
    id: 'comment-reserved-instructions',
    category: 'comments',
    priority: 'low',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/( instructions reserved )/\n${k}:number = 10`, expectPass: true, isBinding: true, metadata: { commentType: 'reserved-instructions', channel: 'reserved' } };
    },
  },
  {
    id: 'comment-host-line',
    category: 'comments',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `//! host runtime note\n${k}:number = 10`, expectPass: true, isBinding: true, metadata: { commentType: 'host-line', channel: 'host' } };
    },
  },
  {
    id: 'comment-reserved-structure-line',
    category: 'comments',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `//{ structure reserved\n${k}:number = 10`, expectPass: true, isBinding: true, metadata: { commentType: 'reserved-structure-line', channel: 'reserved' } };
    },
  },
  {
    id: 'comment-reserved-profile-line',
    category: 'comments',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `//[ profile reserved\n${k}:number = 10`, expectPass: true, isBinding: true, metadata: { commentType: 'reserved-profile-line', channel: 'reserved' } };
    },
  },
  {
    id: 'comment-reserved-instructions-line',
    category: 'comments',
    priority: 'low',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `//( instructions reserved\n${k}:number = 10`, expectPass: true, isBinding: true, metadata: { commentType: 'reserved-instructions-line', channel: 'reserved' } };
    },
  },
  {
    id: 'comment-trailing-same-line',
    category: 'comments',
    priority: 'high',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `${k}:number = 11 //? trailing hint`, expectPass: true, isBinding: true, metadata: { commentType: 'trailing-hint', position: 'trailing' } };
    },
  },
  {
    id: 'comment-infix-list',
    category: 'comments',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `${k}:list = [1, /? in-list ?/ 2]`, expectPass: true, isBinding: true, metadata: { commentType: 'infix', position: 'container' } };
    },
  },
  {
    id: 'comment-unterminated-block-invalid',
    category: 'comments',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('cm');
      return { text: `/* unterminated block\n${k}:number = 0`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'unterminated-block' } };
    },
  },
  {
    id: 'number-invalid-underscore-leading',
    category: 'values',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = _100`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'number-underscore-leading' } };
    },
  },
  {
    id: 'number-invalid-underscore-double',
    category: 'values',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = 100__000`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'number-underscore-double' } };
    },
  },
  {
    id: 'number-invalid-underscore-trailing',
    category: 'values',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('num');
      return { text: `${k}:number = 100_`, expectPass: false, isBinding: true, metadata: { negative: true, reason: 'number-underscore-trailing' } };
    },
  },
];

// ── Layout features ──────────────────────────────────────────────────

const layoutFeatures = [
  {
    id: 'layout-list-mixed-separators',
    category: 'layout',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('lay');
      return { text: `${k}:list = [1, 2\n  3\n  4, 5]`, expectPass: true, isBinding: true, metadata: { layout: 'mixed-separators' } };
    },
  },
  {
    id: 'layout-list-trailing-comma',
    category: 'layout',
    priority: 'medium',
    contexts: ['top', 'object'],
    generate() {
      const k = uniqueKey('lay');
      return { text: `${k}:list = [1, 2, 3,]`, expectPass: true, isBinding: true, metadata: { layout: 'trailing-comma' } };
    },
  },
  {
    id: 'layout-node-mixed-separators',
    category: 'layout',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('lay');
      return {
        text: `${k}:node = <div(\n  "hello"\n  <br()>,\n  "world"\n)>`,
        expectPass: true,
        isBinding: true,
        metadata: { layout: 'node-mixed-separators' },
      };
    },
  },
  {
    id: 'layout-object-newline-separated',
    category: 'layout',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('lay');
      return {
        text: `${k}:object = {\n  x:number = 1\n  y:number = 2\n  z:number = 3\n}`,
        expectPass: true,
        isBinding: true,
        metadata: { layout: 'object-newline' },
      };
    },
  },
];

// ── Nesting features ─────────────────────────────────────────────────

const nestingFeatures = [
  {
    id: 'nesting-object-in-list',
    category: 'nesting',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('nest');
      return {
        text: `${k}:list = [{a:number=1}, {b:number=2}]`,
        expectPass: true,
        isBinding: true,
        metadata: { nesting: 'object-in-list' },
      };
    },
  },
  {
    id: 'nesting-list-in-object',
    category: 'nesting',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('nest');
      return {
        text: `${k}:object = {\n  items:list = [1, 2, 3]\n}`,
        expectPass: true,
        isBinding: true,
        metadata: { nesting: 'list-in-object' },
      };
    },
  },
  {
    id: 'nesting-tuple-in-list',
    category: 'nesting',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('nest');
      return {
        text: `${k}:list = [(1, 2), (3, 4)]`,
        expectPass: true,
        isBinding: true,
        metadata: { nesting: 'tuple-in-list' },
      };
    },
  },
  {
    id: 'nesting-deep-objects',
    category: 'nesting',
    priority: 'high',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('nest');
      return {
        text: `${k}:object = {\n  a:object = {\n    b:object = {\n      c:number = 42\n    }\n  }\n}`,
        expectPass: true,
        isBinding: true,
        metadata: { nesting: 'deep-objects', depth: 3 },
      };
    },
  },
  {
    id: 'nesting-attrs-on-nested',
    category: 'nesting',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('nest');
      return {
        text: `${k}:list = [{x@{b:number=0}:number=1}]`,
        expectPass: true,
        isBinding: true,
        metadata: { nesting: 'attrs-on-nested-binding' },
      };
    },
  },
  {
    id: 'nesting-node-in-node',
    category: 'nesting',
    priority: 'medium',
    contexts: ['top'],
    generate() {
      const k = uniqueKey('nest');
      return {
        text: `${k}:node = <ul(<li("item 1")>, <li("item 2")>)>`,
        expectPass: true,
        isBinding: true,
        metadata: { nesting: 'node-in-node' },
      };
    },
  },
];

// ── Full catalog ─────────────────────────────────────────────────────

export const ALL_FEATURES = [
  ...valueFeatures,
  ...containerFeatures,
  ...keyFeatures,
  ...attributeFeatures,
  ...typeAnnotationFeatures,
  ...referenceFeatures,
  ...commentFeatures,
  ...layoutFeatures,
  ...nestingFeatures,
];

export const CATEGORIES = [...new Set(ALL_FEATURES.map((f) => f.category))];

export function getFeaturesByCategory(category) {
  return ALL_FEATURES.filter((f) => f.category === category);
}

export function getFeaturesByPriority(priority) {
  return ALL_FEATURES.filter((f) => f.priority === priority);
}
