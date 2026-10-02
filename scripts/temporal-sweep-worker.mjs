// Persistent test-only worker; protocol output is consumed by temporal-sweep.py.
import readline from 'node:readline';
import { compile } from '../implementations/typescript/packages/core/dist/index.js';

console.log(JSON.stringify({ ready: true }));
for await (const line of readline.createInterface({ input: process.stdin })) {
    const cases = JSON.parse(line);
    const mismatches = [];
    let accepted = 0;
    for (const [index, [literal, expected]] of cases.entries()) {
        const result = compile(`aeon:mode = "strict"\nv:datetime = ${literal}`);
        const actual = result.errors.length === 0;
        accepted += Number(actual);
        if (actual !== expected) {
            mismatches.push([index, actual, result.errors.map(error => error.code)]);
        }
    }
    console.log(JSON.stringify({ checked: cases.length, accepted, mismatches }));
}
