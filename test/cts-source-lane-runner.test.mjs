import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/cts-source-lane-runner.mjs', import.meta.url));

function runFixtures(t, lane, fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'aeon-source-lane-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const suite = join(dir, 'suite.json');
  const manifest = join(dir, 'manifest.json');
  const sut = join(dir, 'sut.mjs');
  const tests = fixtures.map(({ id, expected }) => ({ id, input: { source: id }, expected }));
  writeFileSync(suite, JSON.stringify({ title: 'Source lane controls', tests }));
  writeFileSync(manifest, JSON.stringify({
    meta: { sut_protocol: 'cts.protocol.v1', lane },
    suites: [{ file: 'suite.json' }],
  }));
  const responses = Object.fromEntries(fixtures.map(({ id, actual }) => [id, actual]));
  writeFileSync(sut, `
    import { readFileSync } from 'node:fs';
    const responses = ${JSON.stringify(responses)};
    console.log(JSON.stringify(responses[readFileSync(process.argv[3], 'utf8')]));
  `);

  const result = spawnSync(process.execPath, [runner, '--sut', sut, '--cts', manifest, '--lane', lane], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return result.stdout;
}

test('AES runner fails a rejection that returned an assignment event', (t) => {
  const errors = [{ code: 'MISSING_REFERENCE_TARGET', path: '$' }];
  const expected = { ok: false, errors, result: { events: [] } };
  const leaked = { path: '$.a', kind: 'NumberLiteral', value: '1' };
  const output = runFixtures(t, 'aes', [
    { id: 'clean-rejection', expected, actual: { errors, events: [] } },
    { id: 'leaking-rejection', expected, actual: { errors, events: [leaked] } },
    {
      id: 'leaking-without-event-expectation',
      expected: { ok: false, errors },
      actual: { errors, events: [leaked] },
    },
  ]);
  assert.match(output, /clean-rejection: PASS/u);
  assert.match(output, /leaking-rejection: FAIL\n   - expected no AES events on rejection, got 1/u);
  assert.match(output, /leaking-without-event-expectation: FAIL\n   - expected no AES events on rejection, got 1/u);
});

test('Core runner preserves whitespace after escaped quotes inside datatype clarifiers', (t) => {
  const datatype = String.raw`grid["a\" b",'c\' d',"e\\",'f  g']`;
  const expected = { ok: true, result: { bindings: [{ path: '$.a', datatype, kind: 'binding' }] } };
  const actual = (signature) => ({ errors: [], events: [{ path: '$.a', datatype: signature }] });
  const output = runFixtures(t, 'core', [
    {
      id: 'outside-spacing',
      expected,
      actual: actual(String.raw` grid [ "a\" b" , 'c\' d' , "e\\" , 'f  g' ] `),
    },
    { id: 'double-quoted-spacing', expected, actual: actual(datatype.replace(' b', 'b')) },
    { id: 'single-quoted-spacing', expected, actual: actual(datatype.replace(' d', 'd')) },
    { id: 'repeated-spacing', expected, actual: actual(datatype.replace('  g', ' g')) },
  ]);
  assert.match(output, /outside-spacing: PASS/u);
  assert.match(output, /double-quoted-spacing: FAIL\n   - bindings\[0\]\.datatype mismatch/u);
  assert.match(output, /single-quoted-spacing: FAIL\n   - bindings\[0\]\.datatype mismatch/u);
  assert.match(output, /repeated-spacing: FAIL\n   - bindings\[0\]\.datatype mismatch/u);
});
