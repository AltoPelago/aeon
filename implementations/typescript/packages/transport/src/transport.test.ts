import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
    encodeFrame,
    decodeFrame,
    FrameDecoder,
    createFrameDecoderStream,
    createFrameEncoderStream,
    inspectHeader,
} from './index.js';

test('encodes and decodes a frame', () => {
    const framed = encodeFrame('hello');
    const decoded = decodeFrame(framed);
    assert.ok(decoded);
    const text = new TextDecoder().decode(decoded?.frame ?? new Uint8Array());
    assert.equal(text, 'hello');
});

test('FrameDecoder handles chunked input', () => {
    const framed = encodeFrame('chunked');
    const decoder = new FrameDecoder();
    const first = decoder.push(framed.slice(0, 3));
    assert.equal(first.length, 0);
    const second = decoder.push(framed.slice(3));
    assert.equal(second.length, 1);
    const text = new TextDecoder().decode(second[0]!);
    assert.equal(text, 'chunked');
});

test('FrameDecoder enforces buffer limits', () => {
    const decoder = new FrameDecoder({ maxBufferSize: 4 });
    assert.throws(() => decoder.push(new Uint8Array([1, 2, 3, 4, 5])), /BUFFER_TOO_LARGE/);
});

test('inspectHeader reads header fields', () => {
    const input = `aeon:version = "2.0"\naeon:mode = "strict"\na = 1`;
    const result = inspectHeader(input);
    assert.equal(result.header.version, '2.0');
    assert.equal(result.header.mode, 'strict');
});

test('inspectHeader defaults encoding to utf-8 when omitted', () => {
    const input = `aeon:version = "2.0"\na = 1`;
    const result = inspectHeader(input);
    assert.equal(result.header.encoding, 'utf-8');
});

test('inspectHeader handles structured header', () => {
    const input = `aeon:header = {
  version = "2.0"
  profile = "core"
}
value = 1`;
    const result = inspectHeader(input);
    assert.equal(result.header.version, '2.0');
    assert.equal(result.header.profile, 'core');
});

test('inspectHeader parses spaced assignment fields without regex backtracking', () => {
    const input = `aeon:encoding   =   "utf-16"\naeon:profile = "core"\na = 1`;
    const result = inspectHeader(input);
    assert.equal(result.header.encoding, 'utf-16');
    assert.equal(result.header.profile, 'core');
});

test('frame encoder/decoder streams roundtrip', async () => {
    const encoder = createFrameEncoderStream();
    const decoder = createFrameDecoderStream();
    const input = new PassThrough();
    const output: Buffer[] = [];
    const collect = new PassThrough({ objectMode: true });
    collect.on('data', (chunk) => output.push(Buffer.from(chunk as Uint8Array)));
    input.pipe(encoder).pipe(decoder).pipe(collect);
    input.write('a = 1');
    input.write('b = 2');
    input.end();
    await new Promise<void>((resolve) => collect.on('end', () => resolve()));
    assert.equal(output.length, 2);
    assert.equal(output[0]?.toString('utf-8'), 'a = 1');
    assert.equal(output[1]?.toString('utf-8'), 'b = 2');
});
