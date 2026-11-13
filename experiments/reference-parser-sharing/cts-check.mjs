import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../..');
const cts=process.argv[2]??resolve(root,'../../../aeonite-org/aeonite-cts');
const path=resolve(cts,'cts/core/v1/suites/03-attributes-and-references.json');
const suite=JSON.parse(readFileSync(path,'utf8'));
const a=await import(resolve(here,'.baseline/packages/core/dist/index.js'));
const b=await import(resolve(root,'implementations/typescript/packages/core/dist/index.js'));
const results=suite.tests.map(test=>{
 // Source-lane runner uses options.effective_mode, not the fixture's legacy input.mode,
 // for effective Core typing mode. Do not turn legacy "strict" projection into typed source.
 const options={...(test.input.options?.effective_mode?{mode:test.input.options.effective_mode}:{}),...(test.input.options?.max_attribute_depth!==undefined?{maxAttributeDepth:test.input.options.max_attribute_depth}:{})};
 const baseline=a.compile(test.input.source,options),candidate=b.compile(test.input.source,options);
 const codes=x=>x.errors.map(e=>e.code).sort();
 assert.deepEqual(codes(candidate),codes(baseline),test.id);
 assert.equal(!candidate.errors.length,test.expected.ok,test.id);
 const expectedCodes=test.expected.errors.map(e=>e.code).sort();
 return {id:test.id,ok:test.expected.ok,codes:codes(candidate),expectedCodes,
  exactExpectedCodes:JSON.stringify(codes(candidate))===JSON.stringify(expectedCodes),
  baselineCandidateParity:true,expectedAcceptance:true};
});
writeFileSync(resolve(here,'cts.results.json'),JSON.stringify({date:'2026-10-18',suite:path,ctsCommit:execFileSync('git',['-C',cts,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),method:'Direct Core baseline/candidate error-code parity and expected acceptance checks. Exact expected-code discrepancies are recorded, not hidden; not the full CTS protocol/projection or a complete CTS pass claim.',results},null,2));
console.log(`${results.length} cases preserve baseline behavior/expected acceptance; ${results.filter(x=>!x.exactExpectedCodes).length} pre-existing exact diagnostic-list differences from fixture expectation.`);
