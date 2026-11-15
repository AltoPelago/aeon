#!/usr/bin/env node
// Local-only development UI. Serve workspace modules, never a published bundle.
import {createServer} from 'node:http';
import {existsSync, readFileSync, readdirSync, realpathSync, watch} from 'node:fs';
import {readFile, realpath, stat} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

export const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const aliases = {runtime:'aeon-runtime', profiles:'aeon-profiles', core:'aeon-core', aes:'aeon-aes',
  tonic:'aeon-tonic', finalize:'aeon-finalize', lexer:'aeon-lexer', parser:'aeon-parser',
  'annotation-stream':'aeon-annotation-stream', canonical:'aeon-canonical'};
const types = {'.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.map':'application/json', '.ts':'text/plain', '.wasm':'application/wasm'};

export function playgroundModules(repoRoot = defaultRoot) {
  const packages = join(repoRoot, 'implementations/typescript/packages');
  const imports = {}, roots = new Map();
  for (const dir of readdirSync(packages, {withFileTypes:true})) {
    if (!dir.isDirectory()) continue;
    const pkgRoot = join(packages, dir.name), manifest = join(pkgRoot, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    roots.set(dir.name, pkgRoot);
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      const entry = typeof target === 'string' ? target : target?.import;
      if (typeof entry !== 'string' || !entry.startsWith('./dist/')) continue;
      imports[pkg.name + (key === '.' ? '' : key.slice(1))] = `/aeon/${dir.name}/${entry.slice(2)}`;
    }
  }
  const sansa = realpathSync(join(packages, 'parser/node_modules/@altopelago/sansa'));
  const manifest = JSON.parse(readFileSync(join(sansa, 'package.json'), 'utf8'));
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    const entry = typeof target === 'string' ? target : target?.import;
    if (typeof entry === 'string' && entry.startsWith('./src/')) {
      imports[manifest.name + (key === '.' ? '' : key.slice(1))] = `/sansa/${entry.slice(2)}`;
    }
  }
  for (const [alias, name] of Object.entries(aliases)) imports[`@aeon/${alias}`] = imports[`@altopelago/${name}`];
  imports['@aeos/core'] = imports['@altopelago/aeos-core'];
  for (const name of ['@aeon/runtime', '@aeon/canonical', '@altopelago/sansa']) {
    if (!imports[name]) throw new Error(`Missing browser entry point: ${name}`);
  }
  return {imports, roots, sansa:join(sansa, 'src')};
}

export function createPlaygroundServer({repoRoot = defaultRoot, buildState = {revision:0, building:false, error:null}} = {}) {
  const modules = playgroundModules(repoRoot), ui = join(repoRoot, 'tools/playground');
  return createServer(async (request, response) => {
    const reply = (status, body, type = 'text/plain', extra = {}) => {
      response.writeHead(status, {'content-type':`${type}; charset=utf-8`, 'cache-control':'no-store', 'x-content-type-options':'nosniff', ...extra});
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Use GET or HEAD.', 'text/plain', {allow:'GET, HEAD'});
    try {
      const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return reply(403, 'Local requests only.');
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/__playground/status') return reply(200, JSON.stringify(buildState), 'application/json');
      if (pathname === '/' || pathname === '/tools/playground/' || pathname === '/tools/playground/index.html') {
        let html = (await readFile(join(ui, 'index.html'), 'utf8')).replace('__PLAYGROUND_IMPORTS__', () => JSON.stringify({imports:modules.imports}).replaceAll('<', '\\u003c'));
        if (html.includes('__PLAYGROUND_EXAMPLES__')) {
          const examples = JSON.parse(await readFile(join(ui, 'examples.json'), 'utf8'));
          html = html.replace('__PLAYGROUND_EXAMPLES__', () => JSON.stringify(examples).replaceAll('<', '\\u003c'));
        }
        return reply(200, html, 'text/html');
      }
      let root, relative;
      if (pathname.startsWith('/tools/playground/')) {
        root = ui; relative = pathname.slice('/tools/playground/'.length);
      } else if (pathname.startsWith('/sansa/src/')) {
        root = modules.sansa; relative = pathname.slice('/sansa/src/'.length);
      } else if (pathname.startsWith('/aeon/')) {
        const match = /^\/aeon\/([a-z0-9-]+)\/(dist|src)\/(.+)$/.exec(pathname);
        if (!match || !modules.roots.has(match[1])) return reply(404, 'Not found.');
        root = join(modules.roots.get(match[1]), match[2]); relative = match[3];
      } else return reply(404, 'Not found.');
      if (buildState.building && root !== ui) return reply(503, 'Workspace is rebuilding. Retry after completion.');
      const file = await realpath(resolve(root, relative)), allowedRoot = await realpath(root);
      if (!file.startsWith(allowedRoot + sep) || !(await stat(file)).isFile()) return reply(403, 'Forbidden.');
      const type = types[extname(file)];
      if (!type) return reply(404, 'Not found.');
      return reply(200, await readFile(file), type);
    } catch (error) {
      return reply(error instanceof URIError || error instanceof TypeError ? 400 : 404, 'Not found.');
    }
  });
}

export function buildWorkspace(repoRoot = defaultRoot) {
  return new Promise((fulfil, reject) => {
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@altopelago/aeon-runtime...', '--filter', '@altopelago/aeon-canonical...', '--filter', '@altopelago/aeon-sdk...', 'build'],
      {cwd:join(repoRoot, 'implementations/typescript'), stdio:'inherit'});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? fulfil() : reject(new Error(`Workspace build failed (${signal ?? code}).`)));
  });
}

