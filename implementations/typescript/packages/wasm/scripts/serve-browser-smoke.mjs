#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = parsePort(process.argv.slice(2));
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname === '/' ? '/test/browser/index.html' : url.pathname;
    const file = resolve(packageRoot, `.${decodeURIComponent(pathname)}`);
    if (file !== packageRoot && !file.startsWith(`${packageRoot}${sep}`)) {
      respond(response, 403, 'text/plain; charset=utf-8', 'Forbidden\n');
      return;
    }
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error('not a file');
    response.writeHead(200, headers(mimeTypes.get(extname(file)) ?? 'application/octet-stream'));
    createReadStream(file).pipe(response);
  } catch {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not found\n');
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing server address');
  console.log(`AEON WASM browser smoke: http://127.0.0.1:${address.port}/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function parsePort(args) {
  const index = args.indexOf('--port');
  if (index < 0) return 4173;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return value;
}

function headers(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function respond(response, status, contentType, body) {
  response.writeHead(status, headers(contentType));
  response.end(body);
}
