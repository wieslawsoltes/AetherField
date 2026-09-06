import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {defaultProject,simpleProject} from '../core/model.js';
import {runStudy} from '../core/study.js';
import {projectJSON,resultJSON,resultsCSV,elementsCSV,probesCSV,vtk} from '../core/io.js';
const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../examples');
await mkdir(directory,{recursive:true});
const heater=defaultProject(),thermal=simpleProject('heat'),capacitor=simpleProject('electrostatics'),transient=simpleProject('heat');
transient.name='Transient thermal diffusion';transient.study.type='transient';transient.study.dt='10[s]';transient.study.end='200[s]';
const sweep=defaultProject();sweep.name='Heater voltage sweep';sweep.study.sweep.enabled=true;
const models={heater,thermal,capacitor,transient,sweep},summaries={};
for(const [name,project] of Object.entries(models)){
 project.id=`aetherfield-example-${name}`;
 await writeFile(path.join(directory,`${name}.afield`),projectJSON(project));
 // No GPU object is passed: exported reference results use Float64 CPU only.
 const result=await runStudy(project),run=result.runs[0],frame=run.frames.at(-1);
 summaries[name]=result.runs.map(r=>{
  const f=r.frames.at(-1);
  return {case:r.parameter,nodes:r.mesh.stats.nodes,elements:r.mesh.stats.elements,minQuality:r.mesh.stats.minQuality,meanQuality:r.mesh.stats.meanQuality,frames:r.frames.length,summary:f.summary,nonlinear:f.nonlinear,linearIterations:r.records.reduce((s,r)=>s+r.iterations,0),maxAcceptedLinearResidual:Math.max(...r.records.map(r=>r.relativeResidual)),lastSolves:f.solves.map(r=>({label:r.label,...r.diagnostics})),probes:r.probes,elapsedMs:r.elapsed};
 });
 await writeFile(path.join(directory,`${name}-probes.csv`),probesCSV(run));
 if(name==='heater'){
  await writeFile(path.join(directory,'heater-results.json'),resultJSON(result));
  await writeFile(path.join(directory,'heater-nodes.csv'),resultsCSV(run,frame));
  await writeFile(path.join(directory,'heater-elements.csv'),elementsCSV(run,frame));
  await writeFile(path.join(directory,'heater.vtk'),vtk(run,frame));
 }
 console.log(`${name}: ${result.runs.length} case(s), ${run.mesh.stats.nodes} nodes, ${run.mesh.stats.elements} elements, Tmax=${frame.summary.temperature.max.toFixed(6)} K, P=${frame.summary.joulePower.toFixed(8)} W`);
}
await writeFile(path.join(directory,'computed-summary.json'),JSON.stringify({backend:'Float64 CPU',generatedAt:new Date().toISOString(),models:summaries},null,2));
