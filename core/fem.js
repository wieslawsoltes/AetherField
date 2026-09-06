import {evaluate,D,spatialEnvironment} from './units.js';
import {buildPattern,matvec,reduceDirichlet,pcg,norm} from './sparse.js';
import {componentLabels,boundaryMatches} from './mesh.js';
export const EPS0=8.8541878128e-12;
export function materialTable(project,env){
 const map=new Map();
 for(const m of project.materials)map.set(m.id,{id:m.id,k:evaluate(m.k,env,D.thermal),rho:evaluate(m.rho,env,D.density),cp:evaluate(m.cp,env,D.capacity),sigma:evaluate(m.sigma,env,D.conductivity),epsilonR:evaluate(m.epsilonR,env,D.one),alpha:evaluate(m.alpha,env,D.invTemperature),Tref:evaluate(m.Tref,env,D.temperature)});
 return project.shapes.map(s=>map.get(s.material));
}
export function coefficients(mesh,materials,T){
 const nt=mesh.areas.length,k=new Float64Array(nt),sigma=new Float64Array(nt),epsilon=new Float64Array(nt),capacity=new Float64Array(nt);
 for(let e=0;e<nt;e++){
  const m=materials[mesh.regions[e]];if(!m)throw Error('Mesh refers to a missing domain material');
  const a=mesh.triangles[e*3],b=mesh.triangles[e*3+1],c=mesh.triangles[e*3+2],temp=T?(T[a]+T[b]+T[c])/3:m.Tref;
  const denominator=1+m.alpha*(temp-m.Tref);
  if(!(denominator>0))throw Error(`Conductivity law is non-positive in element ${e}: 1 + α(T − Tref) ≤ 0`);
  k[e]=m.k;sigma[e]=m.sigma/denominator;epsilon[e]=EPS0*m.epsilonR;capacity[e]=m.rho*m.cp;
 }
 return {k,sigma,epsilon,capacity};
}
export function gradient(mesh,values){
 const g=new Float64Array(mesh.areas.length*2);
 for(let e=0;e<mesh.areas.length;e++)for(let i=0;i<3;i++){
  g[e*2]+=values[mesh.triangles[e*3+i]]*mesh.gradients[e*6+i*2];
  g[e*2+1]+=values[mesh.triangles[e*3+i]]*mesh.gradients[e*6+i*2+1];
 }return g;
}
export function jouleDensity(mesh,V,sigma){const g=gradient(mesh,V),q=new Float64Array(mesh.areas.length);for(let e=0;e<q.length;e++)q[e]=sigma[e]*(g[2*e]**2+g[2*e+1]**2);return q;}
export function createContext(project,mesh,env){return {project,mesh,env,pattern:buildPattern(mesh),materials:materialTable(project,env),components:componentLabels(mesh)};}
/** Assemble ∫c∇Ni·∇Nj, consistent ∫ρCp NiNj, volumetric loads, natural
 * fluxes and Robin edges. Boundary values are integrated at edge midpoints;
 * spatially varying volume loads use degree-2 three-point quadrature. */
