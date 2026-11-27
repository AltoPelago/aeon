import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCTSPath } from './repo-paths.mjs';

const script = pathname => fileURLToPath(new URL(pathname, import.meta.url));
const cli = script('../implementations/typescript/packages/cli/dist/main.js');
for (const [area, lane] of [['core', 'core'], ['aes', 'inspect-json'], ['canonical', 'canonical']]) {
    const cts = resolveCTSPath(`cts/${area}/v1/${area}-node-model-revision-cts.v1.next.json`);
    execFileSync(process.execPath, [script('./cts-source-lane-runner.mjs'), '--sut', cli, '--cts', cts, '--lane', lane], { stdio: 'inherit' });
}
execFileSync(process.execPath, [
    script('../implementations/typescript/tools/sansa-resolve-cts-runner/dist/index.js'),
    '--cts', resolveCTSPath('cts/sansa/v1/sansa-node-model-revision-cts.v1.next.json'),
], { stdio: 'inherit' });
