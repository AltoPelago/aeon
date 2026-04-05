import { compile } from '../../../../implementations/typescript/packages/core/dist/index.js';
import { canonicalize } from '../../../../implementations/typescript/packages/canonical/dist/index.js';
import { readAeon } from '../../../../implementations/typescript/packages/sdk-internal/dist/index.js';
import { finalizeJson, finalizeLinkedJson } from '../../../../implementations/typescript/packages/finalize/dist/json.js';
import { performance } from 'node:perf_hooks';

function passRow(name, details = {}) {
  return { name, ok: true, ...details };
}

function failRow(name, reason, details = {}) {
  return { name, ok: false, reason, ...details };
}

function hasCode(errors, code) {
  return errors.some((error) => error.code === code);
}

function runReferenceFinalizeBehavior() {
  const source = [
    'aeon:header = {',
    '  encoding:string = "utf-8"',
    '  mode:string = "transport"',
    '}',
    'a = 1',
    'b = ~a',
  ].join('\n');
  const result = readAeon(source, { finalize: { mode: 'strict' } });
  if (result.compile.errors.length > 0) {
    return failRow('ref-clone-finalize-materialization', 'compile should pass', {
      compileCodes: result.compile.errors.map((error) => error.code).join(','),
    });
  }
  const finalizeErrors = result.finalized.meta?.errors ?? [];
  if (finalizeErrors.length > 0) {
    return failRow('ref-clone-finalize-materialization', 'finalization should not report unresolved clone references', {
      finalizeMessages: finalizeErrors.map((entry) => entry.message).join(' | '),
    });
  }
  if (result.finalized.document?.b !== 1) {
    return failRow('ref-clone-finalize-materialization', 'clone reference should materialize to the referenced value', {
      value: JSON.stringify(result.finalized.document?.b),
    });
  }
  return passRow('ref-clone-finalize-materialization', { value: result.finalized.document.b });
}

