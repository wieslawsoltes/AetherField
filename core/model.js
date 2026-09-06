import {resolveParameters,evaluate,D} from './units.js';
export const SCHEMA=1;
export const uid=prefix=>`${prefix}_${globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`;
export const clone=x=>structuredClone(x);
export function defaultProject(){return {
 schema:SCHEMA,id:uid('project'),name:'Perforated resistive heater',
 parameters:[{name:'Vapp',expression:'0.8[V]'},{name:'T0',expression:'293.15[K]'},{name:'L',expression:'100[mm]'},{name:'H',expression:'60[mm]'}],
 shapes:[
  {id:'plate',name:'Resistive plate',type:'rectangle',operation:'add',material:'alloy',x:'0[mm]',y:'0[mm]',width:'L',height:'H'},
  {id:'padL',name:'Left contact',type:'rectangle',operation:'add',material:'contact',x:'0[mm]',y:'0[mm]',width:'10[mm]',height:'H'},
  {id:'padR',name:'Right contact',type:'rectangle',operation:'add',material:'contact',x:'90[mm]',y:'0[mm]',width:'10[mm]',height:'H'},
  {id:'hole1',name:'Cooling bore 1',type:'circle',operation:'subtract',material:'alloy',x:'35[mm]',y:'30[mm]',radius:'9[mm]'},
  {id:'hole2',name:'Cooling bore 2',type:'circle',operation:'subtract',material:'alloy',x:'65[mm]',y:'30[mm]',radius:'9[mm]'}
 ],
 materials:[
  {id:'alloy',name:'Resistive alloy · illustrative',k:'16[W/(m*K)]',rho:'7800[kg/m^3]',cp:'500[J/(kg*K)]',sigma:'12000[S/m]',epsilonR:'1',alpha:'0.002[1/K]',Tref:'T0',color:'#769db1'},
  {id:'contact',name:'Contact metal · illustrative',k:'100[W/(m*K)]',rho:'8900[kg/m^3]',cp:'385[J/(kg*K)]',sigma:'80000[S/m]',epsilonR:'1',alpha:'0[1/K]',Tref:'T0',color:'#c99560'}
 ],
 physics:{mode:'joule',thickness:'1[mm]',heatSource:'0[W/m^3]',spaceCharge:'0[C/m^3]',initial:'T0'},
 boundaries:[
  {id:'bcL',selector:'left',name:'Terminal / heat sink',heat:{type:'temperature',value:'T0',h:'10[W/(m^2*K)]',ambient:'T0'},electric:{type:'potential',value:'Vapp'}},
  {id:'bcR',selector:'right',name:'Ground / heat sink',heat:{type:'temperature',value:'T0',h:'10[W/(m^2*K)]',ambient:'T0'},electric:{type:'potential',value:'0[V]'}}
 ],
 mesh:{size:'2.5[mm]',maxNodes:18000},
 study:{type:'stationary',dt:'0.5[s]',end:'10[s]',tolerance:1e-9,maxIterations:3500,nonlinearTolerance:1e-7,maxNonlinear:70,relaxation:0.8,backend:'auto',sweep:{enabled:false,parameter:'Vapp',values:'0.4[V], 0.6[V], 0.8[V], 1[V]'}},
 probes:[{id:'probe0',name:'Center bridge',x:.05,y:.03}],view:{field:'temperature',mesh:false,contours:true,vectors:false}
};}
export function simpleProject(mode='heat'){
 const p=defaultProject();p.name=mode==='electrostatics'?'Parallel-plate capacitor':'Thermal conduction slab';
 p.parameters=[{name:'Vapp',expression:'10[V]'},{name:'T0',expression:'293.15[K]'}];
 p.shapes=[{id:'plate',name:'Domain',type:'rectangle',operation:'add',material:'alloy',x:'0',y:'0',width:'100[mm]',height:'60[mm]'}];
 p.materials=p.materials.slice(0,1);Object.assign(p.materials[0],{name:'Homogeneous material · illustrative',k:'10[W/(m*K)]',sigma:'100[S/m]',alpha:'0',epsilonR:'4'});
 p.physics.mode=mode;p.boundaries[0].heat.value='373.15[K]';p.boundaries[1].heat.value='T0';
 p.probes=[{id:'probe0',name:'Midpoint',x:.05,y:.03}];p.view.field=mode==='electrostatics'?'potential':'temperature';return p;
}
export function validateProject(p){
 if(!p||typeof p!=='object'||p.schema!==SCHEMA)throw Error('Unsupported AetherField project schema');
 if(typeof p.name!=='string'||p.name.length>240)throw Error('Invalid project name');
 for(const key of ['parameters','shapes','materials','boundaries','probes'])if(!Array.isArray(p[key]))throw Error(`Missing ${key}`);
 if(p.shapes.length>120||p.materials.length>80||p.boundaries.length>300||p.parameters.length>120||p.probes.length>200)throw Error('Project exceeds interactive safety limits');
 for(const key of ['shapes','materials','boundaries','probes']){const ids=new Set();for(const x of p[key]){if(typeof x.id!=='string'||x.id.length>100||ids.has(x.id))throw Error(`Invalid or duplicate ${key} identity`);ids.add(x.id);}}
 if(!p.study?.sweep||typeof p.study.sweep.enabled!=='boolean'||typeof p.study.sweep.parameter!=='string'||typeof p.study.sweep.values!=='string')throw Error('Missing or invalid parameter sweep settings');
 if(!p.view||typeof p.view.field!=='string')throw Error('Missing result view settings');
 if(!Number.isInteger(p.mesh?.maxNodes)||p.mesh.maxNodes<16||p.mesh.maxNodes>30000)throw Error('Mesh node budget must be 16–30000');
 for(const probe of p.probes)if(!Number.isFinite(probe.x)||!Number.isFinite(probe.y)||typeof probe.name!=='string')throw Error('Invalid probe coordinates or name');
 const env=resolveParameters(p.parameters);
 if(!['heat','electrostatics','current','joule'].includes(p.physics?.mode))throw Error('Unknown physics interface');
 if(!['stationary','transient'].includes(p.study?.type))throw Error('Unknown study type');
 const positive=(v,name)=>{if(!(v>0))throw Error(`${name} must be positive`);};
 positive(evaluate(p.physics.thickness,env,D.length),'Thickness');positive(evaluate(p.mesh?.size,env,D.length),'Mesh size');
 for(const m of p.materials){
  for(const [key,dim] of [['k',D.thermal],['rho',D.density],['cp',D.capacity],['sigma',D.conductivity],['epsilonR',D.one]])positive(evaluate(m[key],env,dim),`${m.name}: ${key}`);
  evaluate(m.alpha,env,D.invTemperature);positive(evaluate(m.Tref,env,D.temperature),'Reference temperature');
 }
 for(const s of p.shapes){if(!['rectangle','circle','polygon'].includes(s.type)||!['add','subtract'].includes(s.operation))throw Error('Unknown geometry operation');if(s.operation==='add'&&!p.materials.some(m=>m.id===s.material))throw Error(`Missing material on ${s.name}`);}
 if(!Number.isFinite(p.study.tolerance)||p.study.tolerance<1e-13||p.study.tolerance>1e-2)throw Error('Solver tolerance must be between 1e-13 and 1e-2');
 if(!Number.isInteger(p.study.maxIterations)||p.study.maxIterations<1||p.study.maxIterations>20000)throw Error('Invalid linear iteration limit');
 if(!Number.isInteger(p.study.maxNonlinear)||p.study.maxNonlinear<1||p.study.maxNonlinear>300)throw Error('Invalid nonlinear iteration limit');
 if(!(p.study.nonlinearTolerance>0&&p.study.nonlinearTolerance<1))throw Error('Invalid nonlinear tolerance');
 if(!(p.study.relaxation>0&&p.study.relaxation<=1))throw Error('Relaxation must be in (0, 1]');
 if(!['auto','cpu','gpu'].includes(p.study.backend))throw Error('Unknown compute backend');
 if(p.study.type==='transient'){positive(evaluate(p.study.dt,env,D.time),'Time step');positive(evaluate(p.study.end,env,D.time),'End time');if(evaluate(p.study.end,env,D.time)/evaluate(p.study.dt,env,D.time)>500)throw Error('At most 500 retained time steps; increase dt');}
 for(const bc of p.boundaries){if(typeof bc.selector!=='string'||!['insulation','temperature','flux','convection'].includes(bc.heat?.type)||!['insulation','potential','flux'].includes(bc.electric?.type))throw Error('Invalid boundary condition');}
 return env;
}
/** Snapshot transactions are bounded and atomic; a pointer gesture is one transaction. */
export class History{
 constructor(project,limit=80){this.present=clone(project);this.past=[];this.future=[];this.limit=limit;this.revision=0;}
 commit(next){this.past.push(this.present);if(this.past.length>this.limit)this.past.shift();this.present=clone(next);this.future=[];this.revision++;return this.present;}
 undo(){if(!this.past.length)return null;this.future.push(this.present);this.present=this.past.pop();this.revision++;return this.present;}
 redo(){if(!this.future.length)return null;this.past.push(this.present);this.present=this.future.pop();this.revision++;return this.present;}
}
