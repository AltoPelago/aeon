import test from 'node:test';
import assert from 'node:assert/strict';
import { indexEventsByPath, readAeon, readAeonChecked, readAeonStrictCustom, writeAeon } from './index.js';

test('writeAeon emits deterministic aeon text from object', () => {
  const result = writeAeon(
    {
      app: 'todo',
      todos: [
        { id: '1', title: 'Buy tea', done: false },
      ],
      version: 1,
    },
    {
      includeHeader: true,
      header: {
        encoding: 'utf-8',
        mode: 'loose',
        profile: 'aeon.gp.profile.v1',
        version: 1,
      },
    }
  );

  assert.equal(result.errors.length, 0);
  assert.ok(result.text.includes('app = "todo"'));
  assert.ok(result.text.includes('todos = ['));
});

test('readAeon compiles and finalizes aeon text', () => {
  const source = [
    'aeon:mode = "loose"',
    'app = "todo"',
    'version = 1',
    'todos = [',
    '  { id = "1", title = "Buy tea", done = false, createdAt = "2026-03-05T00:00:00.000Z" }',
    ']',
  ].join('\n');

  const result = readAeon(source, {
    finalize: { mode: 'loose' },
  });

  assert.equal(result.compile.errors.length, 0);
  assert.equal(result.finalized.meta?.errors?.length ?? 0, 0);

  const doc = result.finalized.document as Record<string, unknown>;
  assert.equal(doc.app, 'todo');
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.todos));
});

test('readAeonChecked throws on compile/finalize errors and indexes events by canonical path', () => {
  const source = [
    'aeon:mode = "strict"',
    'app:string = "todo"',
    'version:number = 1',
  ].join('\n');

  const result = readAeonChecked(source, {
    finalize: { mode: 'strict' },
  });

  assert.equal(result.eventsByPath.get('$.app')?.datatype, 'string');
  assert.equal(result.eventsByPath.get('$.version')?.datatype, 'number');
});

test('indexEventsByPath uses canonical formatted paths', () => {
  const source = [
    'aeon:mode = "loose"',
    'root:object = {',
    '  items = [',
    '    { name = "tea" }',
    '  ]',
    '}',
  ].join('\n');

  const result = readAeon(source, {
    finalize: { mode: 'strict' },
  });

  const index = indexEventsByPath(result.compile.events);
  assert.ok(index.has('$.root.items[0].name'));
});

test('readAeonStrictCustom accepts strict documents with custom datatypes', () => {
  const source = [
    'aeon:mode = "strict"',
    'message:msgContainer = {',
    '  bodyText:body = {',
    '    msg:string = "Hello"',
    '  }',
    '  random:salt = 0.123456',
    '}',
  ].join('\n');

  const result = readAeonStrictCustom(source);
  assert.equal(result.eventsByPath.get('$.message')?.datatype, 'msgContainer');
  assert.equal(result.eventsByPath.get('$.message.bodyText')?.datatype, 'body');
  assert.equal(result.eventsByPath.get('$.message.random')?.datatype, 'salt');
});
