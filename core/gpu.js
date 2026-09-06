import {scaleSPD,pcg,relativeResidual,norm,residual} from './sparse.js';

// One buffer arena for vectors avoids storage-binding pressure. The CSR matrix
// is symmetric-diagonally scaled before f32 upload. No float atomics are used.
const SHADER=/* wgsl */`
struct Config { n:u32, groups:u32, tolerance2:f32, pad:u32 }
@group(0) @binding(0) var<storage,read> rows:array<u32>;
@group(0) @binding(1) var<storage,read> cols:array<u32>;
@group(0) @binding(2) var<storage,read> vals:array<f32>;
@group(0) @binding(3) var<storage,read_write> vectors:array<f32>;
@group(0) @binding(4) var<storage,read_write> partial:array<vec2<f32>>;
@group(0) @binding(5) var<storage,read_write> scalars:array<f32>;
@group(0) @binding(6) var<uniform> cfg:Config;
var<workgroup> scratch:array<f32,128>;
// vectors: x | r | p | Ap. scalars: rr | alpha | beta | status | pAp
@compute @workgroup_size(128)
fn spmv(@builtin(global_invocation_id) gid:vec3<u32>){
 let i=gid.x;if(i>=cfg.n||scalars[3]!=0.0){return;}
 var sum=0.0;for(var k=rows[i];k<rows[i+1u];k++){sum+=vals[k]*vectors[2u*cfg.n+cols[k]];}
 vectors[3u*cfg.n+i]=sum;
}
@compute @workgroup_size(128)
fn product(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(local_invocation_index) lid:u32,@builtin(workgroup_id) wid:vec3<u32>){
 var v=0.0;if(gid.x<cfg.n){v=vectors[2u*cfg.n+gid.x]*vectors[3u*cfg.n+gid.x];}
 scratch[lid]=v;workgroupBarrier();
 for(var stride=64u;stride>0u;stride/=2u){if(lid<stride){scratch[lid]+=scratch[lid+stride];}workgroupBarrier();}
 if(lid==0u){partial[wid.x].x=scratch[0];}
}
@compute @workgroup_size(1)
fn alpha(){
 if(scalars[3]!=0.0){return;}var sum=0.0;for(var i=0u;i<cfg.groups;i++){sum+=partial[i].x;}
 scalars[4]=sum;
 if(!(sum>0.0)){scalars[3]=2.0;return;}scalars[1]=scalars[0]/sum;
}
@compute @workgroup_size(128)
fn update(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(local_invocation_index) lid:u32,@builtin(workgroup_id) wid:vec3<u32>){
 let i=gid.x;var rr=0.0;
 if(i<cfg.n&&scalars[3]==0.0){
  vectors[i]+=scalars[1]*vectors[2u*cfg.n+i];
  let r=vectors[cfg.n+i]-scalars[1]*vectors[3u*cfg.n+i];vectors[cfg.n+i]=r;rr=r*r;
 }
 scratch[lid]=rr;workgroupBarrier();
 for(var stride=64u;stride>0u;stride/=2u){if(lid<stride){scratch[lid]+=scratch[lid+stride];}workgroupBarrier();}
 if(lid==0u){partial[wid.x].y=scratch[0];}
}
@compute @workgroup_size(1)
fn beta(){
 if(scalars[3]!=0.0){return;}var sum=0.0;for(var i=0u;i<cfg.groups;i++){sum+=partial[i].y;}
 scalars[2]=sum/scalars[0];scalars[0]=sum;
 if(sum<=cfg.tolerance2){scalars[3]=1.0;}
}
@compute @workgroup_size(128)
fn direction(@builtin(global_invocation_id) gid:vec3<u32>){
 let i=gid.x;if(i>=cfg.n||scalars[3]!=0.0){return;}
 vectors[2u*cfg.n+i]=vectors[cfg.n+i]+scalars[2]*vectors[2u*cfg.n+i];
}
`;
export class GPUCompute{
 constructor(){this.device=null;this.unavailable=null;this.dispatches=0;}
 async initialize(){
  if(this.device)return true;if(this.unavailable)return false;
  try{
   if(!globalThis.navigator?.gpu)throw Error('WebGPU is not available in this worker');
   const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No WebGPU compute adapter');
   this.device=await adapter.requestDevice();this.device.lost.then(info=>{this.device=null;this.unavailable=`GPU device lost: ${info.message}`;});
   this.device.pushErrorScope('validation');
   const module=this.device.createShaderModule({code:SHADER,label:'AetherField CSR conjugate gradient'});
   const diagnostics=await module.getCompilationInfo();const errors=diagnostics.messages.filter(x=>x.type==='error');
   if(errors.length)throw Error(errors.map(x=>x.message).join('\n'));
   // An explicit shared layout is required: per-entry-point auto layouts differ.
   const entries=Array.from({length:7},(_,i)=>({binding:i,visibility:GPUShaderStage.COMPUTE,buffer:{type:i<3?'read-only-storage':i===6?'uniform':'storage'}}));
   this.layout=this.device.createBindGroupLayout({entries});const layout=this.device.createPipelineLayout({bindGroupLayouts:[this.layout]});
   this.pipelines={};for(const entryPoint of ['spmv','product','alpha','update','beta','direction'])this.pipelines[entryPoint]=await this.device.createComputePipelineAsync({layout,compute:{module,entryPoint}});
   const validation=await this.device.popErrorScope();if(validation)throw Error(validation.message);
   this.name=adapter.info?.description||adapter.info?.device||'WebGPU compute';return true;
  }catch(error){this.unavailable=error.message;this.device?.destroy();this.device=null;return false;}
 }
 async solve(A,b,options){
  if(!await this.initialize())throw Error(this.unavailable);
  const n=A.n;if(!n)return pcg(A,b,options);
  const scaled=scaleSPD(A,b,options.x0),B=scaled.A,bb=scaled.b,initial=scaled.x;
  const r=residual(B,initial,bb),bn=norm(bb),rr=norm(r)**2;
  if(bn===0||Math.sqrt(rr)/bn<2e-6)return pcg(A,b,options);
  const device=this.device,allocated=[];
  const make=(data,usage)=>{
   const size=Math.max(16,Math.ceil((typeof data==='number'?data:data.byteLength)/4)*4),buffer=device.createBuffer({size,usage});allocated.push(buffer);
   if(typeof data!=='number')device.queue.writeBuffer(buffer,0,data);return buffer;
  };
  try{
   const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
   const arena=new Float32Array(n*4);arena.set(initial,0);arena.set(r,n);arena.set(r,n*2);
   const groups=Math.ceil(n/128),cfg=new ArrayBuffer(16);new Uint32Array(cfg).set([n,groups,0,0]);new Float32Array(cfg)[2]=(Math.max(options.tolerance,3e-6)*bn)**2;
   const buffers=[make(B.rowPtr,storage),make(B.col,storage),make(Float32Array.from(B.values),storage),make(arena,storage),make(groups*8,storage),make(Float32Array.from([rr,0,0,0,0,0,0,0]),storage),make(new Uint8Array(cfg),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)];
   const group=device.createBindGroup({layout:this.layout,entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
   const read=make(32,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST),out=make(n*4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
   let iterations=0,rel=Math.sqrt(rr)/bn;const history=[rel];
   while(iterations<options.maxIterations){
    const batch=Math.min(12,options.maxIterations-iterations),encoder=device.createCommandEncoder();
    const pass=encoder.beginComputePass();pass.setBindGroup(0,group);
    for(let i=0;i<batch;i++)for(const entry of ['spmv','product','alpha','update','beta','direction']){pass.setPipeline(this.pipelines[entry]);pass.dispatchWorkgroups(entry==='alpha'||entry==='beta'?1:groups);this.dispatches++;}
    pass.end();encoder.copyBufferToBuffer(buffers[5],0,read,0,32);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const state=new Float32Array(read.getMappedRange()).slice();read.unmap();iterations+=batch;
    rel=Math.sqrt(state[0])/bn;history.push(rel);options.onIteration?.({iteration:iterations,residual:rel,label:options.label,backend:'WebGPU f32'});
    if(!Number.isFinite(rel)||state[3]===2)break;
    if(state[3]===1)break;
   }
   const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffers[3],0,out,0,n*4);device.queue.submit([encoder.finish()]);
   await out.mapAsync(GPUMapMode.READ);const solution=scaled.unscale(new Float32Array(out.getMappedRange()).slice());out.unmap();
   const verified=relativeResidual(A,solution,b);
   // The original Float64 matrix is the acceptance authority, not a GPU flag.
   const corrected=pcg(A,b,{...options,x0:Number.isFinite(verified)?solution:options.x0});
   return {...corrected,iterations:iterations+corrected.iterations,gpuIterations:iterations,cpuIterations:corrected.iterations,gpuResidual:verified,history:[...history,...corrected.history],backend:'WebGPU f32 + Float64 correction'};
  }finally{for(const b of allocated)b.destroy();}
 }
}
