import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssignmentEvent } from '@aeon/aes';
import type { AnnotationRecord } from '@aeon/annotation-stream';
import { materialize } from './tonic.js';
import { materializeMatter } from './matter.js';

test('materialize returns AES passthrough scaffold result', () => {
  const result = materialize({ aes: [] });
  assert.deepEqual(result.aes, []);
});

test('materialize passes through annotations when provided', () => {
  const annotations = [{
    kind: 'doc',
    form: 'line',
    raw: '//# test',
    span: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 8, offset: 7 },
    },
    target: { kind: 'unbound', reason: 'no_bindable' },
  }] as const;

  const result = materialize({ aes: [], annotations });
  assert.deepEqual(result.annotations, annotations);
});

test('materializeMatter builds addressable object and list nodes', () => {
  const aes: readonly AssignmentEvent[] = [
    {
      path: { segments: [{ type: 'root' }, { type: 'member', key: 'title' }] },
      key: 'title',
      value: {
        type: 'StringLiteral',
        value: 'Hello',
        raw: '"Hello"',
        delimiter: '"',
        span: span(),
      },
      span: span(),
    },
    {
      path: { segments: [{ type: 'root' }, { type: 'member', key: 'items' }] },
      key: 'items',
      value: {
        type: 'ListNode',
        elements: [
          {
            type: 'StringLiteral',
            value: 'first',
            raw: '"first"',
            delimiter: '"',
            span: span(),
          },
          {
            type: 'ObjectNode',
            bindings: [{
              type: 'Binding',
              key: 'done',
              value: {
                type: 'BooleanLiteral',
                value: true,
                raw: 'true',
                span: span(),
              },
              datatype: null,
              attributes: [],
              span: span(),
            }],
            attributes: [],
            span: span(),
          },
        ],
        attributes: [],
        span: span(),
      },
      span: span(),
    },
  ];

  const annotations: readonly AnnotationRecord[] = [{
    kind: 'hint',
    form: 'line',
    raw: '//? if item',
    span: span(),
    target: { kind: 'path', path: '$.items[1]' },
  }];

  const result = materializeMatter({ aes, annotations });
  assert.ok(result.document);
  assert.equal(result.document?.has('$.title'), true);
  assert.equal(result.document?.at('$.items')?.kind, 'list');
  assert.equal(result.document?.at('$.items[0]')?.inspect(), 'scalar $.items[0] = "first"');
  assert.equal(result.document?.at('$.items[1]')?.annotations()[0]?.raw, '//? if item');
  assert.equal(result.document?.serialize(), 'title = "Hello"\nitems = ["first", { done = true }]');
});

test('materializeMatter supports list and object mutation with reindexed addresses', () => {
  const aes: readonly AssignmentEvent[] = [{
    path: { segments: [{ type: 'root' }, { type: 'member', key: 'items' }] },
    key: 'items',
    value: {
      type: 'ListNode',
      elements: [{
        type: 'StringLiteral',
        value: 'a',
        raw: '"a"',
        delimiter: '"',
        span: span(),
      }],
      attributes: [],
      span: span(),
    },
    span: span(),
  }];

  const result = materializeMatter({ aes });
  assert.ok(result.document);
  const items = result.document?.at('$.items');
  assert.ok(items && items.kind === 'list');
  items.append('b');
  items.insert(1, 'x');
  assert.equal(result.document?.has('$.items[2]'), true);
  assert.equal(result.document?.at('$.items[1]')?.inspect(), 'scalar $.items[1] = "x"');

  assert.ok(items.kind === 'list');
  items.delete(0);
  assert.equal(result.document?.at('$.items[0]')?.inspect(), 'scalar $.items[0] = "x"');
});

test('materializeMatter fails closed on unsupported tuple runtime nodes', () => {
  const aes: readonly AssignmentEvent[] = [{
    path: { segments: [{ type: 'root' }, { type: 'member', key: 'coords' }] },
    key: 'coords',
    value: {
      type: 'TupleLiteral',
      elements: [],
      attributes: [],
      raw: '()',
      span: span(),
    },
    span: span(),
  }];

  const result = materializeMatter({ aes });
  assert.equal(result.document, undefined);
  assert.equal(result.meta?.errors?.[0]?.code, 'MATTER_UNSUPPORTED_TUPLE');
});

test('materializeMatter supports node literals for structural templates', () => {
  const aes: readonly AssignmentEvent[] = [{
    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }] },
    key: 'page',
    value: {
      type: 'NodeLiteral',
      tag: 'main',
      attributes: [{
        type: 'Attribute',
        entries: new Map([
          ['class', {
            value: {
              type: 'StringLiteral',
              value: 'shell',
              raw: '"shell"',
              delimiter: '"',
              span: span(),
            },
            datatype: null,
            attributes: [],
          }],
        ]),
        span: span(),
      }],
      datatype: null,
      children: [{
        type: 'NodeLiteral',
        tag: 'h1',
        attributes: [],
        datatype: null,
        children: [{
          type: 'StringLiteral',
          value: 'Hello',
          raw: '"Hello"',
          delimiter: '"',
          span: span(),
        }],
        span: span(),
      }],
      span: span(),
    },
    span: span(),
  }];

  const result = materializeMatter({ aes });
  const page = result.document?.at('$.page');
  assert.ok(page && page.kind === 'node');
  assert.equal(page.tag(), 'main');
  assert.equal(page.attributes().get('class'), 'shell');
  assert.equal(page.children()[0]?.kind, 'node');
  assert.match(result.document?.serialize() ?? '', /page = <main@\{class = "shell"\}/);
});

function span() {
  return {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
}
