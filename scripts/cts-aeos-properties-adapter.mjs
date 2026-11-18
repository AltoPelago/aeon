#!/usr/bin/env node
// Development JSON-lines adapter. Selection and validation stay in owning APIs.
import {createInterface} from 'node:readline';
import {validate, validateTelex, validateTelexRecords} from '../implementations/typescript/packages/aeos/dist/index.js';
import {encodeTelex} from '../implementations/typescript/packages/aes/dist/index.js';

for await (const line of createInterface({input:process.stdin})) {
  try {
    const request = JSON.parse(line);
    const before = JSON.stringify(request);
    let result;
    if (request.entrypoint === 'legacy') result = validate([], request.schema, request.options);
    else if (request.entrypoint !== 'portable') throw Error('Unsupported entrypoint');
    else if (request.representation === 'records') result = validateTelexRecords(request.records, request.schema, request.options);
    else if (request.representation === 'telex') result = validateTelex(encodeTelex(request.records), request.schema, request.options);
    else throw Error('Unsupported representation');
    console.log(JSON.stringify({result, inputUnchanged:JSON.stringify(request) === before}));
  } catch {
    console.log(JSON.stringify({error:'adapter_failure'}));
    process.exitCode = 1;
  }
}
