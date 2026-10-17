#!/usr/bin/env node
// Public CLI parity for escaped keys, attributes, node paths, and references.
// Requires the TypeScript and Rust CLIs to be built; Python needs 3.12+.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getRepoRoot } from './repo-paths.mjs';

const root = getRepoRoot();
const keys = [...Array(32).keys()].flatMap(code => {
  const character = String.fromCharCode(code);
  return [`z${character}`, `${character}z`, `z${character}key`];
}).concat(['z"', 'z\\', 'z\\n', 'z\\t', 'z\\u0000', 'z\\"', 'z"].other', 'z.@.other', 'z[0]', 'z😀', 'z\u2028', 'z\u2029']);
const quoted = keys.map(key => JSON.stringify(key));
const sources = [
  quoted.map((key, i) => `${key}=${i}`).join('\n') + '\n'
    + quoted.map((key, i) => `copy${i}=~[${key}]\npointer${i}=~>[${key}]`).join('\n'),
  `a={${quoted.map((key, i) => `${key}=${i}`).join(',')}}\n`
    + quoted.map((key, i) => `copy${i}=~a.[${key}]`).join('\n'),
  `a@{${quoted.map((key, i) => `${key}=${i}`).join(',')}}=0\n`
    + quoted.map((key, i) => `copy${i}=~a.@.[${key}]`).join('\n'),
  `a@{m={${quoted.map((key, i) => `${key}=${i}`).join(',')}}}=0\n`
    + quoted.map((key, i) => `copy${i}=~a.@.m.[${key}]`).join('\n'),
  quoted.map(key => `${key}=<outer(<inner("leaf")>)>`).join('\n') + '\n'
    + quoted.map((key, i) => `copy${i}=~[${key}][0][0]`).join('\n'),
  `aeon:header={${quoted.map((key, i) => `${key}=${i}`).join(',')}}\n`
    + keys.map((key, i) => `copy${i}=~[${JSON.stringify(`aeon:${key}`)}]`).join('\n'),
];
const backends = {
  typescript: ['node', path.join(root, 'implementations/typescript/packages/cli/dist/main.js')],
  python: [path.join(root, 'implementations/python/bin/aeon-python')],
  rust: [path.join(root, 'implementations/rust/target/debug/aeon-rust')],
};
const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-core-path-parity-'));
const fixtures = [];
try {
  let events = 0;
  for (const [index, source] of sources.entries()) {
    const fixture = path.join(taskDir, `case-${index}.aeon`);
    fixtures.push(fixture);
    fs.writeFileSync(fixture, source);
    let expected;
    for (const [backend, [command, ...args]] of Object.entries(backends)) {
      const result = JSON.parse(execFileSync(command, [
        ...args, 'inspect', fixture, '--json', '--portable-aes', '--include-headers', '--source-provenance',
      ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      assert.deepEqual(result.errors, [], `${backend} context ${index}`);
      // Legacy adapters retain different provenance (Rust omits some child
      // spans). Compare semantic records, never normalize or decode paths.
      const records = result.events.map(({ origin: _origin, span: _span, ...record }) => record);
      if (expected === undefined) {
        assert.ok(records.length > 0, `context ${index} must exercise actual output`);
        expected = records;
        events += records.length;
      } else {
        assert.deepEqual(records, expected, `${backend} context ${index}: exact portable records`);
      }
    }
  }
  console.log(`Core path parity: ${sources.length} contexts × ${keys.length} escaped keys; ${events} exact records per backend; TypeScript/Python/Rust passed`);
} finally {
  for (const fixture of fixtures) if (fs.existsSync(fixture)) fs.unlinkSync(fixture);
  fs.rmdirSync(taskDir);
}
