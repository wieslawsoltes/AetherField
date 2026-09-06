import {GPUCompute} from '../core/gpu.js';
import {simpleProject,clone} from '../core/model.js';
import {solveCase} from '../core/study.js';
import {FieldRenderer} from '../view/renderer.js';
const output=document.querySelector('#report'),report={secureContext:isSecureContext,webgpu:!!navigator.gpu,tests:[]};
const publish=()=>output.textContent=JSON.stringify(report,null,2);
try{
 const gpu=new GPUCompute();if(!await gpu.initialize())throw Error(`NOT RUN: ${gpu.unavailable}`);
 report.adapter=gpu.name;
 let plotted=null,project=null;
 for(const mode of ['heat','electrostatics','joule']){
  const p=simpleProject(mode);p.mesh.size='4[mm]';p.study.backend='cpu';const cpu=await solveCase(p);
  const q=clone(p);q.study.backend='gpu';const before=gpu.dispatches,result=await solveCase(q,{gpu,mesh:cpu.mesh});
  if(gpu.dispatches===before)throw Error(`${mode}: no compute dispatches were executed`);
  if(!result.records.some(r=>r.backend.includes('WebGPU')))throw Error(`${mode}: GPU failed and fell back to CPU`);
  let relativeDifference=0;
  for(const key of ['T','V']){const a=cpu.frames[0][key],b=result.frames[0][key];if(!a)continue;let error=0,scale=0;for(let i=0;i<a.length;i++){error+=(a[i]-b[i])**2;scale+=a[i]**2;}relativeDifference=Math.max(relativeDifference,Math.sqrt(error/Math.max(scale,1e-300)));}
  const residual=Math.max(...result.records.map(r=>r.relativeResidual));
  if(relativeDifference>2e-6||residual>q.study.tolerance*1.1)throw Error(`${mode}: acceptance failed`);
  report.tests.push({mode,passed:true,dispatches:gpu.dispatches-before,relativeDifference,trueResidual:residual,backends:result.records.map(r=>r.backend)});publish();plotted=result;project=q;
 }
 const renderer=new FieldRenderer(document.querySelector('#gpu'),document.querySelector('#overlay'),(status,reason)=>{report.renderer={status,reason};publish();});
 renderer.setScene({project,mesh:plotted.mesh,frame:plotted.frames[0],field:'temperature',mode:'results',options:{mesh:true,contours:true,vectors:false}});
 const until=performance.now()+15000;while(renderer.backend!=='WebGPU'&&performance.now()<until)await new Promise(r=>setTimeout(r,50));
 if(renderer.backend!=='WebGPU')throw Error('GPU rendering pipeline was not created');
 renderer.device.pushErrorScope('validation');renderer.draw();
 await renderer.device.queue.onSubmittedWorkDone();const validation=await renderer.device.popErrorScope();if(validation)throw Error(validation.message);report.status='PASS — compute and rendering pipelines executed';publish();
}catch(error){report.status=error.message.startsWith('NOT RUN:')?'NOT RUN':'FAIL';report.error=error.message;publish();}
window.aetherfieldGPUReport=report;
