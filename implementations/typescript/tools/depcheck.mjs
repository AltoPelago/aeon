import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.cwd());

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function listPackageJsons(baseDir) {
  const abs = resolve(root, baseDir);
  const dirs = readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory());
  return dirs.map((d) => join(abs, d.name, 'package.json'));
}

const packageManifests = listPackageJsons('packages');
const toolManifests = listPackageJsons('tools');

const nodes = [];
for (const file of [...packageManifests, ...toolManifests]) {
  const manifest = readJson(file);
  const rel = file.replace(`${root}/`, '');
  const workspaceType = rel.startsWith('packages/') ? 'package' : 'tool';
  const deps = Object.keys(manifest.dependencies ?? {});
  nodes.push({
    name: manifest.name,
    file: rel,
    workspaceType,
    deps,
  });
}

const byName = new Map(nodes.map((n) => [n.name, n]));
const toolNames = new Set(nodes.filter((n) => n.workspaceType === 'tool').map((n) => n.name));
const problems = [];

for (const node of nodes) {
  if (node.workspaceType === 'package') {
    for (const dep of node.deps) {
      if (toolNames.has(dep)) {
        problems.push(`${node.name} must not depend on tooling package ${dep}`);
      }
      if (dep === '@altopelago/aeon-runtime') {
        problems.push(`${node.name} must not depend on @altopelago/aeon-runtime`);
      }
    }
  }
}

const tripwires = [
  ['@altopelago/aeon-aes', '@altopelago/aeon-finalize', '@altopelago/aeon-aes must not import/depend on @altopelago/aeon-finalize'],
  ['@altopelago/aeos-core', '@altopelago/aeon-tonic', '@altopelago/aeos-core must not import/depend on @altopelago/aeon-tonic'],
  ['@altopelago/aeon-finalize', '@altopelago/aeon-lexer', '@altopelago/aeon-finalize must not import/depend on @altopelago/aeon-lexer'],
  ['@altopelago/aeon-finalize', '@altopelago/aeon-parser', '@altopelago/aeon-finalize must not import/depend on @altopelago/aeon-parser'],
];

for (const [from, to, message] of tripwires) {
  const source = byName.get(from);
  if (source && source.deps.includes(to)) {
    problems.push(message);
  }
}

if (problems.length > 0) {
  console.error('Dependency graph check failed:');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log(`Dependency graph checks passed for ${nodes.length} workspace packages/tools.`);
