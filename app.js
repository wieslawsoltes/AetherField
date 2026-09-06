import {defaultProject,simpleProject,clone,History,validateProject,uid} from './core/model.js';
import {evaluate,resolveParameters,dimensionText,D,spatialEnvironment} from './core/units.js';
import {polygonize,boundsOf,pointInPolygon,pointSegmentDistance} from './core/geometry.js';
import {MeshLocator,boundaryMatches} from './core/mesh.js';
import {range} from './core/fem.js';
import {parseProject,projectJSON,resultJSON,resultsCSV,elementsCSV,probesCSV,vtk} from './core/io.js';
import {FieldRenderer,FIELDS,formatNumber as fmt} from './view/renderer.js';
const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORAGE='aetherfield.project.v1';
let initial=defaultProject(),restored=false;
try{const saved=localStorage.getItem(STORAGE);if(saved){initial=parseProject(saved);restored=true;}}catch(error){console.warn('Local project was not restored:',error.message);}
const history=new History(initial);
const state={project:history.present,mesh:null,result:null,run:0,frame:0,tab:'home',selected:'physics',mode:'results',tool:'probe',bottom:'log',logs:[],benchmarks:null,busy:false,job:0,worker:null,drag:null,polygon:[],snap:true,subtract:false,tablePage:0,recordIndex:null,liveHistory:[],gpuDispatches:0,collapsed:false,play:null};
const renderer=new FieldRenderer($('#gpu-canvas'),$('#overlay-canvas'),(backend,reason)=>{
 $('#render-status').textContent=backend;if(reason)log(`${backend}: ${reason}`,'info');
});
const activeRun=()=>state.result?.runs[state.run]||null,activeFrame=()=>activeRun()?.frames[state.frame]||null;
const isThermal=()=>['heat','joule'].includes(state.project.physics.mode);
const isElectric=()=>state.project.physics.mode!=='heat';
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6500);}
function log(message,level='info'){
 state.logs.push({message,level,time:new Date().toLocaleTimeString('en-GB')});if(state.logs.length>400)state.logs.shift();$('#message-count').textContent=state.logs.length;
 if(state.bottom==='log')renderBottom();
}
function persist(){try{localStorage.setItem(STORAGE,projectJSON(state.project));$('#save-status').textContent='Saved locally';}catch(error){$('#save-status').textContent='Not saved';toast(`Local storage failed: ${error.message}. Export the project to keep your work.`);}}
function stopAnimation(){if(state.play){clearInterval(state.play);state.play=null;}$('#play-button').textContent='▶';}
function cancelJob(message='Computation cancelled'){
 if(state.worker)state.worker.terminate();state.worker=null;state.job++;state.busy=false;$('#busy-overlay').hidden=true;$('#ready-dot').style.background='';
 if(message)log(message,'warning');updateStatus();
}
function invalidate(meshChanged=true){
 if(state.busy)cancelJob('Inputs changed; the previous computation was cancelled.');stopAnimation();state.result=null;state.run=0;state.frame=0;if(meshChanged)state.mesh=null;state.mode=meshChanged?'geometry':'mesh';state.gpuDispatches=0;
}
function commit(mutator,{meshChanged=true,solveChanged=true,message=null}={}){
 try{
  const next=clone(state.project);mutator(next);const env=validateProject(next);polygonize(next,env,evaluate(next.mesh.size,env,D.length));
  history.commit(next);state.project=history.present;
  if(solveChanged)invalidate(meshChanged);else updateProbes();
  persist();renderAll();if(message)log(message,'info');return true;
 }catch(error){toast(error.message);log(error.message,'error');return false;}
}
function updateProbes(){
 if(!state.result)return;
 for(const run of state.result.runs){const locator=new MeshLocator(run.mesh);run.probes=state.project.probes.map(p=>({...p,samples:run.frames.map(f=>({time:f.time,T:f.T?locator.sample(f.T,p.x,p.y):null,V:f.V?locator.sample(f.V,p.x,p.y):null}))}));}
}
function loadProject(p){
 cancelJob(null);history.commit(p);state.project=history.present;state.mesh=null;state.result=null;state.run=0;state.frame=0;state.selected='physics';state.mode='geometry';renderer.hasFitted=false;persist();renderAll();$('#modal').close();log(`Opened “${p.name}”.`,'info');startJob('solve');
}
function setPath(object,path,value){const parts=path.split('.');let target=object;for(const key of parts.slice(0,-1)){if(!Object.hasOwn(target,key))throw Error('Invalid property binding');target=target[key];}const last=parts.at(-1);if(['__proto__','prototype','constructor'].includes(last))throw Error('Invalid property');target[last]=value;}
function getPath(object,path){return path.split('.').reduce((o,k)=>o?.[k],object);}
function bindInput(path,value,extra=''){return `<input data-path="${esc(path)}" value="${esc(value)}" ${extra}>`;}
function inputRow(label,path,unit='',help='',extra=''){return `<div class="form-row"><label>${esc(label)}${unit?`<span class="field-unit">${esc(unit)}</span>`:''}</label>${bindInput(path,getPath(state.project,path),extra)}${help?`<small>${help}</small>`:''}</div>`;}
function selectRow(label,path,options,help=''){return `<div class="form-row"><label>${esc(label)}</label><select data-path="${esc(path)}">${options.map(([value,name])=>`<option value="${esc(value)}" ${getPath(state.project,path)===value?'selected':''}>${esc(name)}</option>`).join('')}</select>${help?`<small>${help}</small>`:''}</div>`;}
function section(title,content){return `<section class="settings-section"><h3>${esc(title)}</h3>${content}</section>`;}
function heading(symbol,title,subtitle){return `<div class="settings-title"><span class="setting-symbol">${symbol}</span><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div>`;}
function smallButton(action,text,classes=''){return `<button class="button ${classes}" data-action="${action}">${text}</button>`;}
function ribbonButton(action,icon,label,classes='',tool=false){return `<button class="ribbon-button ${classes}" ${tool?'data-tool':'data-action'}="${action}"><span class="ribbon-icon">${icon}</span><span>${label}</span></button>`;}
const stack=(items)=>`<div class="ribbon-stack">${items.map(([action,icon,label])=>`<button class="ribbon-small" data-action="${action}"><span>${icon}</span><span>${label}</span></button>`).join('')}</div>`;
const group=(label,content)=>`<div class="ribbon-group"><div class="ribbon-controls">${content}</div><div class="ribbon-label">${label}</div></div>`;
function renderRibbon(){
 const b=ribbonButton,p=state.project,tab=state.tab;
 const project=group('Project',b('new','▱','New')+stack([['open','↥','Open project'],['save','▣','Save project'],['examples','◫','Model library']]));
 const geometry=group('Geometry',b('rectangle','▭','Rectangle',state.tool==='rectangle'?'active':'',true)+b('circle','◯','Circle',state.tool==='circle'?'active':'',true)+b('polygon','⬡','Polygon',state.tool==='polygon'?'active':'',true)+stack([['subtract','⊖',state.subtract?'Subtract ✓':'Subtract'],['snap','⌗',state.snap?'Snap ✓':'Snap'],['delete','×','Delete']]));
 const physics=group('Physics',b('show-physics','♨','Heat transfer','thermal')+b('show-physics','ϟ',p.physics.mode==='electrostatics'?'Electrostatics':'Electric currents','electric')+stack([['show-materials','◒','Materials'],['show-boundaries','▱','Boundary conditions'],['show-parameters','ƒ','Parameters']]));
 const study=group('Study',b(state.busy?'cancel':'solve',state.busy?'■':'▷',state.busy?'Cancel':'Compute','primary')+b('mesh','△','Build mesh')+stack([['show-study','◷',p.study.type==='stationary'?'Stationary study':'Time-dependent'],['show-sweep','⋮','Parameter sweep'],['refine','▦','Refine mesh']]));
 const results=group('Results',b('show-results','◈','Surface plot')+stack([['export','↧','Export results'],['show-probes','⊙','Point probes'],['benchmarks','✓','Validate solver']]));
 const materials=group('Material definitions',b('add-material','◒','Add material')+b('show-materials','▤','Material settings')+b('show-parameters','ƒ','Parameters'));
 const mesh=group('Triangular mesh',b('mesh','△','Build all','primary')+b('refine','▦','Refine ×2')+b('coarsen','▱','Coarsen ×2')+b('show-mesh','◴','Quality inspection'));
 const studies=group('Study configuration',b('stationary','◎','Stationary')+b('transient','◷','Time dependent')+b('show-sweep','⋮','Parameter sweep')+b('show-study','⚙','Solver settings'));
 const fields=group('Visualization',b('field-temperature','♨','Temperature','thermal')+b('field-potential','ϟ','Potential','electric')+b('toggle-contours','≋','Contours',p.view.contours?'active':'')+b('toggle-vectors','↗','Vectors',p.view.vectors?'active':'')+b('toggle-mesh','△','Element edges',p.view.mesh?'active':''));
 const snippets={home:project+geometry+physics+study+results,geometry:geometry+group('Geometry operations',b('duplicate','⧉','Duplicate')+b('move-up','↑','Earlier')+b('move-down','↓','Later')+b('fit','⛶','Fit view'))+materials+mesh,materials:materials+physics+study,physics:physics+group('Interfaces',b('mode-heat','♨','Heat transfer','thermal')+b('mode-electrostatics','ϟ','Electrostatics','electric')+b('mode-current','↯','Electric currents','electric')+b('mode-joule','♨','Joule heating','thermal'))+study,mesh:mesh+group('Inspection',b('toggle-mesh','△','Show edges')+b('field-quality','◴','Element quality')+b('fit','⛶','Fit mesh'))+study,study:studies+study+group('Verification',b('benchmarks','✓','Run benchmarks')+b('show-convergence','⌁','Convergence'))+results,results:fields+results+group('Export',b('csv','▤','Nodal CSV')+b('vtk','⬡','VTK mesh')+b('png','▣','Plot image'))};
 $('#ribbon').innerHTML=snippets[tab];$$('[data-tab]').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
}
function renderTree(){
 const p=state.project,filter=$('#tree-search').value.toLowerCase();let rows='';
 const node=(key,label,icon,level=0,classes='',count='',parent=false)=>{
  if(filter&&!label.toLowerCase().includes(filter)&&level>0)return;
  rows+=`<button role="treeitem" aria-selected="${state.selected===key}" class="tree-node ${state.selected===key?'selected':''}" data-node="${esc(key)}" style="padding-left:${10+level*17}px"><span class="tree-arrow">${parent?'▾':''}</span><span class="tree-icon ${classes}">${icon}</span><span class="tree-label">${esc(label)}</span>${count?`<span class="tree-count">${count}</span>`:''}</button>`;
 };
 node('model',p.name,'◈',0,'','',true);
 node('parameters','Global Definitions','▧',1,'','',true);if(!state.collapsed)node('parameters','Parameters','ƒ',2,'',p.parameters.length);
 node('component','Component 1 (2D)','▣',1,'','',true);
 node('geometry','Geometry 1','◇',2,'shape',p.shapes.length,true);
 if(!state.collapsed)for(const s of p.shapes)node(`shape:${s.id}`,s.name,s.type==='rectangle'?'▭':s.type==='circle'?'◯':'⬡',3,'shape',s.operation==='subtract'?'−':'');
 node('materials','Materials','◒',2,'','',true);
 if(!state.collapsed)for(const m of p.materials)node(`material:${m.id}`,m.name.split(' · ')[0],'◒',3,'');
 if(isThermal())node('physics','Heat Transfer in Solids (ht)','♨',2,'heat','',true);
 if(isElectric())node('physics',p.physics.mode==='electrostatics'?'Electrostatics (es)':'Electric Currents (ec)','ϟ',2,'electric','',true);
 if(p.physics.mode==='joule')node('physics','Electromagnetic Heating','∞',3,'heat');
 node('boundaries','Boundary Conditions','▱',2,'','',true);
 if(!state.collapsed)for(const b of p.boundaries)node(`boundary:${b.id}`,b.name||b.selector,'↦',3,'green');
 node('mesh','Mesh 1','△',2,'shape',state.mesh?'✓':'');
 node('study','Study 1','◷',1,'','',true);
 if(!state.collapsed){node('study',p.study.type==='stationary'?'Stationary':'Time Dependent', '◎',2);if(p.study.sweep.enabled)node('sweep','Parametric Sweep','⋮',2);node('convergence','Solver Configuration','⚙',2);}
 node('results','Results','◈',1,'result','',true);
 if(!state.collapsed){if(isThermal())node('field:temperature','Temperature (ht)','◈',2,'result');if(isElectric())node('field:potential','Electric Potential','◈',2,'result');if(p.physics.mode==='joule')node('field:joule','Joule Heating','◈',2,'result');node('probes','Point Probes','⊙',2,'green',p.probes.length);node('validation','Solver Validation','✓',2,'green');}
 $('#model-tree').innerHTML=rows;
}
function boundaryOptions(){
 const options=[['left','Exterior: left'],['right','Exterior: right'],['top','Exterior: top'],['bottom','Exterior: bottom'],['all','All exposed boundaries']];
 for(const s of state.project.shapes){options.push([`shape:${s.id}`,`All exposed edges: ${s.name}`]);if(s.type==='rectangle')for(const side of ['left','right','bottom','top'])options.push([`${s.id}:${side}`,`${s.name} / ${side}`]);else if(s.type==='circle')options.push([`${s.id}:curve`,`${s.name} / circumference`]);else s.points.forEach((_,i)=>options.push([`${s.id}:edge${i+1}`,`${s.name} / edge ${i+1}`]));}
 return options;
}
function renderSettings(){
 const p=state.project,key=state.selected;let html='';
 if(key==='parameters'){
  let env=null;try{env=resolveParameters(p.parameters);}catch{}
  html=heading('ƒ','Parameters','Global Definitions')+section('Global parameters',p.parameters.map((v,i)=>`<div class="param-row">${bindInput(`parameters.${i}.name`,v.name)}${bindInput(`parameters.${i}.expression`,v.expression)}<button data-remove-param="${i}" title="Remove parameter">×</button></div><div class="param-value">${env?`${fmt(env[v.name].v)} ${esc(dimensionText(env[v.name].d))}`:'Invalid dependency'}</div>`).join('')+smallButton('add-parameter','＋ Add parameter'))+section('Expression syntax','<div class="help-text">Use SI quantities such as <b>10[mm]</b>, <b>25[degC]</b>, or <b>300[K]</b>. Parameter dependencies are evaluated automatically. Spatial expressions can use x, y, t and pi; multiply explicitly with *.</div><div class="equation">Q = 2e5[W/m³]</div>');
 }else if(key.startsWith('shape:')){
  const i=p.shapes.findIndex(s=>s.id===key.slice(6)),s=p.shapes[i];if(!s){state.selected='geometry';return renderSettings();}
  const path=`shapes.${i}`;
  html=heading(s.type==='circle'?'◯':s.type==='rectangle'?'▭':'⬡',s.name,'Geometry 1 / '+s.type)+section('Object',inputRow('Label',`${path}.name`)+selectRow('Boolean operation',`${path}.operation`,[['add','Add / override material'],['subtract','Subtract from current domain']]))+section('Size and position',s.type==='polygon'?`<div class="form-row"><label>Vertices · x, y (SI or units)</label><textarea id="polygon-vertices" data-shape-index="${i}" rows="7">${esc(s.points.map(v=>v.join(', ')).join('\n'))}</textarea><small>One x, y pair per line. Self-intersections are rejected.</small></div>`:`<div class="form-grid">${inputRow(s.type==='circle'?'Center x':'Position x',`${path}.x`,'m')}${inputRow(s.type==='circle'?'Center y':'Position y',`${path}.y`,'m')}</div>`+(s.type==='rectangle'?`<div class="form-grid">${inputRow('Width',`${path}.width`,'m')}${inputRow('Height',`${path}.height`,'m')}</div>`:inputRow('Radius',`${path}.radius`,'m')))+section('Domain material',selectRow('Material',`${path}.material`,p.materials.map(m=>[m.id,m.name]))+`<p class="help-text">Additive objects form a union. In overlaps, the later object owns the material. Subtractions remove the current domain.</p><div class="settings-actions">${smallButton('duplicate','Duplicate')}${smallButton('delete','Delete','danger')}</div>`)+section('Direct manipulation','<p class="help-text">Use Select to drag the object. Drag a corner handle to resize rectangles or circles. Snapping is 1 mm; hold Alt to bypass it. A drag is one undo step.</p>');
 }else if(key==='geometry'||key==='component'){
  html=heading('◇','Geometry 1','Planar Boolean construction')+section('Construction',`<div class="settings-actions">${smallButton('draw-rectangle','▭ Rectangle')}${smallButton('draw-circle','◯ Circle')}${smallButton('draw-polygon','⬡ Polygon')}</div><p class="help-text">Draw directly in the Graphics view, or select an existing object to edit its dimensions.</p><label class="switch-row"><input type="checkbox" id="subtract-check" ${state.subtract?'checked':''}> Subtract new geometry</label><label class="switch-row"><input type="checkbox" id="snap-check" ${state.snap?'checked':''}> Snap to 1 mm grid</label>`)+section('Construction order',p.shapes.map(s=>`<button class="tree-node" data-node="shape:${esc(s.id)}" style="padding:0 4px"><span class="tree-icon">${s.operation==='subtract'?'⊖':'⊕'}</span><span class="tree-label">${esc(s.name)}</span></button>`).join(''))+section('Geometry kernel','<p class="help-text">Rectangles, polygonized circles and simple polygons. The mesher splits intersecting segments and preserves material interfaces. Curves use 24–256 straight segments. Near-coincident/sliver constraints are rejected rather than approximated silently.</p>');
 }else if(key.startsWith('material:')||key==='materials'){
  let i=key==='materials'?0:p.materials.findIndex(m=>m.id===key.slice(9));if(i<0)i=0;const m=p.materials[i],path=`materials.${i}`;
  html=heading('◒',m.name.split(' · ')[0],'Material / isotropic properties')+section('Material',inputRow('Name',`${path}.name`)+`<div class="selection-box">${p.shapes.filter(s=>s.operation==='add'&&s.material===m.id).map(s=>esc(s.name)).join(', ')||'Not assigned to a domain'}</div>`)+section('Thermal properties',inputRow('Thermal conductivity k',`${path}.k`,'W/(m·K)')+inputRow('Density ρ',`${path}.rho`,'kg/m³')+inputRow('Heat capacity Cp',`${path}.cp`,'J/(kg·K)'))+section('Electrical properties',inputRow('Reference conductivity σ₀',`${path}.sigma`,'S/m')+inputRow('Relative permittivity εᵣ',`${path}.epsilonR`,'1')+inputRow('Temperature coefficient α',`${path}.alpha`,'1/K')+inputRow('Reference temperature',`${path}.Tref`,'K')+'<div class="equation">σ(T) = σ₀ / [1 + α(T − Tref)]</div><p class="help-text">Conductivity drives electric currents. Permittivity drives electrostatics. Demonstration material values are illustrative, not a certified material database.</p>')+section('Materials',smallButton('add-material','＋ Add material'));
 }else if(key==='boundaries'||key.startsWith('boundary:')){
  const i=key==='boundaries'?0:p.boundaries.findIndex(b=>b.id===key.slice(9)),bc=p.boundaries[i];
  if(!bc){html=heading('▱','Boundary Conditions','Exposed edges only')+section('Selection',smallButton('add-boundary','＋ Add boundary condition'));}
  else{const path=`boundaries.${i}`;
   html=heading('▱',bc.name,'Boundary condition')+section('Selection',inputRow('Label',`${path}.name`)+selectRow('Boundary selection',`${path}.selector`,boundaryOptions())+`<div class="selection-box">${state.mesh?state.mesh.boundaries.filter(e=>boundaryMatches(e,bc.selector)).length+' matching mesh edges':'Build the mesh to inspect selected edges'}</div><p class="help-text">Use the boundary tool (B) to select an exposed edge in Graphics. Untagged boundaries are insulated by default.</p>`);
   if(isThermal())html+=section('Heat transfer',selectRow('Condition',`${path}.heat.type`,[['insulation','Thermal insulation'],['temperature','Prescribed temperature'],['flux','Inward heat flux'],['convection','Convective heat flux']])+(bc.heat.type==='temperature'?inputRow('Temperature',`${path}.heat.value`,'K'):bc.heat.type==='flux'?inputRow('Inward flux',`${path}.heat.value`,'W/m²','Positive values add heat to the domain.'):bc.heat.type==='convection'?inputRow('Heat transfer coefficient h',`${path}.heat.h`,'W/(m²·K)')+inputRow('Ambient temperature',`${path}.heat.ambient`,'K'):'<div class="equation">n · q = 0</div>'));
   if(isElectric())html+=section(p.physics.mode==='electrostatics'?'Electrostatics':'Electric currents',selectRow('Condition',`${path}.electric.type`,[['insulation','Electrical insulation'],['potential','Prescribed potential'],['flux',p.physics.mode==='electrostatics'?'Inward displacement flux':'Inward current density']])+(bc.electric.type!=='insulation'?inputRow(bc.electric.type==='potential'?'Potential':'Inward flux',`${path}.electric.value`,bc.electric.type==='potential'?'V':p.physics.mode==='electrostatics'?'C/m²':'A/m²'):'<div class="equation">n · '+(p.physics.mode==='electrostatics'?'D':'J')+' = 0</div>'));
   html+=section('Conditions',`<div class="settings-actions">${smallButton('add-boundary','＋ Add condition')}${smallButton('delete-boundary','Remove','danger')}</div>`);
  }
 }else if(key==='mesh'){
  const m=state.mesh;let histogram='';if(m){const bins=Array(10).fill(0);for(const q of m.quality)bins[Math.min(9,Math.floor(q*10))]++;const max=Math.max(...bins);histogram=`<div class="quality-histogram">${bins.map((v,i)=>`<div style="height:${Math.max(2,v/max*48)}px" title="${(i/10).toFixed(1)}–${((i+1)/10).toFixed(1)}: ${v} elements"></div>`).join('')}</div><div class="quality-labels"><span>0 · degenerate</span><span>1 · equilateral</span></div>`;}
  html=heading('△','Mesh 1','Constrained triangular mesh')+section('Element size',inputRow('Target edge length','mesh.size','m','Enter a parameter or a value such as 2.5[mm].')+'<div class="settings-actions">'+smallButton('mesh','Build mesh','teal')+smallButton('refine','Refine ×2')+smallButton('coarsen','Coarsen ×2')+'</div>')+section('Mesh statistics',m?`<div class="info-metrics"><div class="info-metric"><strong>${m.stats.nodes.toLocaleString()}</strong><span>Vertices</span></div><div class="info-metric"><strong>${m.stats.elements.toLocaleString()}</strong><span>P1 triangles</span></div><div class="info-metric"><strong>${fmt(m.stats.minQuality,3)}</strong><span>Minimum quality</span></div><div class="info-metric"><strong>${fmt(m.stats.meanQuality,3)}</strong><span>Mean quality</span></div></div><p class="help-text">${m.stats.components} connected component(s) · ${m.boundaries.length} exterior edges<br>Area: ${fmt(m.stats.area*1e6,6)} mm²</p>`:'<p class="help-text">Build a mesh to inspect its quality and topology.</p>')+section('Quality distribution',histogram+'<div class="equation">q = 4√3 A / (a² + b² + c²)</div><p class="help-text">Geometry edges and material interfaces are recovered before domain classification. Every element must have positive area.</p>');
 }else if(key==='study'||key==='sweep'||key==='convergence'){
  html=heading('◷','Study 1','Numerical study configuration')+section('Study',selectRow('Study type','study.type',[['stationary','Stationary'],['transient','Time dependent']])+(p.study.type==='transient'?inputRow('Time step Δt','study.dt','s')+inputRow('End time','study.end','s')+'<div class="equation">(M/Δt + K) Tⁿ⁺¹ = fⁿ⁺¹ + MTⁿ/Δt</div><p class="help-text">Implicit backward Euler with consistent mass. Electrostatic/current solutions are quasistatic at each time, not electromagnetic wave propagation.</p>':'<div class="equation">K u = f</div>'))+section('Linear solver',selectRow('Compute backend','study.backend',[['auto','WebGPU + Float64 verification (auto)'],['cpu','Float64 PCG in Web Worker'],['gpu','WebGPU + Float64 verification']])+inputRow('Relative tolerance','study.tolerance','','', 'type="number" min="1e-13" max="1e-2" step="any" data-number')+inputRow('Maximum iterations','study.maxIterations','','','type="number" min="1" max="20000" data-number')+'<p class="help-text">GPU CG uses scaled Float32 buffers. The original Float64 system verifies convergence and supplies a corrective solve when required.</p>');
  if(p.physics.mode==='joule')html+=section('Multiphysics coupling',inputRow('Coupled residual tolerance','study.nonlinearTolerance','','','type="number" step="any" data-number')+inputRow('Picard iteration limit','study.maxNonlinear','','','type="number" data-number')+inputRow('Under-relaxation','study.relaxation','','','type="number" min="0.01" max="1" step="0.05" data-number'));
  html+=section('Parameter sweep',`<label class="switch-row"><input type="checkbox" data-path="study.sweep.enabled" ${p.study.sweep.enabled?'checked':''}> Enable parameter sweep</label>`+selectRow('Parameter','study.sweep.parameter',p.parameters.map(v=>[v.name,v.name]))+inputRow('Values','study.sweep.values','','Comma-separated expressions; at most 16 independent cases.'))+section('Compute',smallButton(state.busy?'cancel':'solve',state.busy?'Cancel computation':'▷ Compute study','teal'));
 }else if(key==='results'||key.startsWith('field:')){
  const f=activeFrame(),field=FIELDS[p.view.field],run=activeRun();
  html=heading('◈',field?.name||'Results','Computed finite-element solution')+section('Expression',selectRow('Field','view.field',availableFields())+`<div class="settings-view-checks"><label class="check-line"><input type="checkbox" data-path="view.mesh" ${p.view.mesh?'checked':''}> Mesh</label><label class="check-line"><input type="checkbox" data-path="view.contours" ${p.view.contours?'checked':''}> Contours</label><label class="check-line"><input type="checkbox" data-path="view.vectors" ${p.view.vectors?'checked':''}> Vectors</label></div>`)+section('Computed values',f?`<table class="mini-table"><tbody>${f.T?`<tr><td>Minimum T</td><td>${fmt(f.summary.temperature.min-273.15)} °C</td></tr><tr><td>Maximum T</td><td>${fmt(f.summary.temperature.max-273.15)} °C</td></tr>`:''}${f.V?`<tr><td>Maximum |E|</td><td>${fmt(f.summary.maxElectricField)} V/m</td></tr>`:''}${p.physics.mode==='joule'||p.physics.mode==='current'?`<tr><td>Joule power</td><td>${fmt(f.summary.joulePower)} W</td></tr>`:''}${p.physics.mode==='electrostatics'?`<tr><td>Stored energy</td><td>${fmt(f.summary.electricEnergy)} J</td></tr>`:''}<tr><td>Coupled residual</td><td>${fmt(f.nonlinear.residual)}</td></tr><tr><td>Compute time</td><td>${fmt(run.elapsed/1000)} s</td></tr></tbody></table>`:'<p class="help-text">No current result. Compute the study after changing model inputs.</p>')+section('Export',`<div class="settings-actions">${smallButton('csv','Nodal CSV')}${smallButton('vtk','VTK')}${smallButton('png','PNG')}${smallButton('export','All exports')}</div><p class="help-text">Temperature and potential are nodal P1 fields. Fluxes and Joule heat are elementwise values, not smoothed across material interfaces.</p>`);
 }else if(key==='probes'){
  const run=activeRun();html=heading('⊙','Point Probes','Barycentric interpolation')+section('Probes',p.probes.map((probe,i)=>`<div class="form-row"><label>${esc(probe.name)} <button data-remove-probe="${i}" style="float:right;color:#a67176">Remove</button></label><div class="form-grid">${bindInput(`probes.${i}.x`,probe.x,'type="number" step="any" data-number')}${bindInput(`probes.${i}.y`,probe.y,'type="number" step="any" data-number')}</div><small>x, y in metres</small></div>`).join('')+smallButton('probe-tool','⊙ Place probe'))+section('Sampling','<p class="help-text">Select the probe tool (P) and click inside a meshed domain. Probe values are evaluated from triangle shape functions and are retained across all time frames and sweep cases. Points outside the domain are reported as empty.</p>'+smallButton('export-probes','Export probe history'));
 }else if(key==='validation'){
  html=heading('✓','Solver Validation','Analytical and regression benchmarks')+section('Numerical tests',`<p class="help-text">Run the bundled tests against analytical heat, electrostatic, transient and Joule-heating solutions. Tests exercise the same modules as the model solver.</p>${smallButton('benchmarks',state.busy?'Computation in progress':'Run benchmarks','teal')}`)+section('Last report',state.benchmarks?`<div class="info-metric"><strong>${state.benchmarks.passed} / ${state.benchmarks.total}</strong><span>Tests passed</span></div>`:'<p class="help-text">No benchmark run in this session.</p>');
 }else if(key==='model'){
  html=heading('◈','Model','AetherField project')+section('Project',inputRow('Name','name')+`<p class="help-text">Project identity: ${esc(p.id)}<br>All inputs are stored locally in your browser. Export a project file for portable persistence.</p><div class="settings-actions">${smallButton('save','Save project')}${smallButton('examples','Model library')}</div>`)+section('Scope','<p class="help-text">Planar isotropic heat transfer, electrostatics, DC conduction and coupled Joule heating. This is an independent simulation workbench, not COMSOL software or a .mph reader.</p>');
 }else{
  const mode=p.physics.mode,labels={joule:'Joule Heating',heat:'Heat Transfer in Solids',electrostatics:'Electrostatics',current:'Electric Currents'};
  html=heading(mode==='electrostatics'?'ϟ':'♨',labels[mode],'Component 1 / multiphysics')+section('Physics interface',selectRow('Active interface','physics.mode',[['joule','Joule heating (ht + ec)'],['heat','Heat transfer in solids'],['electrostatics','Electrostatics'],['current','Electric currents (DC)']])+`<div class="selection-box">All ${p.shapes.filter(s=>s.operation==='add').length} additive geometry objects</div>`)+section('Governing equations',(isThermal()?'<div class="equation">ρCₚ ∂T/∂t − ∇ · (k∇T) = Q'+(mode==='joule'?' + Qⱼ':'')+'</div>':'')+(isElectric()?'<div class="equation">−∇ · ('+(mode==='electrostatics'?'ε':'σ')+'∇V) = '+(mode==='electrostatics'?'ρᵥ':'0')+'</div>':'')+(mode==='joule'?'<div class="equation">Qⱼ = σ |∇V|²</div>':'')+'<p class="help-text">'+(mode==='joule'?'Two-way temperature–conductivity coupling uses verified Picard iterations. Electric currents—not dielectric electrostatics—supply Joule heat.':mode==='electrostatics'?'Permittivity and volume charge define the electrostatic field. No artificial Joule heating is added to a dielectric solution.':'A continuous P1 finite-element field is assembled from physical material properties.')+'</p>')+section('Physical inputs',inputRow('Out-of-plane thickness','physics.thickness','m')+(isThermal()?inputRow('Volumetric heat source','physics.heatSource','W/m³','May depend on x, y, t and parameters.')+inputRow('Initial temperature','physics.initial','K','Used at t = 0 for time-dependent studies.'):inputRow('Reference temperature','physics.initial','K'))+(mode==='electrostatics'?inputRow('Volume charge density','physics.spaceCharge','C/m³'):''))+section('Boundary conditions',p.boundaries.map(b=>`<button class="tree-node" data-node="boundary:${esc(b.id)}" style="padding-left:2px"><span class="tree-icon green">↦</span><span>${esc(b.name)}</span></button>`).join('')+`<p class="help-text">Unassigned exterior boundaries have zero natural flux. A stationary component requires a temperature/potential reference or thermal convection.</p>`)+section('Study',`<div class="settings-actions">${smallButton('show-study','Study settings')}${smallButton('solve','▷ Compute','teal')}</div>`);
 }
 $('#settings').innerHTML=html;
}
function availableFields(){const p=state.project,list=[];if(isThermal())list.push(['temperature','Temperature (°C)'],['heatFlux','Heat flux (W/m²)']);if(isElectric())list.push(['potential','Electric potential (V)'],['electricField','Electric field (V/m)']);if(['joule','current'].includes(p.physics.mode))list.push(['joule','Joule heat density (W/m³)']);list.push(['quality','Element quality']);return list;}
function selectNode(key){
 state.selected=key;
 if(key.startsWith('field:')){const field=key.slice(6);if(availableFields().some(f=>f[0]===field)){state.project.view.field=field;state.mode='results';}}
 if(key.startsWith('shape:')||key==='geometry'){state.mode='geometry';setTool('select',false);}
 if(key==='mesh')state.mode='mesh';
 if(key==='results')state.mode='results';
 if(key==='probes'){state.bottom='probes';setTool('probe',false);}
 if(key==='validation')state.bottom='benchmarks';if(key==='convergence')state.bottom='convergence';
 renderTree();renderSettings();renderWorkspace();renderBottom();
}
function renderWorkspace(){
 const run=activeRun(),frame=activeFrame(),p=state.project;
 if(run)state.mesh=run.mesh;
 if(!availableFields().some(v=>v[0]===p.view.field))p.view.field=isThermal()?'temperature':'potential';
 const field=FIELDS[p.view.field],hasResult=!!frame&&state.mode==='results';
 const selectedBoundary=state.selected.startsWith('boundary:')?p.boundaries.find(b=>b.id===state.selected.slice(9))?.selector:state.selected==='boundaries'?p.boundaries[0]?.selector:null;
 renderer.setScene({project:state.project,mesh:state.mesh,frame,field:p.view.field,mode:state.mode,options:p.view,selectedShape:state.selected.startsWith('shape:')?state.selected.slice(6):null,selectedBoundary});
 $('#field-select').innerHTML=availableFields().map(([key,label])=>`<option value="${key}" ${p.view.field===key?'selected':''}>${label}</option>`).join('');
 $('#field-select').disabled=!state.mesh;
 $('#plot-title').textContent=state.mode==='geometry'?'Geometry':state.mode==='mesh'?'Finite element mesh':field.name;
 $('#plot-eyebrow').textContent=state.mode==='geometry'?'COMPONENT 1 / GEOMETRY 1':state.mode==='mesh'?'COMPONENT 1 / MESH 1':`STUDY 1 / ${p.study.type==='stationary'?'STATIONARY':'TIME DEPENDENT'}`;
 $('#plot-subtitle').textContent=hasResult?`${field.node?'Surface':'Element'}: ${field.name.toLowerCase()} (${field.unit})${p.study.type==='transient'?` · t = ${fmt(frame.time)} s`:''}`:state.mode==='geometry'?'Parametric objects · Boolean union and subtraction':state.mesh?`${state.mesh.stats.elements.toLocaleString()} P1 triangles · minimum quality ${fmt(state.mesh.stats.minQuality,3)}`:'No current solution — build and compute the model';
 $('#result-pill').innerHTML=`<span class="pulse"></span>${state.busy?'Computing':hasResult?'Converged':state.mode==='mesh'&&state.mesh?'Mesh verified':'Model inputs'}`;
 $('#view-tab-label').textContent=field.name;
 $$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.mode));
 $('#mesh-toggle').classList.toggle('active',p.view.mesh);$('#contour-toggle').classList.toggle('active',p.view.contours);$('#vector-toggle').classList.toggle('active',p.view.vectors);
 $('#run-select').innerHTML=state.result?state.result.runs.map((r,i)=>`<option value="${i}" ${i===state.run?'selected':''}>${r.parameter?`${esc(r.parameter.name)} = ${esc(r.parameter.expression)}`:'Solution 1 (sol1)'}</option>`).join(''):'<option>No solution</option>';
 $('#run-select').disabled=!state.result;
 $('#time-slider').max=Math.max(0,(run?.frames.length||1)-1);$('#time-slider').value=state.frame;$('#time-slider').disabled=!run||run.frames.length<2;$('#play-button').disabled=!run||run.frames.length<2;
 $('#time-label').textContent=run?(run.frames.length===1?'Stationary solution':`t = ${fmt(frame.time)} s · ${state.frame+1}/${run.frames.length}`):'No solution';
 updateStatus();
}
function updateStatus(){
 $('#document-title').textContent=state.project.name+' — AetherField';document.title=`${state.project.name} — AetherField`;
 $('#status-text').textContent=state.busy?'Computing…':state.result?'Solution current':state.mesh?'Mesh ready':'Ready to build';
 $('#mesh-status').textContent=state.mesh?`${state.mesh.stats.nodes.toLocaleString()} nodes · ${state.mesh.stats.elements.toLocaleString()} elements`:'No mesh';
 $('#compute-status').textContent=state.gpuDispatches?`${state.gpuDispatches.toLocaleString()} GPU dispatches · f64 verified`:'Float64 FEM';
 $('#undo').disabled=!history.past.length;$('#redo').disabled=!history.future.length;
 $$('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===state.tool));
}
function renderAll(){renderRibbon();renderTree();renderSettings();renderWorkspace();renderBottom();}
function table(headers,rows){return `<table class="data-table"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
function renderBottom(){
 const root=$('#diagnostic-content'),run=activeRun(),frame=activeFrame();$$('[data-bottom]').forEach(b=>b.classList.toggle('active',b.dataset.bottom===state.bottom));
 if(state.bottom==='log'){
  const nearBottom=root.scrollTop+root.clientHeight>=root.scrollHeight-35;
  root.innerHTML=state.logs.map(l=>`<div class="log-row ${l.level}"><span class="time">${l.time}</span><span class="level">${l.level.toUpperCase()}</span><span class="message">${esc(l.message)}</span></div>`).join('');if(nearBottom||state.busy)root.scrollTop=root.scrollHeight;
 }else if(state.bottom==='convergence'){
  const records=run?.records||[],automatic=records.reduce((best,r,i)=>r.history.length>(records[best]?.history.length||0)?i:best,0),index=state.recordIndex??automatic,record=records[index]||records[automatic],values=state.busy?state.liveHistory:record?.history||[],residual=record?.relativeResidual;
  if(!values.length){root.innerHTML='<div class="empty-state"><strong>No convergence history yet</strong>Compute a study to inspect true solver residuals.</div>';return;}
  const w=600,h=116,pad=37,maxLog=Math.max(0,...values.map(v=>Math.log10(Math.max(v,1e-14)))),minLog=Math.min(-10,...values.map(v=>Math.log10(Math.max(v,1e-14)))),points=values.map((v,i)=>`${pad+(w-pad-12)*i/Math.max(1,values.length-1)},${10+(h-30)*(maxLog-Math.log10(Math.max(v,1e-14)))/(maxLog-minLog)}`).join(' ');
  let grid='';for(let i=0;i<=4;i++){const y=10+i*(h-30)/4,exponent=Math.round(maxLog-(maxLog-minLog)*i/4);grid+=`<line x1="${pad}" y1="${y}" x2="${w-12}" y2="${y}" stroke="#e6edf2"/><text x="${pad-7}" y="${y+3}" text-anchor="end" font-size="9" fill="#8b9daa">1e${exponent}</text>`;}
  root.innerHTML=`<div class="convergence-wrap"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Actual linear solver residual history">${grid}<polyline points="${points}" fill="none" stroke="#1597a4" stroke-width="1.6" vector-effect="non-scaling-stroke"/><text x="${pad}" y="${h-2}" font-size="9" fill="#8b9daa">0</text><text x="${w-12}" y="${h-2}" text-anchor="end" font-size="9" fill="#8b9daa">${values.length-1} iterations / samples</text></svg><div class="convergence-metrics">${records.length&&!state.busy?`<select id="convergence-record" aria-label="Linear solve record">${records.map((r,i)=>`<option value="${i}" ${r===record?'selected':''}>${i+1}. ${esc(r.label)}</option>`).join('')}</select>`:''}<span>True relative residual</span><strong>${fmt(state.busy?values.at(-1):residual,3)}</strong><span>${esc(record?.backend||'Live linear solve')}</span><p>${record?`${record.diagnostics.dofs.toLocaleString()} free DOFs · ${record.diagnostics.nonzeros.toLocaleString()} nonzeros`:state.liveLabel||''}</p>${frame?.nonlinear.iterations>1?`<p>Picard: ${frame.nonlinear.iterations} iterations<br>Coupled residual: ${fmt(frame.nonlinear.residual,3)}</p>`:''}</div></div>`;
 }else if(state.bottom==='table'){
  if(!run||!frame){root.innerHTML='<div class="empty-state"><strong>No computed data</strong>Compute a study to populate the nodal table.</div>';return;}
  const n=run.mesh.nodes.length/2,pageSize=120,start=Math.min(state.tablePage*pageSize,Math.max(0,n-pageSize)),end=Math.min(n,start+pageSize),rows=[];
  for(let i=start;i<end;i++)rows.push([i,fmt(run.mesh.nodes[2*i]*1000,6),fmt(run.mesh.nodes[2*i+1]*1000,6),frame.T?fmt(frame.T[i],7):'—',frame.V?fmt(frame.V[i],7):'—']);
  root.innerHTML=`<div class="table-note">Nodes ${start+1}–${end} of ${n} · full precision in CSV <button data-action="table-prev">‹ Previous</button><button data-action="table-next">Next ›</button><button data-action="csv" style="float:right">Export all</button></div>`+table(['Node','x (mm)','y (mm)','Temperature (K)','Potential (V)'],rows);
 }else if(state.bottom==='probes'){
  const probes=run?.probes||[],rows=probes.map(p=>{const sample=p.samples[state.frame];return [esc(p.name),fmt(p.x*1000),fmt(p.y*1000),fmt(sample?.T,7),fmt(sample?.V,7)];});
  root.innerHTML=rows.length?`<div class="table-note">Barycentric point samples · “—” means outside the domain <button data-action="export-probes" style="float:right">Export time histories</button></div>`+table(['Probe','x (mm)','y (mm)','T (K)','V (V)'],rows):'<div class="empty-state"><strong>Probe the solution</strong>Use the probe tool (P) and click inside the computed field.</div>';
 }else if(state.bottom==='sweep'){
  root.innerHTML=state.result?table(['Case','Parameter','Max T (°C)','Joule power (W)','Energy (J)','Compute (s)'],state.result.runs.map((r,i)=>{const f=r.frames.at(-1);return [i+1,r.parameter?esc(`${r.parameter.name} = ${r.parameter.expression}`):'Single case',f.T?fmt(f.summary.temperature.max-273.15,6):'—',fmt(f.summary.joulePower,6),fmt(f.summary.electricEnergy,6),fmt(r.elapsed/1000)];})):'<div class="empty-state"><strong>No sweep results</strong>Enable a parameter sweep in Study settings, then compute.</div>';
 }else{
  const report=state.benchmarks;root.innerHTML=report?`<div class="table-note">${report.passed} / ${report.total} passed · same numerical modules as the interactive solver</div>`+table(['Status','Benchmark','Metric','Time (ms)'],report.tests.map(t=>[`<span class="${t.passed?'validation-pass':'validation-fail'}">${t.passed?'PASS':'FAIL'}</span>`,esc(t.name),esc(!t.passed?t.error:t.error!==undefined?fmt(t.error,5):t.order!==undefined?`order ${fmt(t.order)}`:t.residual!==undefined?`residual ${fmt(t.residual)}`:t.metric||'Verified'),fmt(t.elapsed)])):`<div class="empty-state"><strong>Analytical validation suite</strong>Heat, electrostatics, transient decay, multiphysics and mesh regression.<br>${smallButton('benchmarks','Run benchmarks','teal')}</div>`;
 }
}
async function startJob(action='solve'){
 if(state.busy)cancelJob(null);stopAnimation();
 try{validateProject(state.project);}catch(e){toast(e.message);return;}
 const id=++state.job,worker=new Worker(new URL('./core/worker.js',import.meta.url),{type:'module'});state.worker=worker;state.busy=true;state.recordIndex=null;state.liveHistory=[];state.gpuDispatches=0;
 $('#busy-overlay').hidden=false;$('#busy-text').textContent=action==='benchmarks'?'Running analytical benchmarks…':action==='mesh'?'Building constrained triangular mesh…':'Assembling finite-element systems…';$('#ready-dot').style.background='#dba250';
 if(action==='benchmarks'){state.benchmarks={passed:0,total:0,tests:[]};state.bottom='benchmarks';}
 else{state.result=null;if(action==='mesh')state.mesh=null;}
 log(action==='benchmarks'?'Analytical validation started.':action==='mesh'?'Building Mesh 1.':'Study 1 started. All displayed results will be recomputed.','info');renderAll();
 let lastPaint=0;
 worker.onmessage=({data})=>{
  if(data.id!==state.job)return;
  if(data.type==='progress'){
   const e=data.event;if(e.message){$('#busy-text').textContent=e.message;log(e.message,e.phase==='warning'?'warning':e.phase==='complete'?'complete':'info');}
   if(e.phase==='iteration'){
    if(state.liveLabel!==e.label){state.liveLabel=e.label;state.liveHistory=[];}state.liveHistory.push(e.residual);
    if(state.bottom==='convergence'&&performance.now()-lastPaint>80){renderBottom();lastPaint=performance.now();}
   }
   if(e.phase==='benchmark'){state.benchmarks.tests.push(e.test);state.benchmarks.total++;if(e.test.passed)state.benchmarks.passed++;renderBottom();}
  }else if(data.type==='result'){
   state.busy=false;state.worker=null;worker.terminate();$('#busy-overlay').hidden=true;$('#ready-dot').style.background='';
   if(action==='mesh'){state.mesh=data.result;state.mode='mesh';state.selected='mesh';log('Mesh 1 built and topology checks passed.','complete');}
   else if(action==='benchmarks'){state.benchmarks=data.result;state.bottom='benchmarks';log(`${data.result.passed}/${data.result.total} benchmark tests passed.`,'complete');}
   else{
    state.result=data.result;state.run=0;state.frame=state.result.runs[0].frames.length-1;state.mesh=activeRun().mesh;state.mode='results';state.gpuDispatches=data.gpuDispatches;updateProbes();
    const f=activeFrame(),run=activeRun();log(`Solution accepted · ${f.T?'Tmax '+fmt(f.summary.temperature.max-273.15,6)+' °C · ':''}${isElectric()?'Joule power '+fmt(f.summary.joulePower,6)+' W · ':''}true residual ${fmt(run.records.at(-1)?.relativeResidual,3)}.`, 'complete');
    if(state.bottom==='log')state.bottom='convergence';
   }
   renderAll();window.dispatchEvent(new CustomEvent('aetherfield:complete',{detail:{action}}));
  }else if(data.type==='error'){
   state.busy=false;state.worker=null;worker.terminate();$('#busy-overlay').hidden=true;$('#ready-dot').style.background='';log(data.message,'error');toast(data.message);state.bottom='log';state.mode=state.mesh?'mesh':'geometry';renderAll();window.dispatchEvent(new CustomEvent('aetherfield:error',{detail:data}));
  }
 };
 worker.onerror=e=>{if(id!==state.job)return;cancelJob(null);log(e.message,'error');toast('Worker failed: '+e.message);renderAll();};
 worker.postMessage({id,action,project:clone(state.project),mesh:action==='solve'?state.mesh:null});
}
function setTool(tool,refresh=true){
 state.tool=tool;state.polygon=[];renderer.preview=null;
 const hints={select:'Drag objects to move · drag corner handles to resize · Alt bypasses snapping',boundary:'Click an exposed mesh edge to assign its boundary condition',probe:'Click the model to add a probe · scroll to zoom · middle-drag to pan',pan:'Drag to pan · scroll to zoom · F to fit',rectangle:'Drag to construct a rectangle · dimensions snap to 1 mm',circle:'Drag from the center to construct a circle',polygon:'Click vertices · Enter or double-click to finish · Escape to cancel'};
 $('#tool-hint').textContent=hints[tool]||'';$('#overlay-canvas').style.cursor=tool==='pan'?'grab':tool==='select'?'default':'crosshair';
 if(['rectangle','circle','polygon'].includes(tool))state.mode='geometry';if(refresh){renderRibbon();renderWorkspace();}
}
function openModal(title,html){$('#modal-title').textContent=title;$('#modal-content').innerHTML=html;$('#modal').showModal();}
function download(name,data,type='application/octet-stream'){
 const blob=data instanceof Blob?data:new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function fileStem(){return state.project.name.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,90)||'AetherField';}
