#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCTSPath } from './repo-paths.mjs';

function parseArgs(argv) {
  const result = { sut: '', cts: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--sut') result.sut = argv[++index] ?? '';
    else if (argv[index] === '--cts') result.cts = argv[++index] ?? '';
  }
  return result;
}

function frameOptions(input) {
  return {
    ...(Number.isInteger(input.max_frame_bytes) ? { maxFrameBytes: input.max_frame_bytes } : {}),
    ...(Number.isInteger(input.max_buffer_bytes) ? { maxBufferBytes: input.max_buffer_bytes } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sut || !args.cts) throw new Error('Usage: transport-cts-runner --sut <module> --cts <manifest>');
  const sutPath = path.resolve(process.cwd(), args.sut);
  const sut = await import(pathToFileURL(sutPath).href);
  const manifestPath = resolveCTSPath(args.cts, process.cwd());
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let passed = 0;
  let failed = 0;

  for (const suiteRef of manifest.suites ?? []) {
    const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
    console.log(`\n--- Suite: ${suite.title} ---`);
    for (const test of suite.tests ?? []) {
      let errorCode = null;
      let result = {};
      try {
        const input = test.input ?? {};
        if (input.operation === 'encode_frame') {
          const encoded = sut.encodeFrame(String(input.payload ?? ''), frameOptions(input));
          result = { encoded_bytes: encoded.length };
        } else if (input.operation === 'decode_frame') {
          const decoded = sut.decodeFrame(Uint8Array.from(input.buffer ?? []), frameOptions(input));
          result = { frame_bytes: decoded?.frame.length ?? null };
        } else if (input.operation === 'decoder_push') {
          const decoder = new sut.FrameDecoder(frameOptions(input));
          const frames = decoder.push(Uint8Array.from(input.chunk ?? []));
          result = { frame_count: frames.length };
        } else if (input.operation === 'inspect_header') {
          const inspected = sut.inspectHeader(String(input.source ?? ''), {
            maxHeaderBytes: input.max_header_bytes,
          });
          errorCode = inspected.errors[0]?.code ?? null;
          result = { header_error_count: inspected.errors.length };
        } else {
          throw new Error(`Unsupported operation ${String(input.operation)}`);
        }
      } catch (error) {
        errorCode = typeof error?.code === 'string' ? error.code : 'HARNESS_ERROR';
      }

      const expectedCode = test.expected?.error_code ?? null;
      const expectedResult = test.expected?.result ?? {};
      const ok = errorCode === expectedCode
        && Object.entries(expectedResult).every(([key, value]) => JSON.stringify(result[key]) === JSON.stringify(value));
      if (ok) {
        passed += 1;
        console.log(`✅ ${test.id}: PASS`);
      } else {
        failed += 1;
        console.log(`❌ ${test.id}: FAIL`);
        console.log(`   expected error=${JSON.stringify(expectedCode)} result=${JSON.stringify(expectedResult)}`);
        console.log(`   actual error=${JSON.stringify(errorCode)} result=${JSON.stringify(result)}`);
      }
    }
  }

  console.log(`\nSummary: pass=${passed} fail=${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
});
