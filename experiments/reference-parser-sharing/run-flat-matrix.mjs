import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('.',import.meta.url));
for(let i=1;i<=4;i++){
 const env={...process.env};delete env.SPIKE_REVERSE_WORKLOADS;
 if(i===4)env.SPIKE_REVERSE_WORKLOADS='1';
 console.log(`Narrow parser repetition ${i}`);
 process.stdout.write(execFileSync(process.execPath,['compare.mjs',`candidate-b-path-only-flat-${i}.results.json`],{cwd,env:{...env,SPIKE_BENCH_SCALE:'10',SPIKE_EXTRA_WORKLOADS:'1'},encoding:'utf8'}));
}
for(let i=1;i<=2;i++){
 console.log(`Pipeline repetition ${i}; profile variant is retained broader control`);
 process.stdout.write(execFileSync(process.execPath,['pipeline-timing.mjs',`path-only-flat-pipeline-${i}.results.json`],{cwd,encoding:'utf8'}));
}
