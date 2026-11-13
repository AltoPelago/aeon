import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../..');
const current=resolve(root,'implementations/typescript/packages'),baseline=resolve(here,'.baseline/packages');
const {tokenize}=await import(resolve(current,'lexer/dist/index.js'));
const a=await import(resolve(baseline,'parser/dist/index.js')),b=await import(resolve(current,'parser/dist/index.js'));
const ac=await import(resolve(baseline,'core/dist/index.js')),bc=await import(resolve(current,'core/dist/index.js'));
const az=await import(resolve(baseline,'canonical/dist/index.js')),bz=await import(resolve(current,'canonical/dist/index.js'));
const af=await import(resolve(baseline,'finalize/dist/index.js')),bf=await import(resolve(current,'finalize/dist/index.js'));
const aaes=await import(resolve(baseline,'aes/dist/index.js')),baes=await import(resolve(current,'aes/dist/index.js'));
const paths=['user.name','$.user.name','"a.b"','["a.b"]','$.["a.b"]',"'a.b'","['a.b']","user.'profile.name'",'user.@.role','user.@.["profile.name"]','user /* note */ . name','user . name','items[1000000]','items[01]','items[1_000]','items[1.5]','$','?.name','items.*','items.**','items[0..2]','items.<"params">','items:csv','items.\\id\\','[0]','$[0]','$.','items["a.b"]','items[-0]','items[9007199254740992]','items["a\\nkey"]',"items[`raw`]",'items.@.','items.@.[','items[','items["x"','items[no]','items..name','items.""','items.@.""','items.[true]','items.@.[true]','items.@.[`raw`]'];
// Additional host diagnostic-precedence cases discovered during cursor extraction.
// Candidate A's retained results use the original 348-case corpus.
if (process.argv[2]?.startsWith('candidate-b')) paths.push('items.[""]', 'items.[""', 'items.@.[""]', 'items.@.[""', '[""]', '[""');
const sources=[];
for(const marker of ['~','~>'])for(const path of paths)for(const [label,make] of [
 ['binding',x=>`copy = ${x}\nnext = 2`],['object',x=>`obj = { copy = ${x}, next = 2 }`],
 ['list',x=>`items = [${x}, 2]`],['attribute',x=>`obj@{copy = ${x}} = 1`],
])sources.push({name:`${marker}${path}:${label}`,source:make(marker+path)});
for(const path of ['"😀"','"é"','"a\\\"b"','"line\\nkey"'])sources.push({name:path,source:`copy = ~${path}`});
const documents=[
 'source = {name = "Ada"}\ncopy = ~source.name\npointer = ~>source.name',
 'z = "source"\na = ~z',
 'source@{meta = {unit = "cm"}} = 3\ncopy = ~source.@.meta.unit',
 'source = ["a", "b"]\ncopy = ~source[1]',
 'source = <tag("value")>\ncopy = ~source[0]',
 'source = {"a.b" = "value"}\ncopy = ~source.["a.b"]',
 'copy = ~missing','self = ~self','copy = ~later\nlater = 1',
 'source = !notSet\ncopy = ~source',
];
const stressDir=resolve(root,'stress-tests/domain/addressing');
for(const name of readdirSync(stressDir).filter(x=>x.endsWith('.aeon')).sort())documents.push(readFileSync(resolve(stressDir,name),'utf8'));
function serialize(value){return JSON.stringify(value,(_key,v)=>{
 if(v instanceof Error){const obj={name:v.name,message:v.message};for(const k of Object.keys(v))if(k!=='stack')obj[k]=v[k];return obj;}
 if(v instanceof Map)return {$map:[...v]};if(typeof v==='bigint')return {$bigint:String(v)};
 if(typeof v==='number'&&Object.is(v,-0))return {$negativeZero:true};return v;
});}
const differences=[];let equal=0;
for(const {name,source} of sources){
 const lex=tokenize(source);const x=a.parse(lex.tokens),y=b.parse(lex.tokens);
 if(serialize(x)!==serialize(y))differences.push({name,source,baseline:JSON.parse(serialize(x)),candidate:JSON.parse(serialize(y))});else equal++;
}
const endToEnd=[];
for(const [i,source] of documents.entries()){
 const x=ac.compile(source,{maxAttributeDepth:8}),y=bc.compile(source,{maxAttributeDepth:8});
 for(const [surface,left,right] of [
  ['compile',x,y],['canonical',az.canonicalize(source,{maxAttributeDepth:8}),bz.canonicalize(source,{maxAttributeDepth:8})],
  ['finalize',af.finalizeJson(x.events),bf.finalizeJson(y.events)],
  ['portable',aaes.projectPortableEvents(x.events),baes.projectPortableEvents(y.events)],
 ])if(serialize(left)!==serialize(right))endToEnd.push({document:i,surface,source,baseline:JSON.parse(serialize(left)),candidate:JSON.parse(serialize(right))});
}
const workloads={
 short:Array.from({length:100},(_,i)=>`r${i} = ~source.name`).join('\n'),
 quoted:Array.from({length:100},(_,i)=>`r${i} = ~"source.key"["nested.key"]`).join('\n'),
 attributes:Array.from({length:100},(_,i)=>`r${i} = ~source.@.metadata.unit`).join('\n'),
 deep:`r = ~source${'.child'.repeat(128)}`,
 invalid:'r = ~source.@.["missing"',
};
const scale=Number(process.env.SPIKE_BENCH_SCALE ?? 1);
if (!Number.isInteger(scale) || scale < 1 || scale > 100) throw new Error('Invalid benchmark scale');
if (process.env.SPIKE_EXTRA_WORKLOADS) {
 workloads.noReferences=Array.from({length:100},(_,i)=>`r${i} = "value"`).join('\n');
 workloads.oneReference='r = ~source.name';
}
const metrics=[];let sink=0;
const workloadEntries=Object.entries(workloads);
if(process.env.SPIKE_REVERSE_WORKLOADS)workloadEntries.reverse();
for(const [name,source] of workloadEntries){
 if(process.env.SPIKE_TRACE_PHASES) console.log(`PHASE ${name} warmup`);
 const tokens=tokenize(source).tokens;
 const iterations=(name==='deep'||name==='oneReference'?1000:300)*scale;
 for(let i=0;i<100*scale;i++){a.parse(tokens);b.parse(tokens);}
 if(process.env.SPIKE_TRACE_PHASES) console.log(`PHASE ${name} timed`);
 const times={baseline:[],candidate:[]};
 for(let batch=0;batch<11;batch++)for(const [label,parser] of batch%2?[['candidate',b],['baseline',a]]:[['baseline',a],['candidate',b]]){
  const start=performance.now();for(let i=0;i<iterations;i++)sink+=parser.parse(tokens).errors.length;
  times[label].push((performance.now()-start)/iterations);
 }
 const median=x=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)];
 const memory={};
 for(const label of ['baseline','candidate']){
  const measurement=JSON.parse(execFileSync(process.execPath,['--expose-gc',resolve(here,'measure-memory.mjs'),label],{env:{...process.env,SPIKE_MEMORY_SOURCE:source},encoding:'utf8'}));
  memory[label]=measurement.delta;
 }
 const full={baseline:[],candidate:[]};
 for(let batch=0;batch<11;batch++)for(const [label,parser] of batch%2?[['candidate',b],['baseline',a]]:[['baseline',a],['candidate',b]]){
  const start=performance.now();for(let i=0;i<iterations;i++)sink+=parser.parse(tokenize(source).tokens).errors.length;
  full[label].push((performance.now()-start)/iterations);
 }
 metrics.push({name,referenceCount:name==='noReferences'?0:name==='deep'||name==='invalid'||name==='oneReference'?1:100,depth:name==='deep'?129:undefined,iterations,batches:times,lexParseBatches:full,
  medianBaselineMs:median(times.baseline),medianCandidateMs:median(times.candidate),ratio:median(times.candidate)/median(times.baseline),
  lexParseBaselineMs:median(full.baseline),lexParseCandidateMs:median(full.candidate),lexParseRatio:median(full.candidate)/median(full.baseline),retainedHeapBytes:memory});
}
const counts={parseCases:sources.length,identical:equal,parseDifferences:differences.length,documents:documents.length,endToEndComparisons:documents.length*4,endToEndDifferences:endToEnd.length};
const output={date:'2026-10-18',node:process.version,baseline:'8cd3900e2941658d677d161f3c2bb02007c3a652',method:'Fresh baseline/candidate builds with isolated module graphs. Complete AST/error comparison; current parseInt anomalies retained deliberately. Pretokenized parse and lex+parse timings, 11 alternating batches after warmup. Retained heap measured in fresh processes per variant/workload, 1000 explicitly retained parse results after forced GC; not allocation or peak RSS.',counts,differences,endToEnd,metrics,sink,scale,extraWorkloads:!!process.env.SPIKE_EXTRA_WORKLOADS,workloadOrder:workloadEntries.map(([name])=>name)};
writeFileSync(resolve(here,process.argv[2] ?? 'comparison.results.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify({counts,metrics:metrics.map(({name,ratio})=>({name,ratio}))},null,2));
