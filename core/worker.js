import {validateProject} from './model.js';
import {generateMesh} from './mesh.js';
import {runStudy} from './study.js';
import {GPUCompute} from './gpu.js';
import {runBenchmarks} from '../tests/benchmarks.js';
const gpu=new GPUCompute();
function transfers(value,buffers=new Set()){
 if(ArrayBuffer.isView(value)){buffers.add(value.buffer);return buffers;}
 if(value&&typeof value==='object')for(const v of Object.values(value))transfers(v,buffers);return buffers;
}
self.onmessage=async({data})=>{
 const {id,action,project,mesh}=data;
 const progress=event=>self.postMessage({id,type:'progress',event});
 try{
  let result;
  if(action==='mesh')result=generateMesh(project,validateProject(project),progress);
  else if(action==='benchmarks')result=await runBenchmarks(t=>progress({phase:'benchmark',test:t,message:`${t.passed?'PASS':'FAIL'} · ${t.name}${t.error?`: ${t.error}`:''}`}));
  else result=await runStudy(project,{mesh,progress,gpu});
  self.postMessage({id,type:'result',result,gpuDispatches:gpu.dispatches},[...transfers(result)]);
 }catch(error){self.postMessage({id,type:'error',message:error.message,stack:error.stack});}
};
