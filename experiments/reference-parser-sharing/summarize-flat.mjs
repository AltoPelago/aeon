import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const read=f=>JSON.parse(readFileSync(new URL(f,import.meta.url),'utf8'));
const approved=read('approved-deltas.json').sort();
const parser=[1,2,3,4].map(i=>{
 const file=`candidate-b-path-only-flat-${i}.results.json`,r=read(file);
 const actual=r.differences.map(d=>d.name).sort();
 const compatibility=JSON.stringify(actual)===JSON.stringify(approved)&&r.counts.parseCases===396&&r.counts.identical===356&&r.counts.endToEndComparisons===68&&r.endToEnd.length===0&&r.differences.every(d=>d.candidate.errors.some(e=>e.code==='SYNTAX_ERROR'));
 return {file,compatibility,counts:r.counts,order:r.workloadOrder,metrics:r.metrics.map(m=>({name:m.name,latency:m.ratio,lexParse:m.lexParseRatio,heap:m.retainedHeapBytes.candidate/m.retainedHeapBytes.baseline}))};
});
const pipeline=[1,2].map(i=>{
 const file=`path-only-flat-pipeline-${i}.results.json`,r=read(file);
 return {file,profileScope:r.profileScope,metrics:r.metrics.map(m=>({surface:m.surface,name:m.name,latency:m.candidateRatio,heap:m.heap.candidate/m.heap.baseline,broaderControlLatency:m.profileRatio,broaderControlHeap:m.heap.profile/m.heap.baseline}))};
});
const gates={compatibility:parser.every(r=>r.compatibility),parserLatency:parser.every(r=>r.metrics.every(m=>m.latency<=1.15)),parserHeap:parser.every(r=>r.metrics.every(m=>m.heap<=1.2)),pipelineLatency:pipeline.every(r=>r.metrics.every(m=>m.latency<=1.15)),pipelineHeap:pipeline.every(r=>r.metrics.every(m=>m.heap<=1.2))};
const failures=[...parser,...pipeline].flatMap(r=>r.metrics.filter(m=>m.latency>1.15||m.heap>1.2).map(m=>({file:r.file,...m})));
const report={budgets:{latency:1.15,retainedResultHeap:1.2,changed:false},accepted:Object.values(gates).every(Boolean),gates,failures,parser,pipeline,aliasScope:'Identity aliases are unsupported by the narrow contract. Original workloads/checks and their accepted source-specific results remain in the isolated broader artifact; they are not a narrow capability or performance pass.',broaderEvidence:'../../../reference-parser-sharing/experiments/reference-parser-sharing/parser-value-dispatch.results.json'};
writeFileSync(new URL('flat-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({accepted:report.accepted,gates,failures}));