export function assemble(context,kind,coeff,{time=0,joule=null,previous=null,dt=null}={}){
 const {project:p,mesh:m,env,pattern}=context,{nodes,triangles:t,areas,gradients:g}=m,n=pattern.n;
 const values=new Float64Array(pattern.col.length),mass=dt?new Float64Array(values.length):null,rhs=new Float64Array(n),fixed=new Map(),robinNodes=new Set(),conditions=[];
 const thickness=evaluate(p.physics.thickness,env,D.length),thermal=kind==='heat',conductivity=thermal?coeff.k:kind==='electrostatics'?coeff.epsilon:coeff.sigma;
 const sourceExpression=thermal?p.physics.heatSource:kind==='electrostatics'?p.physics.spaceCharge:'0';
 const dim=thermal?D.source:kind==='electrostatics'?D.charge:D.currentFlux.map((v,i)=>v-(i===1?1:0));
 const quadrature=[[2/3,1/6,1/6],[1/6,2/3,1/6],[1/6,1/6,2/3]];
 let sourceTotal=0,fluxTotal=0;
 for(let e=0;e<areas.length;e++){
  const A=areas[e]*thickness,c=conductivity[e];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){
   const index=pattern.scatter[e*9+i*3+j];
   values[index]+=c*A*(g[e*6+i*2]*g[e*6+j*2]+g[e*6+i*2+1]*g[e*6+j*2+1]);
   if(dt){const v=coeff.capacity[e]*A/12*(i===j?2:1);mass[index]+=v;values[index]+=v/dt;}
  }
  for(const bary of quadrature){
   let x=0,y=0;for(let j=0;j<3;j++){x+=bary[j]*nodes[2*t[e*3+j]];y+=bary[j]*nodes[2*t[e*3+j]+1];}
   const q=evaluate(sourceExpression,spatialEnvironment(env,x,y,time),dim)+(thermal?(joule?.[e]||0):0);
   sourceTotal+=q*A/3;
   for(let i=0;i<3;i++)rhs[t[e*3+i]]+=q*A/3*bary[i];
  }
 }
 if(dt){if(!previous)throw Error('Transient assembly needs the previous state');const temp=matvec({...pattern,values:mass},previous);for(let i=0;i<n;i++)rhs[i]+=temp[i]/dt;}
 const setFixed=(node,value,label)=>{
  if(thermal&&value<0)throw Error('An absolute temperature cannot be below 0 K');
  if(fixed.has(node)&&Math.abs(fixed.get(node)-value)>1e-8*Math.max(1,Math.abs(value)))throw Error(`Conflicting essential boundary values at node ${node} (${label}); corner values must agree`);
  fixed.set(node,value);
 };
 const matchesCount=new Map(p.boundaries.map(b=>[b.id,0]));
 for(const edge of m.boundaries){
  const rules=p.boundaries.filter(b=>boundaryMatches(edge,b.selector));
  // Default is zero natural flux. Multiple explicit non-insulated rules on the
  // same edge are rejected (except matching Dirichlet values).
  const active=rules.map(rule=>({rule,bc:thermal?rule.heat:rule.electric})).filter(({bc})=>bc.type!=='insulation');
  for(const {rule} of active)matchesCount.set(rule.id,matchesCount.get(rule.id)+1);
  if(active.length>1&&!active.every(({bc})=>bc.type===(thermal?'temperature':'potential')))throw Error(`Overlapping boundary conditions on ${edge.tags.join(', ')}`);
  for(let r=0;r<active.length;r++){
   const {rule,bc}=active[r],a=edge.a,b=edge.b,x=(nodes[2*a]+nodes[2*b])/2,y=(nodes[2*a+1]+nodes[2*b+1])/2,L=edge.length*thickness,E=spatialEnvironment(env,x,y,time);
   if(bc.type==='temperature'||bc.type==='potential'){
    for(const node of [a,b])setFixed(node,evaluate(bc.value,spatialEnvironment(env,nodes[node*2],nodes[node*2+1],time),thermal?D.temperature:D.voltage),rule.name);
   }else if(bc.type==='flux'){
    const flux=evaluate(bc.value,E,thermal?D.flux:kind==='electrostatics'?D.surfaceCharge:D.currentFlux);
    rhs[a]+=flux*L/2;rhs[b]+=flux*L/2;fluxTotal+=flux*L;
   }else if(bc.type==='convection'){
    const h=evaluate(bc.h,E,D.convection),ambient=evaluate(bc.ambient,E,D.temperature);if(h<0||ambient<0)throw Error('Convection coefficient and ambient absolute temperature must be non-negative');
    for(const i of [a,b]){rhs[i]+=h*ambient*L/2;for(const j of [a,b])values[pattern.lookup[i].get(j)]+=h*L/6*(i===j?2:1);if(h>0)robinNodes.add(i);}
    conditions.push({a,b,h,ambient,L});
   }
  }
 }
 const unmatched=[];
 for(const b of p.boundaries){const bc=thermal?b.heat:b.electric;if(bc.type!=='insulation'&&matchesCount.get(b.id)===0)unmatched.push(b.name||b.selector);}
 if(unmatched.length)throw Error(`Boundary selection is empty: ${unmatched.join(', ')}. Reassign the condition to an exposed boundary.`);
 if(!dt){
  const anchored=new Set();for(const i of fixed.keys())anchored.add(context.components.labels[i]);for(const i of robinNodes)anchored.add(context.components.labels[i]);
  if(anchored.size<context.components.count)throw Error(`${thermal?'Temperature reference / convection':'Electric potential reference'} missing on ${context.components.count-anchored.size} connected component(s). A pure-Neumann stationary system has a nullspace.`);
 }
 return {A:{...pattern,values},b:rhs,fixed,mass,conditions,sourceTotal,fluxTotal,thickness,kind,dt,previous};
}
export async function solveSystem(system,context,{gpu=null,warm=null,onIteration=()=>{},label='Linear solve'}={}){
 const reduced=reduceDirichlet(system.A,system.b,system.fixed),settings=context.project.study;
 const x0=warm?Float64Array.from(reduced.free,i=>warm[i]):null;
 const options={tolerance:settings.tolerance,maxIterations:settings.maxIterations,x0,onIteration,label};
 let result;
 if(gpu&&!gpu.unavailable&&settings.backend!=='cpu'&&reduced.A.n>=64){
  try{result=await gpu.solve(reduced.A,reduced.b,options);}catch(e){onIteration({label,warning:`GPU unavailable or rejected: ${e.message}; using Float64 CPU`});result=pcg(reduced.A,reduced.b,options);}
 }else result=pcg(reduced.A,reduced.b,options);
 const x=reduced.expand(result.x),Ax=matvec(system.A,x),reaction=new Float64Array(x.length);let essentialReaction=0,freeResidualSum=0;
 for(let i=0;i<x.length;i++){reaction[i]=Ax[i]-system.b[i];if(system.fixed.has(i))essentialReaction+=reaction[i];else freeResidualSum+=reaction[i];}
 let convectionOut=0;for(const e of system.conditions)convectionOut+=e.h*e.L*((x[e.a]+x[e.b])/2-e.ambient);
 let storage=0;if(system.dt){const difference=Float64Array.from(x,(v,i)=>v-system.previous[i]),md=matvec({...system.A,values:system.mass},difference);for(const v of md)storage+=v/system.dt;}
 const balance=system.sourceTotal+system.fluxTotal+essentialReaction-convectionOut-storage;
 return {...result,label,x,reaction,diagnostics:{source:system.sourceTotal,inwardFlux:system.fluxTotal,essentialReaction,convectionOut,storage,balance,freeResidualSum,relativeResidual:result.relativeResidual,dofs:reduced.A.n,nonzeros:reduced.A.values.length}};
}
export function derivedFields(mesh,T,V,coeff,mode){
 const nt=mesh.areas.length,gt=T?gradient(mesh,T):null,gv=V?gradient(mesh,V):null;
 const heatFlux=new Float64Array(nt),electricField=new Float64Array(nt),joule=new Float64Array(nt),heatVector=new Float64Array(nt*2),electricVector=new Float64Array(nt*2),currentVector=new Float64Array(nt*2),energyDensity=new Float64Array(nt);
 for(let e=0;e<nt;e++){
  if(gt){heatVector[2*e]=-coeff.k[e]*gt[2*e];heatVector[2*e+1]=-coeff.k[e]*gt[2*e+1];heatFlux[e]=Math.hypot(heatVector[2*e],heatVector[2*e+1]);}
  if(gv){electricVector[2*e]=-gv[2*e];electricVector[2*e+1]=-gv[2*e+1];electricField[e]=Math.hypot(gv[2*e],gv[2*e+1]);energyDensity[e]=.5*coeff.epsilon[e]*electricField[e]**2;
   if(mode!=='electrostatics'){currentVector[2*e]=-coeff.sigma[e]*gv[2*e];currentVector[2*e+1]=-coeff.sigma[e]*gv[2*e+1];joule[e]=coeff.sigma[e]*electricField[e]**2;}
  }
 }
 return {heatFlux,electricField,joule,heatVector,electricVector,currentVector,energyDensity};
}
export function range(values){if(!values?.length)return {min:0,max:0};let min=Infinity,max=-Infinity;for(const v of values){min=Math.min(min,v);max=Math.max(max,v);}return {min,max};}
