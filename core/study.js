import {validateProject,clone} from './model.js';
import {evaluate,resolveParameters,spatialEnvironment,D,compile} from './units.js';
import {generateMesh,MeshLocator,meshSignature} from './mesh.js';
import {createContext,coefficients,assemble,solveSystem,jouleDensity,derivedFields,range} from './fem.js';
import {reduceDirichlet,relativeResidual,norm} from './sparse.js';

function systemResidual(system,x){const r=reduceDirichlet(system.A,system.b,system.fixed);if(!r.A.n)return 0;return relativeResidual(r.A,Float64Array.from(r.free,i=>x[i]),r.b);}
function initialTemperature(p,m,env){const T=new Float64Array(m.nodes.length/2);for(let i=0;i<T.length;i++){T[i]=evaluate(p.physics.initial,spatialEnvironment(env,m.nodes[i*2],m.nodes[i*2+1]),D.temperature);if(T[i]<0)throw Error('Initial absolute temperature must be non-negative');}return T;}
function integral(mesh,values,thickness){let total=0;for(let e=0;e<values.length;e++)total+=mesh.areas[e]*values[e]*thickness;return total;}
function frameOf(context,time,T,V,coeff,solves=[],nonlinear={iterations:0,residual:0}){
 const {mesh,project:p,env}=context,fields=derivedFields(mesh,T,V,coeff,p.physics.mode),thickness=evaluate(p.physics.thickness,env,D.length);
 return {time,T,V,...fields,solves,nonlinear,summary:{temperature:range(T),potential:range(V),joulePower:integral(mesh,fields.joule,thickness),electricEnergy:integral(mesh,fields.energyDensity,thickness),maxHeatFlux:range(fields.heatFlux).max,maxElectricField:range(fields.electricField).max}};
}
export async function solveCase(project,{mesh=null,progress=()=>{},gpu=null}={}){
 const started=performance.now(),env=validateProject(project);if(mesh?.signature!==meshSignature(project,env))mesh=null;mesh ||= generateMesh(project,env,progress);
 const context=createContext(project,mesh,env),mode=project.physics.mode,thermal=mode==='heat'||mode==='joule',electric=mode!=='heat',joule=mode==='joule';
 const nonlinear=joule&&context.materials.some(m=>m?.alpha!==0),settings=project.study;
 let T=initialTemperature(project,mesh,env),V=null;
 const records=[],frames=[];
 const iterate=e=>{if(e.warning)progress({phase:'warning',message:e.warning});else progress({phase:'iteration',...e});};
 const saveSolve=(result,label)=>{
  const record={label,iterations:result.iterations,relativeResidual:result.relativeResidual,history:result.history,backend:result.backend,diagnostics:result.diagnostics,gpuIterations:result.gpuIterations||0,cpuIterations:result.cpuIterations??result.iterations};records.push(record);return record;
 };
 const solve=(system,warm,label)=>solveSystem(system,context,{gpu,warm,onIteration:iterate,label});
 async function solveStep(time,previous,dt){
  let guess=T.slice(),lastV=V,accepted=null;
  for(let iteration=1;iteration<=(nonlinear?settings.maxNonlinear:1);iteration++){
   const c=coefficients(mesh,context.materials,guess),stepRecords=[];let v=lastV,temperature=null,q=null;
   if(electric){
    const kind=mode==='electrostatics'?'electrostatics':'current';
    const s=await solve(assemble(context,kind,c,{time}),lastV,`${kind==='electrostatics'?'Electrostatics':'Electric currents'}${dt?` · t=${time.toPrecision(4)} s`:''}${nonlinear?` · Picard ${iteration}`:''}`);
    v=s.x;stepRecords.push(saveSolve(s,s.label||`${kind} / ${iteration}`));
    if(joule)q=jouleDensity(mesh,v,c.sigma);
   }
   if(thermal){
    const s=await solve(assemble(context,'heat',c,{time,joule:q,previous,dt}),guess,`Heat transfer${dt?` · t=${time.toPrecision(4)} s`:''}${nonlinear?` · Picard ${iteration}`:''}`);
    temperature=s.x;stepRecords.push(saveSolve(s,s.label));
    if(range(temperature).min<0)throw Error('The computed absolute temperature is below 0 K; check sources and units');
   }
   const finalC=coefficients(mesh,context.materials,temperature||guess);
   let coupledResidual=0,change=0;
   if(nonlinear){
    const difference=Float64Array.from(temperature,(x,i)=>x-guess[i]);change=norm(difference)/Math.max(norm(temperature),Math.sqrt(guess.length));
    const electricalResidual=systemResidual(assemble(context,'current',finalC,{time}),v);
    const thermalResidual=systemResidual(assemble(context,'heat',finalC,{time,joule:jouleDensity(mesh,v,finalC.sigma),previous,dt}),temperature);
    coupledResidual=Math.max(electricalResidual,thermalResidual);
    progress({phase:'nonlinear',iteration,residual:coupledResidual,change,message:`Picard ${iteration}: coupled residual ${coupledResidual.toExponential(2)}, ΔT/T ${change.toExponential(2)}`});
   }
   if(!nonlinear||(coupledResidual<=settings.nonlinearTolerance&&change<=settings.nonlinearTolerance)){
    accepted=frameOf(context,time,thermal?temperature:null,electric?v:null,finalC,stepRecords,{iterations:iteration,residual:coupledResidual,change});
    if(thermal)T=temperature;V=v;break;
   }
   for(let i=0;i<guess.length;i++)guess[i]+=settings.relaxation*(temperature[i]-guess[i]);lastV=v;
  }
  if(!accepted)throw Error(`Joule-heating coupling did not converge in ${settings.maxNonlinear} Picard iterations. Reduce voltage, reduce relaxation, or inspect the conductivity law.`);
  return accepted;
 }
 if(settings.type==='stationary')frames.push(await solveStep(0,null,null));
 else{
  const dt=evaluate(settings.dt,env,D.time),end=evaluate(settings.end,env,D.time),count=Math.ceil(end/dt);
  if(mesh.areas.length*(count+1)>2500000)throw Error('Transient result memory budget exceeded. Increase the time step or element size (2.5 million element-frames maximum).');
  if(thermal){const init=assemble(context,'heat',coefficients(mesh,context.materials,T),{time:0,previous:T,dt});for(const [i,value] of init.fixed)T[i]=value;}
  let c=coefficients(mesh,context.materials,T);
  const initialRecords=[];
  if(electric){const kind=mode==='electrostatics'?'electrostatics':'current';const s=await solve(assemble(context,kind,c,{time:0}),null,`${kind} · t=0`);V=s.x;initialRecords.push(saveSolve(s,s.label));}
  frames.push(frameOf(context,0,thermal?T:null,V,c,initialRecords));
  for(let step=1;step<=count;step++){
   const time=Math.min(step*dt,end),previousTime=Math.min((step-1)*dt,end),actualDt=time-previousTime;
   progress({phase:'time',step,total:count,time,message:`Time step ${step}/${count} · ${time.toPrecision(4)} s`});
   frames.push(await solveStep(time,thermal?T.slice():null,thermal?actualDt:null));
  }
 }
 const locator=new MeshLocator(mesh);
 const probes=project.probes.map(probe=>({...probe,samples:frames.map(f=>({time:f.time,T:f.T?locator.sample(f.T,probe.x,probe.y):null,V:f.V?locator.sample(f.V,probe.x,probe.y):null}))}));
 const elapsed=performance.now()-started;
 progress({phase:'complete',message:`Solved ${frames.length} frame(s) in ${(elapsed/1000).toFixed(3)} s · ${records.reduce((s,r)=>s+r.iterations,0)} linear iterations`});
 return {mesh,frames,probes,records,elapsed,mode,parameter:null};
}
export function splitExpressions(text){const out=[];let start=0,depth=0;for(let i=0;i<text.length;i++){if('(['.includes(text[i]))depth++;if(')]'.includes(text[i]))depth--;if(text[i]===','&&depth===0){out.push(text.slice(start,i).trim());start=i+1;}}out.push(text.slice(start).trim());return out.filter(Boolean);}
export async function runStudy(project,options={}){
 const start=performance.now();validateProject(project);const runs=[];
 if(project.study.sweep.enabled){
  const setting=project.study.sweep,row=project.parameters.find(p=>p.name===setting.parameter);if(!row)throw Error('Sweep parameter does not exist');
  const env=resolveParameters(project.parameters),expressions=splitExpressions(setting.values);if(!expressions.length||expressions.length>16)throw Error('A sweep requires 1–16 values');
  let retainedElements=0;
  for(let i=0;i<expressions.length;i++){
   const p=clone(project);p.study.sweep.enabled=false;
   evaluate(expressions[i],env,env[setting.parameter].d);
   p.parameters.find(v=>v.name===setting.parameter).expression=expressions[i];
   options.progress?.({phase:'sweep',index:i,total:expressions.length,message:`Sweep ${i+1}/${expressions.length} · ${setting.parameter} = ${expressions[i]}`});
   // Parameter dependencies may affect geometry: remesh each case, never reuse
   // a mesh merely because the swept name looks like an electrical parameter.
   const result=await solveCase(p,{...options,mesh:null});result.parameter={name:setting.parameter,expression:expressions[i],value:resolveParameters(p.parameters)[setting.parameter].v};
   retainedElements+=result.mesh.areas.length*result.frames.length;if(retainedElements>4000000)throw Error('Sweep result memory budget exceeded');runs.push(result);
  }
 }else runs.push(await solveCase(project,options));
 return {version:1,computedAt:new Date().toISOString(),elapsed:performance.now()-start,runs};
}