export function watchWorkspace(repoRoot, rebuild, onError = console.error) {
  const packages = join(repoRoot, 'implementations/typescript/packages'), watchers = [];
  let timer, running = false, pending = false, closed = false;
  const run = async () => {
    if (closed) return;
    if (running) { pending = true; return; }
    running = true;
    try { await rebuild(); } catch (error) { onError(error); }
    finally { running = false; if (pending && !closed) { pending = false; schedule(); } }
  };
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(run, 300); };
  try {
    for (const dir of readdirSync(packages, {withFileTypes:true}).filter(d => d.isDirectory())) {
      const root = join(packages, dir.name), src = join(root, 'src');
      if (existsSync(src)) watchers.push(watch(src, {recursive:true}, schedule));
      watchers.push(watch(root, (_event, file) => { if (file === 'tsconfig.json') schedule(); }));
    }
    watchers.push(watch(join(repoRoot, 'implementations/typescript'), (_event, file) => {
      if (file === 'tsconfig.base.json') schedule();
    }));
    for (const watcher of watchers) watcher.on('error', onError);
  } catch (error) { for (const watcher of watchers) watcher.close(); throw error; }
  return () => { closed = true; clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
}

async function main(args) {
  let port = 4175, build = true, watching = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '')) throw new Error('--port requires an integer from 0 to 65535.');
      port = Number(value);
    } else if (args[i] === '--no-build') build = false;
    else if (args[i] === '--no-watch') watching = false;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  if (!existsSync(join(defaultRoot, 'implementations/typescript/node_modules/typescript'))) {
    throw new Error('Install workspace dependencies first: pnpm --dir implementations/typescript install --frozen-lockfile');
  }
  if (build) await buildWorkspace();
  for (const file of ['runtime/dist/index.js', 'canonical/dist/index.js', 'sdk/dist/sansa.js']) {
    if (!existsSync(join(defaultRoot, 'implementations/typescript/packages', file))) throw new Error(`Missing workspace build: ${file}. Run npm run playground without --no-build.`);
  }
  const state = {revision:Date.now(), building:false, watching:false, error:null};
  const server = createPlaygroundServer({buildState:state});
  let closeWatch = () => {};
  server.on('error', error => { closeWatch(); console.error(error.message); process.exitCode = 1; });
  server.on('close', () => closeWatch());
  server.listen(port, '127.0.0.1', () => {
    console.log(`AEON source playground: http://127.0.0.1:${server.address().port}/tools/playground/`);
    console.log(`Workspace: ${defaultRoot}\nRuntime: local TypeScript; SANSA: installed workspace dependency. No publication or deployment.`);
    if (watching) {
      try {
        closeWatch = watchWorkspace(defaultRoot, async () => {
          state.building = true; state.error = null;
          try { await buildWorkspace(); state.revision++; }
          catch (error) { state.error = 'Build failed. See terminal; the last successful runtime is stale.'; throw error; }
          finally { state.building = false; }
        });
        state.watching = true;
      } catch (error) { state.error = 'Source watch failed. Restart after rebuilding.'; console.error(error.message); }
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { closeWatch(); server.close(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
