import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('browser smoke entrypoints resolve from the served root', () => {
  const html = readFileSync(resolve(packageRoot, 'test/browser/index.html'), 'utf8');
  const scriptSource = /<script\s+type="module"\s+src="([^"]+)"/u.exec(html)?.[1];
  assert.ok(scriptSource, 'index.html must declare one module entrypoint');

  const servedUrl = new URL(scriptSource, 'http://127.0.0.1/');
  const mainModule = resolve(packageRoot, `.${servedUrl.pathname}`);
  assert.equal(existsSync(mainModule), true, `${servedUrl.pathname} must resolve inside the package`);

  const workerModule = resolve(dirname(mainModule), 'browser-smoke-worker.mjs');
  const wrapperModule = resolve(dirname(mainModule), '../../dist/index.js');
  assert.equal(existsSync(workerModule), true, 'worker module must exist');
  assert.equal(existsSync(wrapperModule), true, 'built TypeScript wrapper must exist');

  const mainSource = readFileSync(mainModule, 'utf8');
  const workerSource = readFileSync(workerModule, 'utf8');
  assert.match(mainSource, /new Worker\(new URL\('\.\/browser-smoke-worker\.mjs'/u);
  assert.match(mainSource, /from '\.\.\/\.\.\/dist\/index\.js'/u);
  assert.match(workerSource, /from '\.\.\/\.\.\/dist\/index\.js'/u);
});
