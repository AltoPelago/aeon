// Full-pipeline legacy compatibility timing. All variants use identical source.
import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';import {writeFileSync} from 'node:fs';
import {engine} from '../../../reference-parser-sharing/experiments/reference-parser-sharing/identity-canary.mjs';
import {execFileSync} from 'node:child_process';
const here=fileURLToPath(new URL('.',import.meta.url));
const aCore=await import(resolve(here,'.baseline/packages/core/dist/index.js'));
const bCore=await import(resolve(here,'../../implementations/typescript/packages/core/dist/index.js'));
const broadCore=await import(resolve(here,'../../../reference-parser-sharing/implementations/typescript/packages/core/dist/index.js'));
const broadCanon=await import(resolve(here,'../../../reference-parser-sharing/implementations/typescript/packages/canonical/dist/index.js'));
const aCanon=await import(resolve(here,'.baseline/packages/canonical/dist/index.js'));
const bCanon=await import(resolve(here,'../../implementations/typescript/packages/canonical/dist/index.js'));
const refs=(prefix,target)=>prefix+'\n'+Array.from({length:100},(_,i)=>`r${i} = ~>${target}`).join('\n');
const workloads={short:refs('source = { name = "v" }','source.name'),quoted:refs('"source.key" = { "nested.key" = "v" }','"source.key"["nested.key"]'),attributes:refs('source@{ metadata = { unit = "cm" } } = 1','source.@.metadata.unit'),noReferences:Array.from({length:100},(_,i)=>`r${i} = "v"`).join('\n'),oneReference:'source = "v"\nr = ~>source',invalid:'r = ~source.@.["missing"'};
workloads.deep='source = '+ '{ child = '.repeat(128)+'"v"'+' }'.repeat(128)+'\nr = ~>source'+'.child'.repeat(128);
const metrics=[];let sink=0;const options={maxAttributeDepth:8};
for(const [surface,a,b,control] of [['compile',aCore.compile,bCore.compile,broadCore.compile],['canonicalize',aCanon.canonicalize,bCanon.canonicalize,broadCanon.canonicalize]])for(const [name,source] of Object.entries(workloads)) {
 const errors=JSON.stringify(a(source,options).errors);if(errors!==JSON.stringify(b(source,options).errors)||errors!==JSON.stringify(control(source,{...options,referenceEngine:engine}).errors))throw new Error(`Diagnostic drift ${surface}/${name}`);
 const fns={baseline:()=>a(source,options),candidate:()=>b(source,options),profile:()=>control(source,{...options,referenceEngine:engine})};
 for(let i=0;i<100;i++)for(const f of Object.values(fns))f();
 const calibration=performance.now();for(let i=0;i<30;i++)fns.baseline();
 const iterations=Math.max(20,Math.min(1000,Math.ceil(20/((performance.now()-calibration)/30))));
 const batches={baseline:[],candidate:[],profile:[]};const labels=Object.keys(fns);
 for(let round=0;round<11;round++)for(const label of [...labels.slice(round%3),...labels.slice(0,round%3)]){
  const start=performance.now();for(let i=0;i<iterations;i++){const r=fns[label]();sink+=r.errors.length+(r.text?.length??r.events.length);}
  batches[label].push((performance.now()-start)/iterations);
 }
 const heap={};
 for(const variant of labels)heap[variant]=JSON.parse(execFileSync(process.execPath,['--expose-gc',resolve(here,'pipeline-memory.mjs'),surface,variant],{env:{...process.env,SPIKE_MEMORY_SOURCE:source},encoding:'utf8'})).delta;
 const median=a=>[...a].sort((a,b)=>a-b)[5];metrics.push({surface,name,iterations,batches,heap,baselineMs:median(batches.baseline),candidateMs:median(batches.candidate),profileMs:median(batches.profile),candidateRatio:median(batches.candidate)/median(batches.baseline),profileRatio:median(batches.profile)/median(batches.baseline)});
}
const out={profileScope:'retained broader artifact, not narrow reference support',node:process.version,method:'Identical valid or malformed legacy source. 100 warmups, 11 rotating three-variant batches, adaptive baseline-calibrated iterations for >=20ms nominal batches. Not a timing comparison for new alias syntax.',metrics,sink};
writeFileSync(resolve(here,process.argv[2]??'pipeline-timing.results.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(metrics.map(({surface,name,candidateRatio,profileRatio})=>({surface,name,candidateRatio,profileRatio}))));
