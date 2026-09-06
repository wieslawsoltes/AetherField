import {polygonize,boundsOf} from '../core/geometry.js';
import {resolveParameters,evaluate,D} from '../core/units.js';
import {range} from '../core/fem.js';
import {boundaryMatches,MeshLocator} from '../core/mesh.js';
export const FIELDS={
 temperature:{name:'Temperature',symbol:'T',unit:'°C',node:true,key:'T',offset:-273.15},
 potential:{name:'Electric potential',symbol:'V',unit:'V',node:true,key:'V',offset:0},
 heatFlux:{name:'Heat flux magnitude',symbol:'|q|',unit:'W/m²',node:false,key:'heatFlux',offset:0},
 electricField:{name:'Electric field magnitude',symbol:'|E|',unit:'V/m',node:false,key:'electricField',offset:0},
 joule:{name:'Joule heat density',symbol:'Qⱼ',unit:'W/m³',node:false,key:'joule',offset:0},
 quality:{name:'Element quality',symbol:'qₑ',unit:'1',node:false,key:'quality',offset:0}
};
const COLORS=[[39,31,105],[36,92,200],[25,184,202],[75,217,142],[230,228,82],[250,144,45],[193,36,53]];
export function colorMap(t){t=Math.max(0,Math.min(1,t));const f=t*(COLORS.length-1),i=Math.min(COLORS.length-2,Math.floor(f)),a=COLORS[i],b=COLORS[i+1],k=f-i;return a.map((v,j)=>Math.round(v+(b[j]-v)*k));}
export function formatNumber(x,digits=4){if(x===null||x===undefined||!Number.isFinite(x))return '—';if(x===0)return '0';if(Math.abs(x)>=1e5||Math.abs(x)<.001)return x.toExponential(2);return Number(x.toPrecision(digits)).toLocaleString('en-US',{maximumFractionDigits:6});}
const SHADER=/* wgsl */`
struct Uniforms { camera:vec4<f32>, range:vec4<f32> }
@group(0) @binding(0) var<uniform> u:Uniforms;
struct Output { @builtin(position) position:vec4<f32>, @location(0) value:f32 }
@vertex fn vertex(@location(0) position:vec2<f32>,@location(1) value:f32)->Output{
 var o:Output;o.position=vec4<f32>((position-u.camera.xy)*u.camera.zw,0.0,1.0);o.value=value;return o;
}
fn palette(value:f32)->vec3<f32>{
 let x=clamp(value,0.0,1.0)*6.0;
 let c0=vec3<f32>(39,31,105)/255.0;let c1=vec3<f32>(36,92,200)/255.0;let c2=vec3<f32>(25,184,202)/255.0;
 let c3=vec3<f32>(75,217,142)/255.0;let c4=vec3<f32>(230,228,82)/255.0;let c5=vec3<f32>(250,144,45)/255.0;let c6=vec3<f32>(193,36,53)/255.0;
 if(x<1.0){return mix(c0,c1,x);}if(x<2.0){return mix(c1,c2,x-1.0);}if(x<3.0){return mix(c2,c3,x-2.0);}if(x<4.0){return mix(c3,c4,x-3.0);}if(x<5.0){return mix(c4,c5,x-4.0);}return mix(c5,c6,x-5.0);
}
@fragment fn fragment(i:Output)->@location(0) vec4<f32>{
 let t=(i.value-u.range.x)/max(u.range.y-u.range.x,1e-20);var c=palette(t);
 if(u.range.z==0.0){c=mix(vec3<f32>(0.55,0.68,0.76),vec3<f32>(0.82,0.73,0.6),fract(i.value*.39));}
 let contour=t*12.0;let width=max(fwidth(contour)*.75,.009);let line=1.0-smoothstep(0.0,width,abs(fract(contour+.5)-.5));
 if(u.range.w>0.5&&u.range.z>0.5){c=mix(c,c*.53,line*.6);}
 return vec4<f32>(c,1.0);
}`;
export class FieldRenderer{
 constructor(canvas,overlay,onStatus=()=>{}){
  this.canvas=canvas;this.overlay=overlay;this.ctx=overlay.getContext('2d');this.onStatus=onStatus;this.camera={x:.05,y:.03,zoom:1};this.size={w:1,h:1,dpr:1};
  this.scene={};this.backend='Canvas2D';this.vertexCount=0;this.dirty=false;this.locator=null;this.preview=null;this.selected=null;this.hover=null;this.lastMesh=null;
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(overlay.parentElement);queueMicrotask(()=>this.initialize());
 }
 async initialize(){
  try{
   if(!navigator.gpu)throw Error('WebGPU unavailable');const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No GPU adapter');
   this.device=await adapter.requestDevice();this.device.lost.then(info=>{this.backend='Canvas2D';this.device=null;this.canvas.style.display='none';this.onStatus('Canvas2D fallback',info.message);this.requestDraw();});
   this.device.addEventListener('uncapturederror',event=>this.onStatus('GPU error',event.error.message));
   this.gpuContext=this.canvas.getContext('webgpu');const format=navigator.gpu.getPreferredCanvasFormat();
   this.gpuContext.configure({device:this.device,format,alphaMode:'premultiplied'});
   const module=this.device.createShaderModule({code:SHADER,label:'AetherField scalar-field renderer'});const info=await module.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw Error(info.messages.map(m=>m.message).join('\n'));
   this.pipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format}]},primitive:{topology:'triangle-list'}});
   this.uniform=this.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.group=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});
   this.backend='WebGPU';this.onStatus('WebGPU rendering');this.upload();this.requestDraw();
  }catch(error){this.backend='Canvas2D';this.canvas.style.display='none';this.onStatus('Canvas2D fallback',error.message);this.requestDraw();}
 }
 resize(){
  const rect=this.overlay.parentElement.getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height),dpr=Math.min(2,devicePixelRatio||1);
  this.size={w,h,dpr};for(const canvas of [this.canvas,this.overlay]){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;}
  if(!this.hasFitted&&this.scene.bounds)this.fit();this.requestDraw();
 }
 setScene(scene){
  const changed=scene.mesh!==this.scene.mesh||scene.frame!==this.scene.frame||scene.field!==this.scene.field||scene.mode!==this.scene.mode;
  const geometryChanged=scene.project!==this.scene.project;
  this.scene=scene;
  try{this.polygons=polygonize(scene.project,resolveParameters(scene.project.parameters),evaluate(scene.project.mesh.size,resolveParameters(scene.project.parameters),D.length));scene.bounds=scene.mesh?.bounds||boundsOf(this.polygons);}catch{this.polygons=[];scene.bounds={x0:0,y0:0,x1:.1,y1:.06,width:.1,height:.06};}
  if(scene.mesh!==this.lastMesh){this.locator=scene.mesh?new MeshLocator(scene.mesh):null;this.lastMesh=scene.mesh;this.meshPath=null;}
  const meta=FIELDS[scene.field]||FIELDS.temperature;this.meta=meta;this.values=scene.field==='quality'?scene.mesh?.quality:scene.frame?.[meta.key];
  this.dataRange=range(this.values);this.displayRange={min:this.dataRange.min+meta.offset,max:this.dataRange.max+meta.offset};
  if(changed||geometryChanged){this.raster=null;this.upload();}
  if(!this.hasFitted&&scene.bounds)this.fit();this.requestDraw();
 }
 fit(){
  const b=this.scene.bounds;if(!b)return;const {w,h}=this.size;
  this.camera={x:(b.x0+b.x1)/2,y:(b.y0+b.y1)/2,zoom:Math.min(Math.max(100,w-190)/b.width,Math.max(100,h-160)/b.height)};this.hasFitted=w>10;this.requestDraw();
 }
 worldToScreen(x,y){return [(x-this.camera.x)*this.camera.zoom+this.size.w/2,(this.camera.y-y)*this.camera.zoom+this.size.h/2];}
 screenToWorld(x,y){return [(x-this.size.w/2)/this.camera.zoom+this.camera.x,this.camera.y-(y-this.size.h/2)/this.camera.zoom];}
 zoomAt(factor,x,y){const before=this.screenToWorld(x,y);this.camera.zoom=Math.max(10,Math.min(1e8,this.camera.zoom*factor));const after=this.screenToWorld(x,y);this.camera.x+=before[0]-after[0];this.camera.y+=before[1]-after[1];this.requestDraw();}
 pan(dx,dy){this.camera.x-=dx/this.camera.zoom;this.camera.y+=dy/this.camera.zoom;this.requestDraw();}
 upload(){
  if(!this.device||!this.pipeline)return;const m=this.scene.mesh;if(!m){this.vertexCount=0;return;}
  const data=new Float32Array(m.triangles.length*3),hasField=this.scene.mode==='results'&&this.values;
  for(let j=0;j<m.triangles.length;j++){
   const id=m.triangles[j],e=Math.floor(j/3);data[j*3]=m.nodes[id*2];data[j*3+1]=m.nodes[id*2+1];
   data[j*3+2]=hasField?(this.meta.node?this.values[id]:this.values[e]):m.regions[e];
  }
  if(!this.vertex||this.vertex.size<data.byteLength){this.vertex?.destroy();this.vertex=this.device.createBuffer({size:Math.max(256,data.byteLength),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}
  this.device.queue.writeBuffer(this.vertex,0,data);this.vertexCount=m.triangles.length;
 }
 requestDraw(){if(this.dirty)return;this.dirty=true;requestAnimationFrame(()=>{this.dirty=false;this.draw();});}
 draw(){
  const start=performance.now(),{w,h,dpr}=this.size,ctx=this.ctx,s=this.scene;if(!s.project)return;
  const results=s.mode==='results'&&this.values;
  if(this.backend==='WebGPU'&&this.pipeline){
   const u=new Float32Array([this.camera.x,this.camera.y,2*this.camera.zoom/w,2*this.camera.zoom/h,this.dataRange.min,this.dataRange.max,results?1:0,s.options?.contours&&results?1:0]);this.device.queue.writeBuffer(this.uniform,0,u);
   const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:this.gpuContext.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
   if(this.vertexCount){pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.setVertexBuffer(0,this.vertex);pass.draw(this.vertexCount);}pass.end();this.device.queue.submit([encoder.finish()]);
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  if(this.backend!=='WebGPU'&&s.mesh){if(results)this.drawRaster(ctx);else this.drawMeshFaces(ctx);}
  if(!s.mesh)this.drawGeometry(ctx);
  if(s.mesh&&(s.options?.mesh||s.mode==='mesh'))this.drawMesh(ctx);
  if(s.mesh)this.drawBoundaries(ctx);
  if(results&&this.backend!=='WebGPU'&&s.options?.contours)this.drawContours(ctx);
  if(results&&s.options?.vectors)this.drawVectors(ctx);
  this.drawSelection(ctx);this.drawAxes(ctx);
  if(results)this.drawLegend(ctx);
  for(const probe of s.project.probes){const [x,y]=this.worldToScreen(probe.x,probe.y);ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#14374a';ctx.lineWidth=1.5;ctx.stroke();ctx.font='11px system-ui';ctx.fillStyle='#243c4c';ctx.fillText(probe.name,x+9,y-8);}
  if(this.preview){ctx.strokeStyle='#008fa1';ctx.fillStyle='#009aa01a';ctx.lineWidth=1.6;ctx.setLineDash([5,4]);ctx.beginPath();const p=this.preview;
   if(p.type==='circle'){const [x,y]=this.worldToScreen(p.a[0],p.a[1]),b=this.worldToScreen(p.b[0],p.b[1]);ctx.arc(x,y,Math.hypot(b[0]-x,b[1]-y),0,Math.PI*2);}else if(p.type==='polygon'){p.points.forEach((p,i)=>{const s=this.worldToScreen(...p);i?ctx.lineTo(...s):ctx.moveTo(...s);});}else{const a=this.worldToScreen(...p.a),b=this.worldToScreen(...p.b);ctx.rect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}ctx.fill();ctx.stroke();ctx.setLineDash([]);
  }
  this.lastDrawMs=performance.now()-start;
 }
 drawGeometry(ctx){
  for(const p of this.polygons||[]){ctx.beginPath();p.points.forEach((v,i)=>{const xy=this.worldToScreen(...v);i?ctx.lineTo(...xy):ctx.moveTo(...xy);});ctx.closePath();ctx.fillStyle=p.operation==='subtract'?'#f5f8fa':this.scene.project.materials.find(m=>m.id===p.material)?.color||'#90a9bd';ctx.fill();ctx.strokeStyle=p.operation==='subtract'?'#688392':'#506e83';ctx.lineWidth=1.2;ctx.stroke();}
 }
 drawMeshFaces(ctx){const m=this.scene.mesh;for(let e=0;e<m.areas.length;e++){ctx.beginPath();for(let i=0;i<3;i++){const id=m.triangles[e*3+i],p=this.worldToScreen(m.nodes[id*2],m.nodes[id*2+1]);i?ctx.lineTo(...p):ctx.moveTo(...p);}ctx.closePath();const shape=this.scene.project.shapes[m.regions[e]],material=this.scene.project.materials.find(v=>v.id===shape?.material);ctx.fillStyle=material?.color||'#94adbd';ctx.fill();}}
 drawRaster(ctx){
  if(!this.raster){
   const m=this.scene.mesh,b=m.bounds,extent=Math.max(b.width,b.height),width=Math.max(1,Math.round(1000*b.width/extent)),height=Math.max(1,Math.round(1000*b.height/extent)),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
   const c=canvas.getContext('2d'),image=c.createImageData(width,height),pixels=image.data,min=this.dataRange.min,span=this.dataRange.max-min||1;
   const ramp=Array.from({length:1024},(_,i)=>colorMap(i/1023));
   for(let e=0;e<m.areas.length;e++){
    const ids=m.triangles.subarray(e*3,e*3+3),pts=[...ids].map(id=>[(m.nodes[id*2]-b.x0)/b.width*width,(b.y1-m.nodes[id*2+1])/b.height*height]);
    const [a,bp,cpt]=pts,det=(bp[0]-a[0])*(cpt[1]-a[1])-(bp[1]-a[1])*(cpt[0]-a[0]);
    const x0=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[0])))),x1=Math.min(width-1,Math.ceil(Math.max(...pts.map(p=>p[0])))),y0=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[1])))),y1=Math.min(height-1,Math.ceil(Math.max(...pts.map(p=>p[1]))));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
     const u=((x+.5-a[0])*(cpt[1]-a[1])-(y+.5-a[1])*(cpt[0]-a[0]))/det,v=((bp[0]-a[0])*(y+.5-a[1])-(bp[1]-a[1])*(x+.5-a[0]))/det;
     if(u>=-1e-8&&v>=-1e-8&&u+v<=1+1e-8){const value=this.meta.node?(1-u-v)*this.values[ids[0]]+u*this.values[ids[1]]+v*this.values[ids[2]]:this.values[e],rgb=ramp[Math.max(0,Math.min(1023,Math.round((value-min)/span*1023)))],j=(y*width+x)*4;pixels[j]=rgb[0];pixels[j+1]=rgb[1];pixels[j+2]=rgb[2];pixels[j+3]=255;}
    }
   }
   c.putImageData(image,0,0);this.raster=canvas;
  }
  const b=this.scene.mesh.bounds,a=this.worldToScreen(b.x0,b.y1),z=this.worldToScreen(b.x1,b.y0);ctx.drawImage(this.raster,a[0],a[1],z[0]-a[0],z[1]-a[1]);
 }
 drawMesh(ctx){
  const m=this.scene.mesh;ctx.strokeStyle=this.scene.mode==='results'?'#142c4140':'#25405480';ctx.lineWidth=.5;ctx.beginPath();
  for(let e=0;e<m.areas.length;e++){for(let j=0;j<3;j++){const id=m.triangles[e*3+j],xy=this.worldToScreen(m.nodes[id*2],m.nodes[id*2+1]);j?ctx.lineTo(...xy):ctx.moveTo(...xy);}ctx.closePath();}ctx.stroke();
 }
 drawBoundaries(ctx){
  const m=this.scene.mesh;ctx.lineWidth=1.2;ctx.strokeStyle='#263d56b0';ctx.beginPath();
  for(const e of m.boundaries){ctx.moveTo(...this.worldToScreen(m.nodes[e.a*2],m.nodes[e.a*2+1]));ctx.lineTo(...this.worldToScreen(m.nodes[e.b*2],m.nodes[e.b*2+1]));}ctx.stroke();
  if(this.scene.selectedBoundary){ctx.lineWidth=4;ctx.strokeStyle='#00a7bf';ctx.beginPath();for(const e of m.boundaries)if(boundaryMatches(e,this.scene.selectedBoundary)){ctx.moveTo(...this.worldToScreen(m.nodes[e.a*2],m.nodes[e.a*2+1]));ctx.lineTo(...this.worldToScreen(m.nodes[e.b*2],m.nodes[e.b*2+1]));}ctx.stroke();}
 }
 drawContours(ctx){
  if(!this.meta.node||this.dataRange.max===this.dataRange.min)return;const m=this.scene.mesh;
  ctx.lineWidth=.65;ctx.strokeStyle='#253d4770';ctx.beginPath();
  for(let k=1;k<12;k++){
   const level=this.dataRange.min+(this.dataRange.max-this.dataRange.min)*k/12;
   for(let e=0;e<m.areas.length;e++){
    const pts=[];
    for(let j=0;j<3;j++){const a=m.triangles[e*3+j],b=m.triangles[e*3+(j+1)%3],va=this.values[a],vb=this.values[b];
     if((va<=level&&vb>level)||(vb<=level&&va>level)){const t=(level-va)/(vb-va);pts.push(this.worldToScreen(m.nodes[a*2]+t*(m.nodes[b*2]-m.nodes[a*2]),m.nodes[a*2+1]+t*(m.nodes[b*2+1]-m.nodes[a*2+1])));}
    }if(pts.length===2){ctx.moveTo(...pts[0]);ctx.lineTo(...pts[1]);}
   }
  }ctx.stroke();
 }
 drawVectors(ctx){
  const m=this.scene.mesh,f=this.scene.frame,thermal=['temperature','heatFlux'].includes(this.scene.field),vec=thermal?f?.heatVector:f?.electricVector;if(!vec)return;
  const stride=Math.max(1,Math.ceil(m.areas.length/180));ctx.strokeStyle='#152c44b0';ctx.lineWidth=1;
  for(let e=0;e<m.areas.length;e+=stride){let x=0,y=0;for(let j=0;j<3;j++){const id=m.triangles[e*3+j];x+=m.nodes[id*2]/3;y+=m.nodes[id*2+1]/3;}const l=Math.hypot(vec[e*2],vec[e*2+1]);if(l<1e-12)continue;const a=this.worldToScreen(x,y),dx=vec[e*2]/l*14,dy=-vec[e*2+1]/l*14;ctx.beginPath();ctx.moveTo(a[0]-dx/2,a[1]-dy/2);ctx.lineTo(a[0]+dx/2,a[1]+dy/2);ctx.lineTo(a[0]+dx*.16+dy*.2,a[1]+dy*.16-dx*.2);ctx.moveTo(a[0]+dx/2,a[1]+dy/2);ctx.lineTo(a[0]+dx*.16-dy*.2,a[1]+dy*.16+dx*.2);ctx.stroke();}
 }
 drawSelection(ctx){
  const p=this.polygons?.find(p=>p.id===this.scene.selectedShape);if(!p)return;ctx.strokeStyle='#058da5';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.beginPath();p.points.forEach((p,i)=>{const s=this.worldToScreen(...p);i?ctx.lineTo(...s):ctx.moveTo(...s);});ctx.closePath();ctx.stroke();ctx.setLineDash([]);
  const b=boundsOf([p]);for(const point of [[b.x0,b.y0],[b.x0,b.y1],[b.x1,b.y0],[b.x1,b.y1]]){const [x,y]=this.worldToScreen(...point);ctx.fillStyle='#fff';ctx.fillRect(x-3.5,y-3.5,7,7);ctx.strokeRect(x-3.5,y-3.5,7,7);}
 }
 drawLegend(ctx){
  const {w,h}=this.size,x=w-68,y=92,height=Math.max(70,Math.min(260,h-185));ctx.fillStyle='#f9fbfddf';ctx.fillRect(x-16,y-36,83,height+76);
  const gradient=ctx.createLinearGradient(0,y+height,0,y);for(let i=0;i<COLORS.length;i++)gradient.addColorStop(i/(COLORS.length-1),`rgb(${COLORS[i].join(',')})`);ctx.fillStyle=gradient;ctx.fillRect(x,y,14,height);ctx.strokeStyle='#c6d1da';ctx.strokeRect(x,y,14,height);
  ctx.font='11px system-ui';ctx.fillStyle='#34495b';ctx.fillText(this.meta.unit,x-1,y-13);
  for(let i=0;i<=5;i++){const py=y+i*height/5,value=this.displayRange.max-(this.displayRange.max-this.displayRange.min)*i/5;ctx.fillText(formatNumber(value,3),x+20,py+4);}
 }
 drawAxes(ctx){
  const {w,h}=this.size;ctx.strokeStyle='#839aa7';ctx.fillStyle='#6f8290';ctx.lineWidth=1;ctx.font='10px system-ui';
  const x=32,y=h-35;ctx.beginPath();ctx.moveTo(x,y-29);ctx.lineTo(x,y);ctx.lineTo(x+30,y);ctx.stroke();ctx.fillText('y',x-4,y-36);ctx.fillText('x',x+36,y+3);
  const target=100/this.camera.zoom,exp=10**Math.floor(Math.log10(target)),length=[1,2,5,10].map(v=>v*exp).filter(v=>v<=target).at(-1)||exp,px=length*this.camera.zoom,xx=w-170;
  ctx.beginPath();ctx.moveTo(xx,h-30);ctx.lineTo(xx+px,h-30);ctx.moveTo(xx,h-34);ctx.lineTo(xx,h-26);ctx.moveTo(xx+px,h-34);ctx.lineTo(xx+px,h-26);ctx.stroke();ctx.fillText(`${formatNumber(length*1000)} mm`,xx,h-40);
 }
 sample(x,y){if(!this.locator||!this.values)return null;const hit=this.locator.locate(x,y);if(!hit)return null;return {value:(this.meta.node?hit.ids.reduce((s,id,i)=>s+this.values[id]*hit.weights[i],0):this.values[hit.element])+this.meta.offset,element:hit.element,unit:this.meta.unit};}
 async snapshot(){this.draw();const canvas=document.createElement('canvas');canvas.width=this.overlay.width;canvas.height=this.overlay.height;const c=canvas.getContext('2d');c.fillStyle='#f5f8fa';c.fillRect(0,0,canvas.width,canvas.height);if(this.backend==='WebGPU'){await this.device.queue.onSubmittedWorkDone();c.drawImage(this.canvas,0,0);}c.drawImage(this.overlay,0,0);return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));}
}