function runMissingReference() {
  const result = compile('a:number = ~missing');
  if (!hasCode(result.errors, 'MISSING_REFERENCE_TARGET')) {
    return failRow('missing-reference-target-error', 'missing reference should fail with MISSING_REFERENCE_TARGET', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  if (result.events.length !== 0) {
    return failRow('missing-reference-target-error', 'fail-closed should emit zero events');
  }
  return passRow('missing-reference-target-error');
}

function runAttributeDepthPolicy() {
  const source = 'a = 1\nv = ~a@x@y';
  const defaultResult = compile(source);
  const codes = defaultResult.errors.map((error) => error.code);
  if (!codes.includes('ATTRIBUTE_DEPTH_EXCEEDED')) {
    return failRow('attribute-reference-depth-policy', 'expected ATTRIBUTE_DEPTH_EXCEEDED at default depth policy', {
      codes: codes.join(','),
    });
  }
  return passRow('attribute-reference-depth-policy', { codes: codes.join(',') });
}

function runCanonicalDeterminism() {
  const c1 = canonicalize('b = 1\na = 2');
  const c2 = canonicalize('a = 2\nb = 1');
  if (c1.errors.length > 0 || c2.errors.length > 0) {
    return failRow('canonical-determinism', 'canonicalization should not error');
  }
  if (c1.text !== c2.text) {
    return failRow('canonical-determinism', 'canonical output should be stable under key reorder');
  }
  return passRow('canonical-determinism');
}

function runCanonicalNodeDeterminism() {
  const n1 = canonicalize('content:html = <div(<span@{id="text", class="dark"}:node("hello", <br()>, "world")>)>');
  const n2 = canonicalize([
    'content:html = <div(',
    '  <span@{class="dark", id="text"}:node(',
    '    "hello"',
    '    <br()>,',
    '    "world",',
    '  )>',
    ')>',
  ].join('\n'));

  if (n1.errors.length > 0 || n2.errors.length > 0) {
    return failRow('canonical-node-determinism', 'canonicalization should not error for node introducer syntax', {
      e1: n1.errors.map((error) => error.code).join(','),
      e2: n2.errors.map((error) => error.code).join(','),
    });
  }
  if (n1.text !== n2.text) {
    return failRow('canonical-node-determinism', 'canonical output should be stable for equivalent node docs');
  }
  return passRow('canonical-node-determinism');
}

function runTrimtickStrictAlias() {
  const source = [
    'aeon:mode = "strict"',
    'doc:trimtick = >>`',
    '    one',
    '  two',
    '`',
  ].join('\n');
  const result = compile(source);
  if (result.errors.length > 0) {
    return failRow('trimtick-strict-alias', 'expected strict trimtick alias to compile cleanly', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  const event = result.events.find((entry) => entry.key === 'doc');
  if (!event || event.value.type !== 'StringLiteral') {
    return failRow('trimtick-strict-alias', 'expected StringLiteral event for trimtick binding');
  }
  if (event.datatype !== 'trimtick') {
    return failRow('trimtick-strict-alias', 'expected datatype trimtick to be preserved', {
      datatype: event.datatype ?? '',
    });
  }
  if (event.value.value !== '  one\ntwo') {
    return failRow('trimtick-strict-alias', 'unexpected trimmed semantic value', {
      value: JSON.stringify(event.value.value),
    });
  }
  return passRow('trimtick-strict-alias', { datatype: event.datatype, lines: event.value.value.split('\n').length });
}

function runTrimtickCanonicalConvergence() {
  const trimtick = canonicalize([
    'text:string = >>`',
    '\t\tWhenever I am here,',
    '\t  I can do whatever I want',
    '    because this is such a cool feature',
    '\t\tright?',
    '\t`',
  ].join('\n'));
  const raw = canonicalize([
    'text:string = `Whenever I am here,',
    'I can do whatever I want',
    'because this is such a cool feature',
    'right?`',
  ].join('\n'));

  if (trimtick.errors.length > 0 || raw.errors.length > 0) {
    return failRow('trimtick-canonical-convergence', 'canonicalization should not error', {
      e1: trimtick.errors.map((error) => error.code).join(','),
      e2: raw.errors.map((error) => error.code).join(','),
    });
  }
  if (trimtick.text !== raw.text) {
    return failRow('trimtick-canonical-convergence', 'equivalent multiline values should converge canonically');
  }
  if (!trimtick.text.includes('text:string = >`')) {
    return failRow('trimtick-canonical-convergence', 'canonical output should use trimticks for multiline strings');
  }
  return passRow('trimtick-canonical-convergence');
}

function runLeadingDotDecimalCanonicalConvergence() {
  const dotted = canonicalize([
    'half:number = .5',
    'negative:number = -.5',
    'positive:number = +.5',
  ].join('\n'));
  const explicit = canonicalize([
    'half:number = 0.5',
    'negative:number = -0.5',
    'positive:number = 0.5',
  ].join('\n'));

  if (dotted.errors.length > 0 || explicit.errors.length > 0) {
    return failRow('leading-dot-decimal-canonical-convergence', 'canonicalization should not error', {
      e1: dotted.errors.map((error) => error.code).join(','),
      e2: explicit.errors.map((error) => error.code).join(','),
    });
  }
  if (dotted.text !== explicit.text) {
    return failRow('leading-dot-decimal-canonical-convergence', 'leading-dot decimals should converge with explicit-zero decimals');
  }
  if (!dotted.text.includes('half:number = 0.5')
    || !dotted.text.includes('negative:number = -0.5')
    || !dotted.text.includes('positive:number = 0.5')) {
    return failRow('leading-dot-decimal-canonical-convergence', 'canonical output should normalize leading-dot decimals');
  }
  return passRow('leading-dot-decimal-canonical-convergence');
}

function runLegacyNodeSyntaxRejected() {
  const result = compile('content:html = div < ("hello")');
  if (!hasCode(result.errors, 'SYNTAX_ERROR')) {
    return failRow('invalid-node-syntax-rejected', 'expected SYNTAX_ERROR for invalid non-introducer node syntax', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  return passRow('invalid-node-syntax-rejected');
}

function runRecoveryBehavior() {
  const source = 'a = 1\na = 2';
  const normal = compile(source);
  const recovery = compile(source, { recovery: true });
  if (normal.events.length !== 0 || !hasCode(normal.errors, 'DUPLICATE_CANONICAL_PATH')) {
    return failRow('recovery-fail-closed-default', 'default should be fail-closed with duplicate path');
  }
  if (recovery.events.length === 0 || !hasCode(recovery.errors, 'DUPLICATE_CANONICAL_PATH')) {
    return failRow('recovery-partial-events', 'recovery mode should retain partial events with duplicate error');
  }
  return passRow('recovery-vs-fail-closed', { recoveryEvents: recovery.events.length });
}

function runAnnotationBinding() {
  const source = 'a = [1, /? in-list ?/ 2]\n/# tail #/';
  const parsed = readAeon(source, { finalize: { mode: 'loose' } });
  if (parsed.compile.errors.length > 0) {
    return failRow('annotation-binding', 'compile should pass', {
      codes: parsed.compile.errors.map((error) => error.code).join(','),
    });
  }
  const annotations = parsed.compile.annotations ?? [];
  const summary = annotations.map((record) => {
    if (record.target.kind === 'path') return `${record.kind}:${record.target.path}`;
    if (record.target.kind === 'unbound') return `${record.kind}:unbound:${record.target.reason}`;
    return `${record.kind}:span`;
  });
  const hasInfix = summary.includes('hint:$.a[1]');
  const hasUnboundTail = summary.includes('doc:unbound:eof');
  if (!hasInfix || !hasUnboundTail) {
    return failRow('annotation-binding', 'expected infix list binding and unbound eof tail', {
      summary: summary.join(' | '),
    });
  }
  return passRow('annotation-binding', { annotations: annotations.length });
}

function runLargeDocument() {
  const start = performance.now();
  let source = '';
  for (let i = 0; i < 10000; i += 1) {
    source += `k${i}:number = ${i}\n`;
  }
  const result = compile(source);
  if (result.errors.length > 0) {
    return failRow('large-document-10000-bindings', 'expected no compile errors', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  if (result.events.length !== 10000) {
    return failRow('large-document-10000-bindings', 'event count mismatch', { events: result.events.length });
  }
  const ms = Math.round(performance.now() - start);
  return passRow('large-document-10000-bindings', { events: result.events.length, ms });
}

function runLargeDocument50k() {
  const start = performance.now();
  let source = '';
  for (let i = 0; i < 50000; i += 1) {
    source += `k${i}:number = ${i}\n`;
  }
  const result = compile(source);
  if (result.errors.length > 0) {
    return failRow('large-document-50000-bindings', 'expected no compile errors', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  if (result.events.length !== 50000) {
    return failRow('large-document-50000-bindings', 'event count mismatch', { events: result.events.length });
  }
  const ms = Math.round(performance.now() - start);
  return passRow('large-document-50000-bindings', { events: result.events.length, ms });
}

function runDeepNestedObjectPaths() {
  const start = performance.now();
  const depth = 180;
  const lines = [];
  for (let i = 0; i < depth; i += 1) {
    lines.push(`${'  '.repeat(i)}n${i}:object = {`);
  }
  lines.push(`${'  '.repeat(depth)}leaf:number = 1`);
  for (let i = depth - 1; i >= 0; i -= 1) {
    lines.push(`${'  '.repeat(i)}}`);
  }
  const source = lines.join('\n');
  const result = compile(source);
  if (result.errors.length > 0) {
    return failRow('deep-nested-object-paths', 'expected no compile errors', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  const leafEvent = result.events.find((event) => {
    const segments = event.path.segments.filter((segment) => segment.type === 'member').map((segment) => segment.key);
    return segments.at(-1) === 'leaf';
  });
  if (!leafEvent || leafEvent.datatype !== 'number') {
    return failRow('deep-nested-object-paths', 'missing deep leaf assignment event');
  }
  const ms = Math.round(performance.now() - start);
  return passRow('deep-nested-object-paths', { events: result.events.length, depth, ms });
}

function runListHeavyDocument() {
  const start = performance.now();
  const lines = [];
  const rows = 2500;
  for (let i = 0; i < rows; i += 1) {
    const a = i;
    const b = i + 1;
    const c = i + 2;
    const d = i + 3;
    const e = i + 4;
    lines.push(`row${i}:nums = [${a}, ${b}, ${c}, ${d}, ${e}]`);
  }
  const source = lines.join('\n');
  const result = compile(source);
  if (result.errors.length > 0) {
    return failRow('list-heavy-document', 'expected no compile errors', {
      codes: result.errors.map((error) => error.code).join(','),
    });
  }
  const expectedEvents = rows * 6;
  if (result.events.length !== expectedEvents) {
    return failRow('list-heavy-document', 'event count mismatch', { events: result.events.length, expectedEvents });
  }
  const ms = Math.round(performance.now() - start);
  return passRow('list-heavy-document', { events: result.events.length, rows, ms });
}

function runSeparatorLiteralEscapeStress() {
  const start = performance.now();
  const repeats = 4000;
  const chunk = 'A0|"0,0 / 0"|B0';
  const payload = Array.from({ length: repeats }, () => chunk).join('|');
  const source = `line:set[|] = ^${payload}`;

  try {
    const result = compile(source, { maxSeparatorDepth: 8 });
    if (result.errors.length > 0) {
      return failRow('separator-literal-escape-stress', 'expected separator stress payload to compile cleanly', {
        codes: result.errors.map((error) => error.code).join(','),
      });
    }
    const event = result.events.find((entry) => entry.key === 'line');
    if (!event || event.value.type !== 'SeparatorLiteral') {
      return failRow('separator-literal-escape-stress', 'expected SeparatorLiteral event');
    }
    const ms = Math.round(performance.now() - start);
    return passRow('separator-literal-escape-stress', { repeats, payloadBytes: payload.length, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('separator-literal-escape-stress', 'Node stack overflow on separator stress payload (RangeError)');
    }
    return failRow('separator-literal-escape-stress', 'Unexpected crash parsing separator stress payload', {
      msg: err.message,
    });
  }
}

function runReferencePathExplosion() {
  const start = performance.now();
  const chain = 120;
  const lines = [
    'aeon:header = {',
    '  encoding:string = "utf-8"',
    '  mode:string = "transport"',
    '}',
    'root:object = {',
    '  "alpha.beta":object = {',
    '    arr:list = [',
    '      {',
    '        meta:object = {',
    '          "x.y":number = 7',
    '        }',
    '      }',
    '    ]',
    '  }',
    '}',
  ];
  for (let i = 0; i < chain; i += 1) {
    const ref = '~$.root["alpha.beta"].arr[0].meta["x.y"]';
    lines.push(`ref${i}:number = ${ref}`);
  }
  const source = lines.join('\n');

  try {
    const result = compile(source);
    if (result.errors.length > 0) {
      return failRow('reference-path-explosion', 'expected long quoted/indexed reference paths to compile cleanly', {
        codes: result.errors.map((error) => error.code).join(','),
      });
    }
    const refEvents = result.events.filter((entry) => entry.key.startsWith('ref'));
    if (refEvents.length !== chain) {
      return failRow('reference-path-explosion', 'unexpected reference event count', {
        events: refEvents.length,
        expected: chain,
      });
    }
    const ms = Math.round(performance.now() - start);
    return passRow('reference-path-explosion', { chain, events: result.events.length, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('reference-path-explosion', 'Node stack overflow on reference path explosion payload (RangeError)');
    }
    return failRow('reference-path-explosion', 'Unexpected crash parsing reference path explosion payload', {
      msg: err.message,
    });
  }
}

function runWideReferenceFanout() {
  const start = performance.now();
  const clones = 600;
  const pointers = 600;
  const lines = [
    'aeon:header = {',
    '  encoding:string = "utf-8"',
    '  mode:string = "transport"',
    '}',
    'base:object = {',
    '  count:number = 42',
    '  payload:object = {',
    '    name:string = "fanout"',
    '    active:boolean = true',
    '  }',
    '}',
  ];
  for (let i = 0; i < clones; i += 1) {
    lines.push(`clone${i}:object = ~base`);
  }
  for (let i = 0; i < pointers; i += 1) {
    lines.push(`ptr${i}:object = ~>base`);
  }
  const source = lines.join('\n');

  try {
    const parsed = compile(source);
    if (parsed.errors.length > 0) {
      return failRow('wide-reference-fanout', 'expected wide clone/pointer fanout to compile cleanly', {
        codes: parsed.errors.map((error) => error.code).join(','),
      });
    }
    const finalized = finalizeLinkedJson(parsed.events, { mode: 'strict' });
    const finalizeErrors = finalized.meta?.errors ?? [];
    if (finalizeErrors.length > 0) {
      return failRow('wide-reference-fanout', 'expected linked finalization to handle wide fanout without errors', {
        messages: finalizeErrors.map((entry) => entry.message).slice(0, 3).join(' | '),
      });
    }
    if (finalized.document?.clone0?.count !== 42 || finalized.document?.ptr0?.count !== 42) {
      return failRow('wide-reference-fanout', 'expected clone/pointer fanout to materialize base payload in linked JSON mode', {
        clone0: JSON.stringify(finalized.document?.clone0),
        ptr0: JSON.stringify(finalized.document?.ptr0),
      });
    }
    const ms = Math.round(performance.now() - start);
    return passRow('wide-reference-fanout', { clones, pointers, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('wide-reference-fanout', 'Node stack overflow on wide clone/pointer fanout payload (RangeError)');
    }
    return failRow('wide-reference-fanout', 'Unexpected crash finalizing wide clone/pointer fanout payload', {
      msg: err.message,
    });
  }
}

function runCommentChannelDensity() {
  const start = performance.now();
  const items = 400;
  const lines = ['list = ['];
  for (let i = 0; i < items; i += 1) {
    lines.push(`  /? before-${i} ?/ ${i}, //# after-${i}`);
  }
  lines.push(']');
  lines.push('/# eof-tail #/');
  const source = lines.join('\n');

  try {
    const parsed = readAeon(source, { finalize: { mode: 'loose' } });
    if (parsed.compile.errors.length > 0) {
      return failRow('comment-channel-density', 'expected dense comment payload to compile cleanly', {
        codes: parsed.compile.errors.map((error) => error.code).join(','),
      });
    }
    const annotations = parsed.compile.annotations ?? [];
    if (annotations.length < items) {
      return failRow('comment-channel-density', 'expected dense comment payload to produce many annotation records', {
        annotations: annotations.length,
        expectedMin: items,
      });
    }
    const ms = Math.round(performance.now() - start);
    return passRow('comment-channel-density', { items, annotations: annotations.length, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('comment-channel-density', 'Node stack overflow on dense comment payload (RangeError)');
    }
    return failRow('comment-channel-density', 'Unexpected crash parsing dense comment payload', {
      msg: err.message,
    });
  }
}

function runWideDuplicateKeyCollisions() {
  const start = performance.now();
  const repeats = 1500;
  const lines = ['dupes:object = {'];
  for (let i = 0; i < repeats; i += 1) {
    lines.push('  collision:number = 1');
  }
  lines.push('}');
  const source = lines.join('\n');

  try {
    const normal = compile(source);
    if (!hasCode(normal.errors, 'DUPLICATE_KEY')) {
      return failRow('wide-duplicate-key-collisions', 'expected duplicate keys to be detected', {
        codes: normal.errors.map((error) => error.code).join(','),
      });
    }
    const recovery = compile(source, { recovery: true });
    const ms = Math.round(performance.now() - start);
    return passRow('wide-duplicate-key-collisions', {
      repeats,
      strictErrors: normal.errors.length,
      recoveryEvents: recovery.events.length,
      ms,
    });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('wide-duplicate-key-collisions', 'Node stack overflow on duplicate collision payload (RangeError)');
    }
    return failRow('wide-duplicate-key-collisions', 'Unexpected crash parsing duplicate collision payload', {
      msg: err.message,
    });
  }
}

function runProjectionPathStress() {
  const start = performance.now();
  const width = 300;
  const lines = ['root:object = {'];
  const includePaths = [];
  for (let i = 0; i < width; i += 1) {
    lines.push(`  item${i}:object = {`);
    lines.push(`    name:string = "n${i}"`);
    lines.push(`    count:number = ${i}`);
    lines.push('  }');
    includePaths.push(`$.root.item${i}.name`);
  }
  lines.push('}');
  const source = lines.join('\n');

  try {
    const parsed = compile(source);
    if (parsed.errors.length > 0) {
      return failRow('projection-path-stress', 'expected projected payload source to compile cleanly', {
        codes: parsed.errors.map((error) => error.code).join(','),
      });
    }
    const finalized = finalizeJson(parsed.events, {
      mode: 'strict',
      materialization: 'projected',
      includePaths,
    });
    const finalizeErrors = finalized.meta?.errors ?? [];
    if (finalizeErrors.length > 0) {
      return failRow('projection-path-stress', 'expected projected finalization to succeed under many include paths', {
        messages: finalizeErrors.map((entry) => entry.message).slice(0, 3).join(' | '),
      });
    }
    if (finalized.document?.root?.item0?.name !== 'n0' || finalized.document?.root?.item0?.count !== undefined) {
      return failRow('projection-path-stress', 'expected projected output to retain selected names and omit sibling fields', {
        item0: JSON.stringify(finalized.document?.root?.item0),
      });
    }
    const ms = Math.round(performance.now() - start);
    return passRow('projection-path-stress', { includePaths: includePaths.length, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('projection-path-stress', 'Node stack overflow on projected finalization payload (RangeError)');
    }
    return failRow('projection-path-stress', 'Unexpected crash in projected finalization payload', {
      msg: err.message,
    });
  }
}

function runCanonicalQuotedKeySortPressure() {
  const start = performance.now();
  const keys = [];
  for (let i = 0; i < 200; i += 1) {
    keys.push(`"k.${String(i).padStart(3, '0')}" = ${i}`);
  }
  const forward = canonicalize(keys.join('\n'));
  const reverse = canonicalize([...keys].reverse().join('\n'));
  if (forward.errors.length > 0 || reverse.errors.length > 0) {
    return failRow('canonical-quoted-key-sort-pressure', 'canonicalization should not error under many quoted keys', {
      e1: forward.errors.map((error) => error.code).join(','),
      e2: reverse.errors.map((error) => error.code).join(','),
    });
  }
  if (forward.text !== reverse.text) {
    return failRow('canonical-quoted-key-sort-pressure', 'quoted key canonical sort should be deterministic under reorder pressure');
  }
  const ms = Math.round(performance.now() - start);
  return passRow('canonical-quoted-key-sort-pressure', { keys: keys.length, ms });
}

function runTrimtickIndentationStress() {
  const start = performance.now();
  const lines = ['story:string = >>`'];
  for (let i = 0; i < 250; i += 1) {
    const indent = i % 3 === 0 ? '\t\t' : (i % 3 === 1 ? '      ' : '\t  ');
    lines.push(`${indent}line ${i}`);
  }
  lines.push('\t`');
  const source = lines.join('\n');

  try {
    const result = canonicalize(source);
    if (result.errors.length > 0) {
      return failRow('trimtick-indentation-stress', 'expected trimtick indentation stress to canonicalize cleanly', {
        codes: result.errors.map((error) => error.code).join(','),
      });
    }
    if (!result.text.includes('story:string = >`')) {
      return failRow('trimtick-indentation-stress', 'expected trimtick indentation stress to remain multiline canonical output');
    }
    const ms = Math.round(performance.now() - start);
    return passRow('trimtick-indentation-stress', { lines: lines.length - 2, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('trimtick-indentation-stress', 'Node stack overflow on trimtick indentation payload (RangeError)');
    }
    return failRow('trimtick-indentation-stress', 'Unexpected crash canonicalizing trimtick indentation payload', {
      msg: err.message,
    });
  }
}

function runAlternatingContainerNesting() {
  const start = performance.now();
  const depth = 80;
  let value = '1';
  for (let i = depth - 1; i >= 0; i -= 1) {
    switch (i % 4) {
      case 0:
        value = `{ layer${i} = ${value} }`;
        break;
      case 1:
        value = `[${value}]`;
        break;
      case 2:
        value = `(${value})`;
        break;
      default:
        value = `<n${i}(${value})>`;
        break;
    }
  }
  const source = `mix = ${value}`;

  try {
    const result = compile(source);
    if (result.errors.length > 0) {
      return failRow('alternating-container-nesting', 'expected alternating container nesting to compile cleanly', {
        codes: result.errors.map((error) => error.code).join(','),
      });
    }
    const ms = Math.round(performance.now() - start);
    return passRow('alternating-container-nesting', { depth, events: result.events.length, ms });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('alternating-container-nesting', 'Node stack overflow on alternating container nesting payload (RangeError)');
    }
    return failRow('alternating-container-nesting', 'Unexpected crash parsing alternating container nesting payload', {
      msg: err.message,
    });
  }
}

function runInputSizeGuard() {
  const start = performance.now();
  const bytes = 200000;
  const source = `blob:string = "${'x'.repeat(bytes)}"`;

  try {
    const result = compile(source, { maxInputBytes: 1024 });
    if (!hasCode(result.errors, 'INPUT_SIZE_EXCEEDED')) {
      return failRow('input-size-guard', 'expected maxInputBytes guard to fail early', {
        codes: result.errors.map((error) => error.code).join(','),
      });
    }
    if (result.events.length !== 0) {
      return failRow('input-size-guard', 'expected input size guard to remain fail-closed');
    }
    const ms = Math.round(performance.now() - start);
    return passRow('input-size-guard', { bytes, ms });
  } catch (err) {
    return failRow('input-size-guard', 'Unexpected crash exercising maxInputBytes guard', {
      msg: err.message,
    });
  }
}

function runAlgorithmicDoSRecursionNesting() {
  const start = performance.now();
  const depth = 2000;
  const source = `k:list = ${'['.repeat(depth)}${']'.repeat(depth)}`;

  try {
    const result = compile(source);
    const ms = Math.round(performance.now() - start);
    return passRow('algorithmic-dos-recursion-nesting', { depth, ms, errors: result.errors.length });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('algorithmic-dos-recursion-nesting', 'Node stack overflow on recursion payload (RangeError)');
    }
    return failRow('algorithmic-dos-recursion-nesting', 'Unexpected crash', { msg: err.message });
  }
}

function runAlgorithmicDoSLargeInteger() {
  const start = performance.now();
  const digits = 500000;
  const source = `huge:number = ${'1'.repeat(digits)}`;
  try {
    const result = compile(source);
    const ms = Math.round(performance.now() - start);
    return passRow('algorithmic-dos-large-integer', { digits, ms, errors: result.errors.length });
  } catch (err) {
    return failRow('algorithmic-dos-large-integer', 'Unexpected crash parsing large integer', { msg: err.message });
  }
}

function runAlgorithmicDoSNestedGenericDepth() {
  const start = performance.now();
  const depth = 200;
  const nestedType = `${'tuple<'.repeat(depth)}n${'>'.repeat(depth)}`;
  const source = `g:${nestedType} = 1`;

  try {
    const defaultResult = compile(source);
    if (!hasCode(defaultResult.errors, 'GENERIC_DEPTH_EXCEEDED')) {
      return failRow('algorithmic-dos-nested-generic-depth', 'default policy should reject deeply nested generics', {
        codes: defaultResult.errors.map((error) => error.code).join(','),
      });
    }

    const raisedResult = compile(source, { maxGenericDepth: depth + 1 });
    const ms = Math.round(performance.now() - start);
    return passRow('algorithmic-dos-nested-generic-depth', {
      depth,
      ms,
      defaultErrors: defaultResult.errors.length,
      raisedErrors: raisedResult.errors.length,
    });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('algorithmic-dos-nested-generic-depth', 'Node stack overflow on nested generic payload (RangeError)');
    }
    return failRow('algorithmic-dos-nested-generic-depth', 'Unexpected crash parsing nested generic payload', {
      msg: err.message,
    });
  }
}

function runAlgorithmicDoSNestedGenericNoCrash() {
  const start = performance.now();
  const depth = 2000;
  const nestedType = `${'tuple<'.repeat(depth)}n${'>'.repeat(depth)}`;
  const source = `g:${nestedType} = 1`;

  try {
    const result = compile(source);
    const ms = Math.round(performance.now() - start);
    return passRow('algorithmic-dos-nested-generic-no-crash', {
      depth,
      ms,
      errors: result.errors.length,
      hasDepthError: hasCode(result.errors, 'GENERIC_DEPTH_EXCEEDED') ? 'yes' : 'no',
    });
  } catch (err) {
    if (err.name === 'RangeError') {
      return failRow('algorithmic-dos-nested-generic-no-crash', 'Node stack overflow on deep nested generic canary (RangeError)');
    }
    return failRow('algorithmic-dos-nested-generic-no-crash', 'Unexpected crash parsing deep nested generic canary', {
      msg: err.message,
    });
  }
}

const rows = [
  runReferenceFinalizeBehavior(),
  runMissingReference(),
  runAttributeDepthPolicy(),
  runCanonicalDeterminism(),
  runCanonicalNodeDeterminism(),
  runTrimtickStrictAlias(),
  runTrimtickCanonicalConvergence(),
  runLeadingDotDecimalCanonicalConvergence(),
  runLegacyNodeSyntaxRejected(),
  runRecoveryBehavior(),
  runAnnotationBinding(),
  runLargeDocument(),
  runLargeDocument50k(),
  runDeepNestedObjectPaths(),
  runListHeavyDocument(),
  runSeparatorLiteralEscapeStress(),
  runReferencePathExplosion(),
  runWideReferenceFanout(),
  runCommentChannelDensity(),
  runWideDuplicateKeyCollisions(),
  runProjectionPathStress(),
  runCanonicalQuotedKeySortPressure(),
  runTrimtickIndentationStress(),
  runAlternatingContainerNesting(),
  runInputSizeGuard(),
  runAlgorithmicDoSRecursionNesting(),
  runAlgorithmicDoSLargeInteger(),
  runAlgorithmicDoSNestedGenericDepth(),
  runAlgorithmicDoSNestedGenericNoCrash(),
];

console.table(
  rows.map((row) => ({
    test: row.name,
    ok: row.ok ? 'yes' : 'NO',
    reason: row.reason ?? '',
    details: Object.entries(row)
      .filter(([key]) => !['name', 'ok', 'reason'].includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join('; '),
  })),
);

const failures = rows.filter((row) => !row.ok);
if (failures.length > 0) {
  console.error(`Advanced stress failed: ${failures.length} test(s) did not meet expectations.`);
  process.exit(1);
}
console.log(`Advanced stress passed: ${rows.length} test(s) matched expectations.`);
