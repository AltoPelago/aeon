// Diagnostic only: flags/snapshots perturb the process and cannot certify acceptance.
import {writeHeapSnapshot,getHeapSpaceStatistics} from 'node:v8';
import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {engine} from '../../../reference-parser-sharing/experiments/reference-parser-sharing/identity-canary.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
const ac=await import(resolve(here,'.baseline/packages/core/dist/index.js'));
const bc=await import(resolve(here,'../../implementations/typescript/packages/core/dist/index.js'));
const az=await import(resolve(here,'.baseline/packages/canonical/dist/index.js'));
const bz=await import(resolve(here,'../../implementations/typescript/packages/canonical/dist/index.js'));
const broadCore=await import(resolve(here,'../../../reference-parser-sharing/implementations/typescript/packages/core/dist/index.js'));
const broadCanon=await import(resolve(here,'../../../reference-parser-sharing/implementations/typescript/packages/canonical/dist/index.js'));
const [surface,variant]=process.argv.slice(2);const source=Array.from({length:100},(_,i)=>`r${i} = "v"`).join('\n');
const fn=variant==='profile'?(surface==='compile'?broadCore.compile:broadCanon.canonicalize):surface==='compile'?(variant==='baseline'?ac.compile:bc.compile):(variant==='baseline'?az.canonicalize:bz.canonicalize);
const opts={maxAttributeDepth:8,...(variant==='profile'?{referenceEngine:engine}:{})};
for(let i=0;i<100;i++)fn(source,opts);
global.gc();const before=process.memoryUsage().heapUsed;const spacesBefore=getHeapSpaceStatistics();
globalThis.retained=Array.from({length:200},()=>fn(source,opts));
global.gc();console.log(JSON.stringify({surface,variant,retained:200,delta:process.memoryUsage().heapUsed-before,spacesBefore,spacesAfter:getHeapSpaceStatistics()}));

writeHeapSnapshot(resolve(here,`.results/no-reference-before-${variant}.heapsnapshot`));
