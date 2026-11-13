// Copy experimental SANSA source into this checkout's PRIVATE dependency graph.
// Re-run after source edits. Never changes primary SANSA or a global package store.
import { realpathSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const source = resolve(process.argv[2] ?? resolve(root, '../../sansa/reference-path-only'));
const destination = realpathSync(resolve(root, 'implementations/typescript/packages/parser/node_modules/@altopelago/sansa'));
if (!destination.startsWith(resolve(root, 'implementations/typescript/node_modules') + sep)) throw new Error('Dependency is not private');
rmSync(resolve(destination, 'src'), {recursive:true,force:true});
cpSync(resolve(source, 'src'), resolve(destination, 'src'), { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(destination, 'package.json'), 'utf8'));
const sourceManifest = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
manifest.version = sourceManifest.version;
manifest.exports = sourceManifest.exports;
manifest.imports = sourceManifest.imports;
writeFileSync(resolve(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ source, destination }));
