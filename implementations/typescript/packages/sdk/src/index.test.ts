import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadAeonicLimits } from '@altopelago/aeon-core';
import {
  aeonToTelex,
  indexEventsByPath,
  readAeon,
  readAeonChecked,
  readAeonStrictCustom,
  readFilm,
  readFilmDocument,
  readTelex,
  readTelexChecked,
  readTelexDocument,
  readTelexDocumentChecked,
  writeAeon,
  writeTelex,
} from './index.js';

const FILM_SCALAR = Uint8Array.from(
  '4f5f5fff010012000109242e6d6573736167650568656c6c6f'.match(/../gu) ?? [],
  (pair) => Number.parseInt(pair, 16),
);

test('reads and materializes Film through the reader-only SDK boundary', () => {
  const decoded = readFilm(FILM_SCALAR);
  assert.deepEqual(decoded.records, [
    { path: '$.message', kind: 'StringLiteral', value: 'hello' },
  ]);

  const materialized = readFilmDocument(FILM_SCALAR);
  assert.deepEqual(materialized.finalized.document, { message: 'hello' });
  assert.equal(materialized.finalized.meta?.errors?.length ?? 0, 0);
});

test('applies the common structural limits document to Film reads', () => {
  const policySource = fs.readFileSync(
    new URL('../../../../../test-fixtures/altopelago.aeonic-limits.v1.aeon', import.meta.url),
    'utf8',
  );
  const loaded = loadAeonicLimits(policySource);
  assert.ok(loaded.limits);

  assert.throws(
    () => readFilm(FILM_SCALAR, {
      aeonicLimits: loaded.limits,
      maxStringCodepoints: 4,
    }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'FILM_AES_INVALID'
    ),
  );

  const decoded = readFilm(FILM_SCALAR, {
    aeonicLimits: loaded.limits,
    maxStringCodepoints: 5,
  });
  assert.equal(decoded.effectiveLimits?.limitsId, 'altopelago.aeonic-limits.v1');
  assert.equal(decoded.effectiveLimits?.telex.maxStringCodepoints, 5);
  assert.equal(decoded.effectiveLimits?.overridesApplied, true);
});

test('reads and writes Telex as a portable boundary format', () => {
  const encoded = writeTelex([{ path: '$.answer', kind: 'NumberLiteral', value: '42' }]);
  const decoded = readTelex(encoded);

  assert.equal(decoded.parsed.profile, 'aes.complete.v1');
  assert.equal(decoded.validation.valid, true);
  assert.deepEqual(decoded.records, [{ path: '$.answer', kind: 'NumberLiteral', value: '42' }]);
});

test('selects one common limits document across SDK Telex boundaries', () => {
  const policySource = fs.readFileSync(
    new URL('../../../../../test-fixtures/altopelago.aeonic-limits.v1.aeon', import.meta.url),
    'utf8',
  );
  const loaded = loadAeonicLimits(policySource);
  assert.ok(loaded.limits);

  const encoded = writeTelex([{ path: '$.answer', kind: 'StringLiteral', value: 'x' }]);
  const decoded = readTelex(encoded, {
    aeonicLimits: loaded.limits,
    maxStringCodepoints: 2,
  });
  assert.equal(decoded.effectiveLimits?.limitsId, 'altopelago.aeonic-limits.v1');
  assert.deepEqual(decoded.effectiveLimits?.profileClaims, [
    'aeon.gp.profile.v1',
    'aes.complete.v1',
    'aes.partial.v1',
  ]);
  assert.equal(decoded.effectiveLimits?.telex.maxStringCodepoints, 2);
  assert.equal(decoded.effectiveLimits?.overridesApplied, true);

  const exported = aeonToTelex('answer = "x"', { aeonicLimits: loaded.limits });
  assert.equal(exported.compile.errors.length, 0);
  assert.equal(exported.effectiveLimits?.finalization.maxReferenceDepth, 64);
  assert.equal(exported.effectiveLimits?.overridesApplied, false);
});

test('checked Telex reads enforce completeness by default', () => {
  assert.throws(
    () => readTelexChecked('telex.aes=1\n\npath=$.nested.answer\nkind=NumberLiteral\nvalue=42\n'),
    /AES_MISSING_PARENT/u,
  );
});

test('materializes an AEON document after a Telex round trip', () => {
  const source = String.raw`aeon:header = { mode = "transport", metadata = { owner = "team" } }
config\CONFIG\@{scope\META\ = "test"} = {
  title:string = "Demo"
  values:list<int> = [2, 3, 4]
  card:node = <tag\HEAD\@{role = "button"}(\CHILD\@{lang = "en"}:string = "hello", true)>
  copy = ~config.values
  pointer = ~>config.title
}`;
  const exported = aeonToTelex(source, { includeHeaders: true });
  assert.equal(exported.compile.errors.length, 0);
  assert.ok(exported.telex);

  const imported = readTelexDocumentChecked(exported.telex, {
    finalize: { mode: 'loose', scope: 'full' },
  });

  assert.deepEqual(imported.finalized.document, {
    header: {
      mode: 'transport',
      metadata: { owner: 'team' },
    },
    payload: {
      config: {
        title: 'Demo',
        values: [2, 3, 4],
        card: {
          $node: 'tag',
          '@': { role: 'button' },
          $children: ['hello', true],
        },
        copy: [2, 3, 4],
        pointer: '~>config.title',
        '@': {
          card: {
            '@items': {
              '0': { lang: 'en' },
            },
          },
        },
      },
      '@': {
        config: { scope: 'test' },
      },
    },
  });
  assert.equal(imported.validation.valid, true);
  assert.equal(imported.finalized.meta?.errors?.length ?? 0, 0);
  assert.ok(imported.finalized.meta?.warnings?.some((diagnostic) => diagnostic.code === 'FINALIZE_UNRESOLVED_REFERENCE'));
});

test('refuses to materialize partial Telex without external state', () => {
  const input = 'telex.aes=1\nprofile=aes.partial.v1\n\npath=$.nested.answer\nkind=NumberLiteral\nvalue=42\n';
  const result = readTelexDocument(input);

  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.finalized.document, {});
  assert.ok(result.finalized.meta?.errors?.some((diagnostic) => diagnostic.code === 'FINALIZE_PARTIAL_AES_UNSUPPORTED'));
});

test('exports AEON source to Telex while keeping the AEON workflow available', () => {
  const result = aeonToTelex('answer = 42');

  assert.equal(result.compile.errors.length, 0);
  assert.match(result.telex ?? '', /path=\$\.answer\nkind=NumberLiteral\nvalue=42/u);
});

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
  assert.equal(doc['aeon:mode'], undefined);
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

test('readAeonChecked preserves structural identities on its public AES surface', () => {
  const source = String.raw`aeon:mode = "loose"
value\ROOT\@{source\META\:string = "user"} = <tag\HEAD\(\CHILD\:string = "text")>`;
  const result = readAeonChecked(source, {
    finalize: { mode: 'loose' },
  });
  const event = result.eventsByPath.get('$.value');

  assert.equal(event?.structuralId, 'ROOT');
  assert.equal(event?.annotations?.get('source')?.structuralId, 'META');
  assert.equal(event?.value.type, 'NodeLiteral');
  if (event?.value.type !== 'NodeLiteral') assert.fail('Expected NodeLiteral');
  assert.equal(event.value.structuralId, 'HEAD');
  assert.equal(event.value.children[0]?.type, 'TypedValue');
  if (event.value.children[0]?.type !== 'TypedValue') assert.fail('Expected headed child');
  assert.equal(event.value.children[0].structuralId, 'CHILD');
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
