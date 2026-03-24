import { runRuntime } from './packages/runtime/src/runtime.ts';

const aeonInput = `
test: {
    __proto__: {
        polluted: "yes"
    }
}
`;

console.log("Before parsing, polluted:", ({} as any).polluted);

const result = runRuntime(aeonInput);

console.log("After parsing, polluted:", ({} as any).polluted);
console.log("Result document:", result.document);
