import {writeFile} from 'node:fs/promises';
import {runBenchmarks} from './benchmarks.js';
const report=await runBenchmarks(t=>console.log(`${t.passed?'PASS':'FAIL'} ${t.name} (${t.elapsed.toFixed(1)} ms)${!t.passed?` — ${t.error}`:''}`));
await writeFile(new URL('./results.json',import.meta.url),JSON.stringify(report,null,2));
console.log(`\n${report.passed}/${report.total} passed`);process.exitCode=report.passed===report.total?0:1;
