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
  const tests = fixtures.map(({ id, options, expected }) => ({ id, input: { source: id, options }, expected }));
  writeFileSync(suite, JSON.stringify({ title: 'Source lane controls', tests }));
  writeFileSync(manifest, JSON.stringify({
    meta: { sut_protocol: 'cts.protocol.v1', lane },
    suites: [{ file: 'suite.json' }],
  }));
  const responses = Object.fromEntries(fixtures.map(({ id, actual }) => [id, actual]));
  writeFileSync(sut, `
    import { readFileSync } from 'node:fs';
    const responses = ${JSON.stringify(responses)};
    const response = responses[readFileSync(process.argv[3], 'utf8')];
    if (process.argv[2] === 'fmt') {
      if (process.argv[4] !== '--max-value-nesting-depth' || process.argv[5] !== '0') {
        process.exit(2);
      }
      process.stdout.write(response.stdout);
      process.exitCode = response.code;
    } else {
      console.log(JSON.stringify(response));
    }
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

test('Canonical runner forwards depth zero and checks partial output on rejection', (t) => {
  const options = { max_value_nesting_depth: 0 };
  const expected = { ok: false, errors: [{ code: 'NESTING_DEPTH_EXCEEDED' }], result: { canonical_text: '' } };
  const diagnostic = '[NESTING_DEPTH_EXCEEDED] Value exceeds the nesting limit\n';
  const output = runFixtures(t, 'canonical', [
    { id: 'clean-rejection', options, expected, actual: { stdout: diagnostic, code: 1 } },
    { id: 'partial-rejection', options, expected, actual: { stdout: 'x = 123\n' + diagnostic, code: 1 } },
  ]);
  assert.match(output, /clean-rejection: PASS/u);
  assert.match(output, /partial-rejection: FAIL\n   - canonical_text mismatch: expected "", got "x = 123"/u);
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

test('Core runner separates backtick clarifier payload from surrounding layout', (t) => {
  const fixture = (id, datatype, actualDatatype) => ({
    id,
    expected: { ok: true, result: { bindings: [{ path: '$.a', datatype, kind: 'binding' }] } },
    actual: { errors: [], events: [{ path: '$.a', datatype: actualDatatype }] },
  });
  const output = runFixtures(t, 'core', [
    fixture('raw-embedded-quote', 'custom[`a"b` ]', 'custom[`a"b`]'),
    fixture('raw-escaped-backtick', 'custom[`a\\` b` ]', 'custom[`a\\` b`]'),
    fixture('raw-multiline-spacing', 'custom[`a  b\nc`]', 'custom[`a b\nc`]'),
    fixture('raw-escaped-backtick-spacing', 'custom[`a\\` b`]', 'custom[`a\\`b`]'),
  ]);
  assert.match(output, /raw-embedded-quote: PASS/u);
  assert.match(output, /raw-escaped-backtick: PASS/u);
  assert.match(output, /raw-multiline-spacing: FAIL\n   - bindings\[0\]\.datatype mismatch/u);
  assert.match(output, /raw-escaped-backtick-spacing: FAIL\n   - bindings\[0\]\.datatype mismatch/u);
});