function requireResult(){if(!activeFrame()){toast('Compute a study first. There is no current result to export.');return false;}return true;}
async function action(name){
 if(name==='close-modal')return $('#modal').close();
 if(name==='save'){persist();download(fileStem()+'.afield',projectJSON(state.project),'application/json');return;}
 if(name==='open')return $('#project-file').click();
 if(name==='new'||name==='examples')return openModal('Model library',`<p>Start with an editable model. Each example is meshed and solved when opened.</p><div class="example-grid"><button class="example-card" data-example="heater"><span>♨</span><strong>Perforated resistive heater</strong><small>Two materials · Boolean holes · two-way Joule coupling</small></button><button class="example-card" data-example="heat"><span>▭</span><strong>Thermal conduction slab</strong><small>Stationary heat transfer · prescribed end temperatures</small></button><button class="example-card" data-example="electrostatics"><span>ϟ</span><strong>Parallel-plate capacitor</strong><small>Electrostatics · potential · field · stored energy</small></button><button class="example-card" data-example="transient"><span>◷</span><strong>Transient thermal diffusion</strong><small>Implicit time stepping · initial state · probe histories</small></button></div>`);
 if(name==='undo'||name==='redo'){const p=history[name]();if(p){state.project=p;invalidate(true);persist();renderAll();}return;}
 if(name==='solve'||name==='mesh'||name==='benchmarks'){if(name==='benchmarks')state.selected='validation';return startJob(name);}
 if(name==='cancel'){cancelJob();return renderAll();}
 if(name==='fit')return renderer.fit();if(name==='zoom-in'||name==='zoom-out')return renderer.zoomAt(name==='zoom-in'?1.3:1/1.3,renderer.size.w/2,renderer.size.h/2);
 const selections={'show-physics':'physics','show-parameters':'parameters','show-materials':'materials','show-boundaries':'boundaries','show-mesh':'mesh','show-study':'study','show-sweep':'sweep','show-results':'results','show-probes':'probes','show-convergence':'convergence'};
 if(selections[name])return selectNode(selections[name]);
 if(name.startsWith('field-')){const field=name.slice(6);if(!availableFields().some(f=>f[0]===field)){toast('This field is not part of the active physics interface.');return;}state.project.view.field=field;state.selected='field:'+field;state.mode='results';renderAll();return;}
 if(name.startsWith('toggle-')&&['mesh','contours','vectors'].includes(name.slice(7))){const key=name.slice(7);return commit(p=>p.view[key]=!p.view[key],{meshChanged:false,solveChanged:false});}
 if(name==='toggle-settings'){if(innerWidth<=950)document.body.classList.toggle('mobile-settings');else document.body.classList.toggle('settings-hidden');return;}
 if(name==='refine'||name==='coarsen'){const h=evaluate(state.project.mesh.size,resolveParameters(state.project.parameters),D.length);if(commit(p=>p.mesh.size=`${h*(name==='refine'?.5:2)}[m]`))startJob('mesh');return;}
 if(name==='stationary'||name==='transient'){commit(p=>p.study.type=name,{meshChanged:false});selectNode('study');return;}
 if(name.startsWith('mode-')){commit(p=>p.physics.mode=name.slice(5),{meshChanged:false});selectNode('physics');return;}
 if(name==='snap'||name==='subtract'){state[name]=!state[name];renderRibbon();renderSettings();return;}
 if(name==='draw-rectangle'||name==='draw-circle'||name==='draw-polygon')return setTool(name.slice(5));
 if(name==='probe-tool')return setTool('probe');
 if(name==='delete'||name==='duplicate'||name==='move-up'||name==='move-down'){
  if(!state.selected.startsWith('shape:')){toast('Select a geometry object in the Model Builder first.');return;}
  const id=state.selected.slice(6),index=state.project.shapes.findIndex(s=>s.id===id);if(index<0)return;
  let selected=id;
  const success=commit(p=>{
   if(name==='delete'){p.shapes.splice(index,1);p.boundaries=p.boundaries.filter(b=>!b.selector.startsWith(id+':')&&b.selector!==`shape:${id}`);}
   else if(name==='duplicate'){const s=clone(p.shapes[index]);s.id=uid('shape');s.name+=' copy';const env=resolveParameters(p.parameters);if(s.type==='polygon')s.points=s.points.map(([x,y])=>[`${evaluate(x,env,D.length)+.005}[m]`,`${evaluate(y,env,D.length)+.005}[m]`]);else{s.x=`${evaluate(s.x,env,D.length)+.005}[m]`;s.y=`${evaluate(s.y,env,D.length)+.005}[m]`;}p.shapes.push(s);selected=s.id;}
   else{const next=index+(name==='move-up'?-1:1);if(next<0||next>=p.shapes.length)throw Error('Object is already at the end of the construction order');[p.shapes[index],p.shapes[next]]=[p.shapes[next],p.shapes[index]];}
  });if(success)selectNode(name==='delete'?'geometry':'shape:'+selected);return;
 }
 if(name==='add-material'){let id=uid('material');commit(p=>p.materials.push({...clone(p.materials[0]),id,name:'Custom material'}),{meshChanged:false});selectNode('material:'+id);return;}
 if(name==='add-parameter'){commit(p=>{let i=1;while(p.parameters.some(v=>v.name==='param'+i))i++;p.parameters.push({name:'param'+i,expression:'1'});});selectNode('parameters');return;}
 if(name==='add-boundary'){addBoundary('top');return;}
 if(name==='delete-boundary'){
  const id=state.selected.startsWith('boundary:')?state.selected.slice(9):state.project.boundaries[0]?.id;commit(p=>p.boundaries=p.boundaries.filter(v=>v.id!==id),{meshChanged:false});selectNode('boundaries');return;
 }
 if(name==='collapse-tree'){state.collapsed=!state.collapsed;renderTree();return;}
 if(name==='clear-log'){state.logs=[];renderBottom();$('#message-count').textContent='0';return;}
 if(name==='table-prev'||name==='table-next'){state.tablePage=Math.max(0,state.tablePage+(name==='table-next'?1:-1));renderBottom();return;}
 if(name==='play'){
  if(state.play){stopAnimation();return;}const run=activeRun();if(!run||run.frames.length<2)return;
  $('#play-button').textContent='Ⅱ';state.play=setInterval(()=>{state.frame=(state.frame+1)%run.frames.length;renderWorkspace();if(state.bottom!=='log')renderBottom();},180);return;
 }
 if(name==='export')return openModal('Export computed results','<p>Exports contain the currently selected computed case and time frame. Raw temperatures are in kelvin; all physical values use SI units.</p><div class="export-grid">'+[['csv','Nodal fields · CSV'],['elements-csv','Element fields · CSV'],['vtk','Mesh and fields · VTK'],['export-json','All cases and frames · JSON'],['export-probes','Probe histories · CSV'],['png','Current plot · PNG']].map(([a,label])=>smallButton(a,label)).join('')+'</div>');
 if(['csv','elements-csv','vtk','export-json','export-probes','png'].includes(name)){
  if(name!=='png'&&!requireResult())return;const run=activeRun(),frame=activeFrame(),stem=fileStem();
  if(name==='csv')download(stem+'-nodes.csv',resultsCSV(run,frame),'text/csv');
  if(name==='elements-csv')download(stem+'-elements.csv',elementsCSV(run,frame),'text/csv');
  if(name==='vtk')download(stem+'.vtk',vtk(run,frame),'text/plain');
  if(name==='export-json')download(stem+'-results.json',resultJSON(state.result),'application/json');
  if(name==='export-probes')download(stem+'-probes.csv',probesCSV(run),'text/csv');
  if(name==='png'){const image=await renderer.snapshot();if(image)download(stem+'.png',image);else toast('The plot image could not be created.');}return;
 }
 if(name==='help')return openModal('AetherField · the numerical workbench',`<p>A standalone, local-first finite-element application. Geometry, materials, boundary conditions and numerical studies are editable; every field is computed from the model.</p><h3>Workflow</h3><p>Construct geometry → assign materials → choose physics and boundary conditions → build a mesh → compute a study → inspect and export results. An input edit invalidates affected solutions.</p><h3>Keyboard and pointer</h3><p><code>Ctrl/Cmd+S</code> save · <code>Ctrl/Cmd+Z</code> undo · <code>Ctrl/Cmd+Shift+Z</code> redo · <code>Ctrl/Cmd+Enter</code> compute<br><code>S</code> select · <code>R</code> rectangle · <code>C</code> circle · <code>B</code> boundary · <code>P</code> probe · <code>F</code> fit<br>Scroll to zoom, middle/right-drag or Space-drag to pan. Enter closes a polygon. Alt disables grid snapping.</p><h3>Numerical implementation</h3><p>P1 conforming triangular finite elements, CSR sparse assembly, consistent thermal mass, symmetric essential-boundary elimination, Jacobi-preconditioned Float64 conjugate gradients and backward Euler. GPU mode runs real WGSL sparse CG, then checks and corrects against the original Float64 matrix. Nonlinear conductivity is solved by under-relaxed Picard iteration with coupled residual tests.</p><h3>Scope and limitations</h3><p>Planar isotropic heat conduction, electrostatics, DC currents and Joule coupling. No radiation, flow, structural mechanics, anisotropy, high-order curved elements, certified material database or native .mph import. Electrostatic time studies are quasistatic sequences, not Maxwell transients. Geometry predicates use normalized Float64 arithmetic, not exact robust predicates; degenerate constraints are rejected. This is an independent implementation, not COMSOL software.</p><h3>Validation and safety</h3><p>Run the analytical benchmark suite from Validation. Solver residuals are not a substitute for mesh/time-step convergence studies or independent engineering verification. Do not use an unverified browser simulation as a safety-critical design authority.</p><h3>Persistence</h3><p>Inputs auto-save to localStorage. Save exports a versioned .afield JSON project. Computed solutions are not embedded in project files; export the full result JSON separately. No project data leaves this browser.</p>`);
}
function addBoundary(selector){
 const existing=state.project.boundaries.find(b=>b.selector===selector);if(existing){selectNode('boundary:'+existing.id);return;}
 const id=uid('bc');
 if(commit(p=>p.boundaries.push({id,name:selector==='top'?'Boundary condition':`Boundary ${selector.split(':').at(-1)}`,selector,heat:{type:'insulation',value:'293.15[K]',h:'10[W/(m^2*K)]',ambient:'293.15[K]'},electric:{type:'insulation',value:'0[V]'}}),{meshChanged:false,solveChanged:false}))selectNode('boundary:'+id);
}
function makeShape(type,points){
 const id=uid('shape'),operation=state.subtract?'subtract':'add',base={id,name:`${operation==='subtract'?'Cut ':''}${type[0].toUpperCase()+type.slice(1)} ${state.project.shapes.length+1}`,type,operation,material:state.project.materials[0].id};
 const quantity=x=>`${Number(x.toPrecision(12))}[m]`;
 if(type==='rectangle'){
  const [a,b]=points,w=Math.abs(b[0]-a[0]),h=Math.abs(b[1]-a[1]);if(w<1e-8||h<1e-8)return;
  Object.assign(base,{x:quantity(Math.min(a[0],b[0])),y:quantity(Math.min(a[1],b[1])),width:quantity(w),height:quantity(h)});
 }else if(type==='circle'){
  const [a,b]=points,r=Math.hypot(b[0]-a[0],b[1]-a[1]);if(r<1e-8)return;Object.assign(base,{x:quantity(a[0]),y:quantity(a[1]),radius:quantity(r)});
 }else{if(points.length<3)return;base.points=points.map(p=>p.map(quantity));}
 if(commit(p=>p.shapes.push(base),{message:`Created ${base.name}.`}))selectNode('shape:'+id);setTool('select');
}
function finishPolygon(){
 const points=state.polygon.slice();if(points.length>2&&Math.hypot(points.at(-1)[0]-points.at(-2)[0],points.at(-1)[1]-points.at(-2)[1])<1e-10)points.pop();
 state.polygon=[];renderer.preview=null;if(points.length>=3)makeShape('polygon',points);else toast('A polygon requires at least three distinct vertices.');renderer.requestDraw();
}
function pickShape(world){return renderer.polygons?.findLast(p=>pointInPolygon(world,p.points))||null;}
function pointerPosition(event){const r=$('#overlay-canvas').getBoundingClientRect();return [event.clientX-r.left,event.clientY-r.top];}
function snapped(world,event){return state.snap&&!event.altKey?world.map(v=>Math.round(v/.001)*.001):world;}
let spaceDown=false;
const canvas=$('#overlay-canvas');
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('wheel',event=>{event.preventDefault();const [x,y]=pointerPosition(event);renderer.zoomAt(Math.exp(-Math.max(-150,Math.min(150,event.deltaY))*.002),x,y);},{passive:false});
canvas.addEventListener('pointerdown',event=>{
 if(event.button!==0&&event.button!==1&&event.button!==2)return;canvas.focus({preventScroll:true});const screen=pointerPosition(event),world=renderer.screenToWorld(...screen),point=snapped(world,event);
 if(event.button===1||event.button===2||state.tool==='pan'||spaceDown){state.drag={kind:'pan',screen};canvas.setPointerCapture(event.pointerId);return;}
 if(state.tool==='rectangle'||state.tool==='circle'){state.drag={kind:'draw',type:state.tool,start:point,end:point};renderer.preview={type:state.tool,a:point,b:point};canvas.setPointerCapture(event.pointerId);return;}
 if(state.tool==='polygon'){state.polygon.push(point);renderer.preview={type:'polygon',points:state.polygon};renderer.requestDraw();return;}
 if(state.tool==='boundary'){
  if(!state.mesh){toast('Build the mesh before selecting its boundaries.');return;}
  const m=state.mesh;let best=null,distance=10/renderer.camera.zoom;
  for(const edge of m.boundaries){const d=pointSegmentDistance(world,[m.nodes[edge.a*2],m.nodes[edge.a*2+1]],[m.nodes[edge.b*2],m.nodes[edge.b*2+1]]);if(d<distance){distance=d;best=edge;}}
  if(best)addBoundary(best.tags[0]);else toast('Click close to an exposed mesh edge.');return;
 }
 if(state.tool==='probe'){
  if(!renderer.locator?.locate(...world)){toast('Place a probe inside a meshed domain, not in a hole.');return;}
  const hit=renderer.locator.locate(...point)?point:world;
  if(commit(p=>p.probes.push({id:uid('probe'),name:`Probe ${p.probes.length+1}`,x:hit[0],y:hit[1]}),{meshChanged:false,solveChanged:false})){state.bottom='probes';renderBottom();}return;
 }
 if(state.tool==='select'){
  const selected=renderer.polygons?.find(p=>p.id===state.selected.slice(6));let handle=null;
  if(selected&&['rectangle','circle'].includes(selected.type)){
   const b=boundsOf([selected]);for(const v of [[b.x0,b.y0],[b.x0,b.y1],[b.x1,b.y0],[b.x1,b.y1]]){const s=renderer.worldToScreen(...v);if(Math.hypot(s[0]-screen[0],s[1]-screen[1])<9)handle={corner:v,opposite:[v[0]===b.x0?b.x1:b.x0,v[1]===b.y0?b.y1:b.y0]};}
  }
  const shape=handle?selected:pickShape(world);if(!shape){state.selected='geometry';renderTree();renderSettings();renderWorkspace();return;}
  selectNode('shape:'+shape.id);
  state.drag={kind:handle?'resize':'move',id:shape.id,start:point,screen,original:clone(state.project.shapes.find(s=>s.id===shape.id)),handle,draft:null};canvas.setPointerCapture(event.pointerId);
 }
});
canvas.addEventListener('pointermove',event=>{
 const screen=pointerPosition(event),world=renderer.screenToWorld(...screen),point=snapped(world,event),d=state.drag;
 $('#coordinate-status').textContent=`x: ${fmt(world[0]*1000,5)}   y: ${fmt(world[1]*1000,5)} mm`;
 if(d){
  $('#probe-tooltip').hidden=true;
  if(d.kind==='pan'){renderer.pan(screen[0]-d.screen[0],screen[1]-d.screen[1]);d.screen=screen;return;}
  if(d.kind==='draw'){d.end=point;renderer.preview={type:d.type,a:d.start,b:point};renderer.requestDraw();return;}
  const env=resolveParameters(state.project.parameters),s=clone(d.original),quantity=v=>`${Number(v.toPrecision(12))}[m]`;
  if(d.kind==='move'){
   const dx=point[0]-d.start[0],dy=point[1]-d.start[1];if(s.type==='polygon')s.points=s.points.map(([x,y])=>[quantity(evaluate(x,env,D.length)+dx),quantity(evaluate(y,env,D.length)+dy)]);else{s.x=quantity(evaluate(s.x,env,D.length)+dx);s.y=quantity(evaluate(s.y,env,D.length)+dy);}
  }else if(s.type==='rectangle'){
   const o=d.handle.opposite;s.x=quantity(Math.min(o[0],point[0]));s.y=quantity(Math.min(o[1],point[1]));s.width=quantity(Math.max(.00001,Math.abs(point[0]-o[0])));s.height=quantity(Math.max(.00001,Math.abs(point[1]-o[1])));
  }else{s.radius=quantity(Math.max(.00001,Math.abs(point[0]-evaluate(s.x,env,D.length)),Math.abs(point[1]-evaluate(s.y,env,D.length))));}
  d.draft=s;const preview=clone(state.project);preview.shapes[preview.shapes.findIndex(x=>x.id===s.id)]=s;
  renderer.setScene({...renderer.scene,project:preview,mesh:null,frame:null,mode:'geometry'});return;
 }
 if(state.tool==='polygon'&&state.polygon.length){renderer.preview={type:'polygon',points:[...state.polygon,point]};renderer.requestDraw();}
 const sample=state.mode==='results'?renderer.sample(...world):null,tip=$('#probe-tooltip');
 if(sample){tip.innerHTML=`<b>${esc(fmt(sample.value,6))} ${esc(sample.unit)}</b><br><span style="opacity:.7">Element ${sample.element}</span>`;tip.style.left=`${Math.min(screen[0]+14,renderer.size.w-150)}px`;tip.style.top=`${Math.max(8,screen[1]-45)}px`;tip.hidden=false;}else tip.hidden=true;
});
canvas.addEventListener('pointerup',event=>{
 const d=state.drag;state.drag=null;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);if(!d)return;
 renderer.preview=null;
 if(d.kind==='draw')makeShape(d.type,[d.start,d.end]);
 else if(d.draft){commit(p=>p.shapes[p.shapes.findIndex(s=>s.id===d.id)]=d.draft,{message:`Updated ${d.draft.name}.`});}
 renderer.requestDraw();
});
canvas.addEventListener('pointercancel',()=>{state.drag=null;renderer.preview=null;renderWorkspace();});
canvas.addEventListener('pointerleave',()=>$('#probe-tooltip').hidden=true);
canvas.addEventListener('dblclick',()=>{if(state.tool==='polygon')finishPolygon();});
document.addEventListener('click',async event=>{
 const target=event.target.closest('button');if(!target)return;
 try{
  if(target.dataset.action)return await action(target.dataset.action);
  if(target.dataset.tool)return setTool(target.dataset.tool);
  if(target.dataset.node)return selectNode(target.dataset.node);
  if(target.dataset.tab){state.tab=target.dataset.tab;renderRibbon();const mapping={geometry:'geometry',materials:'materials',physics:'physics',mesh:'mesh',study:'study',results:'results'};if(mapping[state.tab])selectNode(mapping[state.tab]);return;}
  if(target.dataset.view){state.mode=target.dataset.view;if(state.mode==='mesh')state.selected='mesh';if(state.mode==='geometry')setTool('select',false);renderWorkspace();renderTree();renderSettings();return;}
  if(target.dataset.bottom){state.bottom=target.dataset.bottom;renderBottom();return;}
  if(target.dataset.example){
   const name=target.dataset.example;let p=name==='heater'?defaultProject():simpleProject(name==='electrostatics'?'electrostatics':'heat');
   if(name==='transient'){p.name='Transient thermal diffusion';p.study.type='transient';p.study.dt='10[s]';p.study.end='200[s]';}
   loadProject(p);return;
  }
  if(target.hasAttribute('data-remove-param'))return commit(p=>p.parameters.splice(+target.dataset.removeParam,1));
  if(target.hasAttribute('data-remove-probe'))return commit(p=>p.probes.splice(+target.dataset.removeProbe,1),{meshChanged:false,solveChanged:false});
 }catch(error){toast(error.message);log(error.message,'error');}
});
document.addEventListener('change',event=>{
 const input=event.target;
 if(input.dataset.path){
  const path=input.dataset.path,old=getPath(state.project,path),value=input.type==='checkbox'?input.checked:input.hasAttribute('data-number')?Number(input.value):input.value;
  const presentation=path.startsWith('view.')||path.startsWith('probes.'),geometry=path.startsWith('shapes.')||path.startsWith('parameters.')||path.startsWith('mesh.');
  const success=commit(p=>{
   setPath(p,path,value);
   if(path.endsWith('.heat.type')){
    const parent=getPath(p,path.replace(/\.type$/,''));parent.value=value==='flux'?'0[W/m^2]':'293.15[K]';parent.h||='10[W/(m^2*K)]';parent.ambient||='293.15[K]';
   }
   if(path.endsWith('.electric.type')){const parent=getPath(p,path.replace(/\.type$/,''));parent.value=value==='flux'?(p.physics.mode==='electrostatics'?'0[C/m^2]':'0[A/m^2]'):'0[V]';}
  },{meshChanged:geometry,solveChanged:!presentation});
  if(!success){input.value=old;input.classList.add('invalid');}
  if(path==='view.field'){state.mode='results';renderWorkspace();}
  return;
 }
 if(input.id==='polygon-vertices'){
  const points=input.value.trim().split(/\n+/).map(line=>line.split(',').map(s=>s.trim()));if(points.some(p=>p.length!==2)){toast('Use one x, y pair per line.');return;}
  return commit(p=>p.shapes[+input.dataset.shapeIndex].points=points);
 }
 if(input.id==='subtract-check'){state.subtract=input.checked;renderRibbon();}
 if(input.id==='snap-check'){state.snap=input.checked;renderRibbon();}
 if(input.id==='field-select'){state.project.view.field=input.value;state.mode='results';renderSettings();renderWorkspace();persist();}
 if(input.id==='convergence-record'){state.recordIndex=+input.value;renderBottom();}
 if(input.id==='run-select'){stopAnimation();state.recordIndex=null;state.run=+input.value;state.frame=activeRun().frames.length-1;renderer.hasFitted=false;renderWorkspace();renderSettings();renderBottom();}
});
$('#time-slider').addEventListener('input',event=>{stopAnimation();state.frame=+event.target.value;renderWorkspace();renderBottom();if(state.selected==='results'||state.selected.startsWith('field:'))renderSettings();});
$('#project-file').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{loadProject(parseProject(await file.text()));}catch(error){toast(error.message);log('Open failed: '+error.message,'error');}event.target.value='';});
$('#tree-search').addEventListener('input',renderTree);
document.addEventListener('keydown',event=>{
 const editable=['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName),mod=event.ctrlKey||event.metaKey;
 if(mod&&event.key.toLowerCase()==='s'){event.preventDefault();action('save');return;}
 if(mod&&event.key.toLowerCase()==='z'){event.preventDefault();action(event.shiftKey?'redo':'undo');return;}
 if(mod&&event.key==='Enter'){event.preventDefault();startJob('solve');return;}
 if(mod&&event.key.toLowerCase()==='k'){event.preventDefault();$('#tree-search').focus();return;}
 if(editable||$('#modal').open)return;
 if(event.key===' '){spaceDown=true;event.preventDefault();}
 if(event.key==='Escape'){state.drag=null;state.polygon=[];renderer.preview=null;setTool('select');return;}
 if(event.key==='Enter'&&state.tool==='polygon'){event.preventDefault();finishPolygon();return;}
 if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();action('delete');return;}
 const tools={s:'select',r:'rectangle',c:'circle',b:'boundary',p:'probe'};if(tools[event.key.toLowerCase()]){event.preventDefault();setTool(tools[event.key.toLowerCase()]);}
 if(event.key.toLowerCase()==='f'){event.preventDefault();renderer.fit();}
});
document.addEventListener('keyup',event=>{if(event.key===' ')spaceDown=false;});window.addEventListener('blur',()=>spaceDown=false);
function installSplitter(element,property,min,max,axis='x',reverse=false){
 element.addEventListener('pointerdown',event=>{
  event.preventDefault();element.setPointerCapture(event.pointerId);const initial=parseFloat(getComputedStyle(document.documentElement).getPropertyValue(property)),start=axis==='x'?event.clientX:event.clientY;
  const move=e=>{const delta=((axis==='x'?e.clientX:e.clientY)-start)*(reverse?-1:1);document.documentElement.style.setProperty(property,`${Math.max(min,Math.min(max,initial+delta))}px`);};
  const up=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);};element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);
 });
}
installSplitter($('#tree-splitter'),'--tree-width',160,400);installSplitter($('#settings-splitter'),'--settings-width',220,450);installSplitter($('#bottom-splitter'),'--bottom-height',90,450,'y',true);
// Minimal diagnostics for automated tests and embedding integrations.
window.aetherfield=Object.freeze({get project(){return clone(state.project);},get result(){return state.result;},get mesh(){return state.mesh;},get busy(){return state.busy;},get renderer(){return renderer;},get gpuDispatches(){return state.gpuDispatches;},get benchmarks(){return state.benchmarks;},loadProject,solve:()=>startJob('solve'),runBenchmarks:()=>startJob('benchmarks')});
renderAll();setTool('probe');log(restored?'Restored the locally saved project.':'Opened the perforated resistive heater example.','info');log('Independent 2D FEM kernel · SI dimensional expressions · automatic project persistence.','info');
if(location.protocol==='file:'){toast('Serve this folder over localhost (npm start). Browser module workers cannot run reliably from file://.');log('Use npm start and open http://localhost:8080.','error');}else startJob('solve');
