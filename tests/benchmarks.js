import {simpleProject,defaultProject,validateProject,clone,History} from '../core/model.js';
import {evaluate,D,resolveParameters} from '../core/units.js';
import {generateMesh,MeshLocator} from '../core/mesh.js';
import {solveCase,runStudy} from '../core/study.js';
import {range,EPS0} from '../core/fem.js';

const assert=(condition,message)=>{if(!condition)throw Error(message);};
function slab(mode='heat',h=.08){
 const p=simpleProject(mode);p.shapes[0].width='1[m]';p.shapes[0].height='0.6[m]';p.mesh.size=`${h}[m]`;p.physics.thickness='1[m]';
 Object.assign(p.materials[0],{k:'1[W/(m*K)]',rho:'1[kg/m^3]',cp:'1[J/(kg*K)]',sigma:'2[S/m]',alpha:'0',epsilonR:'4'});
 p.parameters=[{name:'Vapp',expression:'1[V]'},{name:'T0',expression:'300[K]'}];p.boundaries[0].heat.value='400[K]';p.boundaries[1].heat.value='300[K]';p.study.backend='cpu';p.study.tolerance=1e-10;return p;
}
function nodalError(run,field,exact){const m=run.mesh,v=run.frames.at(-1)[field];let error=0;for(let i=0;i<v.length;i++)error=Math.max(error,Math.abs(v[i]-exact(m.nodes[2*i],m.nodes[2*i+1])));return error;}
function l2Error(run,field,exact){
 const m=run.mesh,v=run.frames.at(-1)[field],bary=[[2/3,1/6,1/6],[1/6,2/3,1/6],[1/6,1/6,2/3]];let error=0;
 for(let e=0;e<m.areas.length;e++)for(const w of bary){let x=0,y=0,value=0;for(let j=0;j<3;j++){const id=m.triangles[e*3+j];x+=w[j]*m.nodes[id*2];y+=w[j]*m.nodes[id*2+1];value+=w[j]*v[id];}error+=(value-exact(x,y))**2*m.areas[e]/3;}return Math.sqrt(error);
}
export async function runBenchmarks(progress=()=>{}){
 const tests=[],test=async(name,fn)=>{
  const start=performance.now();try{const metrics=await fn();tests.push({name,passed:true,elapsed:performance.now()-start,...metrics});}catch(error){tests.push({name,passed:false,elapsed:performance.now()-start,error:error.message});}
  progress(tests.at(-1));
 };
 await test('Dimensional expressions, SI conversion and cyclic dependency detection',async()=>{
  assert(Math.abs(evaluate('25[degC]',{},D.temperature)-298.15)<1e-12,'Celsius conversion');
  assert(evaluate('2[cm]+3[mm]',{},D.length)===.023,'Length conversion');
  let mismatch=false,cyclic=false;try{evaluate('1[s]',{},D.length);}catch{mismatch=true;}try{resolveParameters([{name:'aa',expression:'bb'},{name:'bb',expression:'aa'}]);}catch{cyclic=true;}
  assert(mismatch&&cyclic,'Invalid units / cycle not rejected');return {metric:'3 invalid/valid input paths checked'};
 });
 await test('Linear thermal patch test on unstructured triangles',async()=>{
  const r=await solveCase(slab()),error=nodalError(r,'T',x=>400-100*x);assert(error<2e-6,`Max error ${error}`);return {error,tolerance:2e-6,unit:'K'};
 });
 await test('Poisson heat source: spatial L2 mesh convergence',async()=>{
  const errors=[];for(const h of [.16,.08,.04]){const p=slab('heat',h);p.boundaries[0].heat.value='300[K]';p.physics.heatSource='2[W/m^3]';const r=await solveCase(p);errors.push(l2Error(r,'T',x=>300+x*(1-x)));}
  const order=Math.log(errors[1]/errors[2])/Math.log(2);assert(errors[2]<errors[1]&&order>1.6,`Errors ${errors}, rate ${order}`);return {errors,order,tolerance:'order > 1.6'};
 });
 await test('Inward Neumann heat flux sign and analytical slope',async()=>{
  const p=slab();p.boundaries[0].heat.value='300[K]';p.boundaries[1].heat={type:'flux',value:'10[W/m^2]'};
  const r=await solveCase(p),error=nodalError(r,'T',x=>300+10*x);assert(error<2e-6,`Max error ${error}`);return {error,unit:'K'};
 });
 await test('Robin convection boundary and energy balance',async()=>{
  const p=slab();p.boundaries[0].heat.value='300[K]';p.boundaries[1].heat={type:'convection',h:'10[W/(m^2*K)]',ambient:'400[K]'};
  const r=await solveCase(p),error=nodalError(r,'T',x=>300+1000/11*x),balance=r.frames[0].solves[0].diagnostics.balance;
  assert(error<3e-6&&Math.abs(balance)<2e-5,`Error ${error}, balance ${balance}`);return {error,balance,unit:'K / W'};
 });
 await test('Electrostatic parallel plate: potential, field and stored energy',async()=>{
  const p=slab('electrostatics'),r=await solveCase(p),f=r.frames[0],error=nodalError(r,'V',x=>1-x),energy=.5*EPS0*4*.6;
  const energyRelativeError=Math.abs(f.summary.electricEnergy-energy)/energy;
  assert(error<1e-7&&energyRelativeError<1e-7,`Potential ${error}, energy ${energyRelativeError}`);return {error,energyRelativeError,unit:'V'};
 });
 await test('Conforming dielectric interface: discontinuous permittivity',async()=>{
  const p=slab('electrostatics');p.materials[0].epsilonR='1';p.materials.push({...p.materials[0],id:'dielectric',name:'Dielectric',epsilonR:'4'});
  p.shapes.push({id:'layer',name:'Layer',type:'rectangle',operation:'add',material:'dielectric',x:'.5[m]',y:'0',width:'.5[m]',height:'.6[m]'});
  const r=await solveCase(p),error=nodalError(r,'V',x=>x<=.5?1-1.6*x:.2-.4*(x-.5));assert(error<2e-7,`Interface error ${error}`);return {error,unit:'V'};
 });
 await test('Transient heat: backward Euler against an analytical sine decay',async()=>{
  const p=slab('heat',.06);p.boundaries[0].heat.value='300[K]';p.physics.initial='300[K]+10[K]*sin(pi*x/1[m])';p.study.type='transient';p.study.end='.05[s]';p.study.dt='.0025[s]';
  const r=await solveCase(p),error=l2Error(r,'T',x=>300+10*Math.sin(Math.PI*x)*Math.exp(-(Math.PI**2)*.05));assert(error<.05,`L2 error ${error}`);return {error,frames:r.frames.length,unit:'K·m'};
 });
 await test('Pure-Neumann transient heat conserves a uniform state',async()=>{
  const p=slab();for(const b of p.boundaries)b.heat.type='insulation';p.study.type='transient';p.study.dt='.1[s]';p.study.end='.3[s]';
  const r=await solveCase(p),error=nodalError(r,'T',()=>300);assert(error<1e-8,`Drift ${error}`);return {error,unit:'K'};
 });
 await test('Joule coupling: parabolic thermal solution and electrical power',async()=>{
  const p=slab('joule',.05);p.boundaries[0].heat.value='300[K]';const r=await solveCase(p),f=r.frames[0],error=l2Error(r,'T',x=>300+x*(1-x)),powerError=Math.abs(f.summary.joulePower-1.2);
  assert(error<.002&&powerError<1e-7,`Thermal ${error}, power ${powerError}`);return {error,powerError,unit:'K·m / W'};
 });
 await test('Temperature-dependent conductivity: verified two-way coupling',async()=>{
  const p=defaultProject();p.study.backend='cpu';p.mesh.size='4[mm]';const r=await solveCase(p),f=r.frames[0];
  assert(f.nonlinear.iterations>1&&f.nonlinear.residual<=p.study.nonlinearTolerance,'Nonlinear residual was not satisfied');return {iterations:f.nonlinear.iterations,residual:f.nonlinear.residual,Tmax:f.summary.temperature.max};
 });
 await test('PSLG Boolean holes: polygonized-circle area and mesh quality',async()=>{
  const p=defaultProject(),m=generateMesh(p,validateProject(p));const circleArea=24*.009**2*Math.sin(2*Math.PI/24)/2,expected=.006-2*circleArea;
  const error=Math.abs(m.stats.area-expected);assert(error<1e-12&&m.stats.minQuality>0,'Area or quality failure');const locator=new MeshLocator(m);assert(!locator.locate(.035,.03),'Hole was filled with elements');return {error,quality:m.stats.minQuality,nodes:m.stats.nodes,elements:m.stats.elements};
 });
 await test('Overlapping polygon/rectangle union is constraint-conforming',async()=>{
  const p=slab();p.shapes=[{...p.shapes[0],width:'1',height:'1'},{id:'cut',name:'Triangular notch',type:'polygon',operation:'subtract',material:'alloy',points:[['.3','-.2'],['.7','-.2'],['.5','.4']]}];
  const m=generateMesh(p,validateProject(p)),expected=1-(2/3*.4)*.4/2,error=Math.abs(m.stats.area-expected);
  assert(error<1e-10,`Boolean area ${m.stats.area} expected ${expected}`);return {error};
 });
 await test('Stationary nullspace and conflicting essential values are rejected',async()=>{
  let missing=false,conflict=false;const p=slab();p.boundaries.forEach(b=>b.heat.type='insulation');try{await solveCase(p);}catch(e){missing=e.message.includes('nullspace');}
  const q=slab();q.boundaries.push({id:'overlap',selector:'left',name:'Conflict',heat:{type:'temperature',value:'350[K]'},electric:{type:'insulation',value:'0'}});try{await solveCase(q);}catch(e){conflict=e.message.includes('Conflicting');}
  assert(missing&&conflict,'Invalid system was accepted');return {metric:'Both invalid systems rejected'};
 });
 await test('Parameter sweep recomputes fields and quadratic Joule power',async()=>{
  const p=slab('joule',.12);p.boundaries[0].heat.value='300[K]';p.study.sweep={enabled:true,parameter:'Vapp',values:'1[V],2[V]'};const r=await runStudy(p),ratio=r.runs[1].frames[0].summary.joulePower/r.runs[0].frames[0].summary.joulePower;
  assert(Math.abs(ratio-4)<1e-7,`Power ratio ${ratio}`);return {ratio};
 });
 await test('Atomic project history and persistent identity',async()=>{
  const p=slab(),h=new History(p),q=clone(p);q.shapes[0].width='2[m]';h.commit(q);h.undo();assert(h.present.shapes[0].width==='1[m]','Undo failed');h.redo();assert(h.present.shapes[0].width==='2[m]'&&h.present.shapes[0].id===p.shapes[0].id,'Redo / identity failed');return {metric:'Undo / redo round trip'};
 });
 return {passed:tests.filter(t=>t.passed).length,total:tests.length,tests};
}
