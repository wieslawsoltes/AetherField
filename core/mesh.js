import {evaluate,D} from './units.js';
import {polygonize,boundsOf,regionAt,orient,edgeKey,properIntersection,pointSegmentDistance} from './geometry.js';

/** Constrained P1 triangulation: split a PSLG, seed interior points, Delaunay
 * triangulate, recover every constraint by convex edge flips, classify CSG faces.
 * Predicates operate in normalized coordinates. Degenerate/failed constraints
 * are rejected explicitly rather than silently replaced by a raster domain.
 */
export function generateMesh(project,env,progress=()=>{}){
 const start=performance.now(),h=evaluate(project.mesh.size,env,D.length);
 const world=polygonize(project,env,h),bounds=boundsOf(world),scale=Math.max(bounds.width,bounds.height);
 const H=h/scale,tol=1e-10;
 if(!(H>1e-6))throw Error('Mesh size is too small relative to the geometry');
 const polys=world.map(p=>({...p,points:p.points.map(([x,y])=>[(x-bounds.x0)/scale,(y-bounds.y0)/scale])}));
 const raw=[];
 for(const p of polys)for(let i=0;i<p.points.length;i++)raw.push({a:p.points[i],b:p.points[(i+1)%p.points.length],tag:p.tags[i],cuts:[0,1]});
 const addCut=(seg,p)=>{
  const dx=seg.b[0]-seg.a[0],dy=seg.b[1]-seg.a[1],l=dx*dx+dy*dy;
  const t=((p[0]-seg.a[0])*dx+(p[1]-seg.a[1])*dy)/l;
  if(t>-tol&&t<1+tol&&pointSegmentDistance(p,seg.a,seg.b)<tol)seg.cuts.push(Math.max(0,Math.min(1,t)));
 };
 // Include collinear overlap endpoints as well as transverse intersections.
 for(let i=0;i<raw.length;i++)for(let j=i+1;j<raw.length;j++){
  const a=raw[i],b=raw[j];const ax=a.b[0]-a.a[0],ay=a.b[1]-a.a[1],bx=b.b[0]-b.a[0],by=b.b[1]-b.a[1];
  const det=ax*by-ay*bx,dx=b.a[0]-a.a[0],dy=b.a[1]-a.a[1];
  if(Math.abs(det)>1e-15){const t=(dx*by-dy*bx)/det,u=(dx*ay-dy*ax)/det;if(t>-tol&&t<1+tol&&u>-tol&&u<1+tol){a.cuts.push(Math.max(0,Math.min(1,t)));b.cuts.push(Math.max(0,Math.min(1,u)));}}
  else {addCut(a,b.a);addCut(a,b.b);addCut(b,a.a);addCut(b,a.b);}
 }
 const points=[],buckets=new Map(),segments=new Map();
 const addPoint=p=>{
  const qx=Math.round(p[0]/tol),qy=Math.round(p[1]/tol);
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
   const ids=buckets.get(`${qx+dx},${qy+dy}`)||[];
   for(const id of ids)if(Math.hypot(points[id][0]-p[0],points[id][1]-p[1])<tol*2)return id;
  }
  const id=points.length;points.push(p);const key=`${qx},${qy}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);return id;
 };
 for(const r of raw){
  const cuts=r.cuts.sort((a,b)=>a-b).filter((v,i,a)=>!i||v-a[i-1]>tol);
  for(let k=0;k<cuts.length-1;k++){
   const t0=cuts[k],t1=cuts[k+1],len=Math.hypot(r.b[0]-r.a[0],r.b[1]-r.a[1])*(t1-t0),n=Math.max(1,Math.ceil(len/H-1e-9));
   let prev=-1;
   for(let j=0;j<=n;j++){
    const t=t0+(t1-t0)*j/n,id=addPoint([r.a[0]+(r.b[0]-r.a[0])*t,r.a[1]+(r.b[1]-r.a[1])*t]);
    if(prev>=0&&prev!==id){const key=edgeKey(prev,id);if(!segments.has(key))segments.set(key,{a:prev,b:id,tags:new Set()});segments.get(key).tags.add(r.tag);}prev=id;
   }
  }
 }
 const maxNodes=Math.min(30000,Math.max(100,project.mesh.maxNodes||18000));
 const estimated=bounds.width*bounds.height/(h*h)*1.16;
 if(estimated>maxNodes*2||points.length>maxNodes)throw Error(`Mesh exceeds ${maxNodes} nodes; choose a larger element size`);
 // A deterministic hexagonal interior lattice; keep a clearance to every PSLG edge.
 for(let j=0,y=H*.8660254/2;y<bounds.height/scale;y+=H*.8660254,j++)for(let x=H/2+(j%2)*H/2;x<bounds.width/scale;x+=H){
  const p=[x,y];if(regionAt(p,polys)<0)continue;
  if(raw.some(s=>pointSegmentDistance(p,s.a,s.b)<H*.25))continue;
  addPoint(p);if(points.length>maxNodes)throw Error(`Mesh exceeds ${maxNodes} nodes`);
 }
 progress({phase:'mesh',message:`Triangulating ${points.length.toLocaleString()} vertices`});
 const count=points.length;if(count<3)throw Error('Geometry produced fewer than three mesh nodes');
 points.push([-20,-10],[20,-10],[0,20]);
 function triangle(a,b,c){
  if(orient(points[a],points[b],points[c])<0)[b,c]=[c,b];
  const A=points[a],B=points[b],C=points[c];const bx=B[0]-A[0],by=B[1]-A[1],cx=C[0]-A[0],cy=C[1]-A[1],det=2*(bx*cy-by*cx);
  if(Math.abs(det)<1e-18)throw Error('Degenerate triangle: geometry contains numerically coincident constraints');
  const bl=bx*bx+by*by,cl=cx*cx+cy*cy,ux=(cy*bl-by*cl)/det,uy=(bx*cl-cx*bl)/det;
  return {a,b,c,x:A[0]+ux,y:A[1]+uy,r:ux*ux+uy*uy};
 }
 let cells=[triangle(count,count+1,count+2)];
 const order=Array.from({length:count},(_,i)=>i);let seed=1729;
 for(let i=count-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[order[i],order[j]]=[order[j],order[i]];}
 for(let index=0;index<count;index++){
  const id=order[index],p=points[id],border=new Map(),keep=[];
  for(const t of cells){
   const dx=p[0]-t.x,dy=p[1]-t.y;
   if(dx*dx+dy*dy<=t.r+1e-14*Math.max(1,t.r)){
    for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]]){const key=edgeKey(a,b);if(border.has(key))border.delete(key);else border.set(key,[a,b]);}
   }else keep.push(t);
  }
  if(!border.size)throw Error('Delaunay insertion failed; increase the geometry feature separation');
  for(const [a,b] of border.values())if(Math.abs(orient(points[a],points[b],p))>1e-17)keep.push(triangle(a,b,id));
  cells=keep;
 }
 cells=cells.filter(t=>t.a<count&&t.b<count&&t.c<count);points.length=count;
 const edges=new Map();
 const addEdges=(t,i)=>{for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]]){const key=edgeKey(a,b);let e=edges.get(key);if(!e)edges.set(key,e={a,b,cells:[]});e.cells.push(i);}};
 const removeEdges=(t,i)=>{for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]]){const key=edgeKey(a,b),e=edges.get(key);e.cells=e.cells.filter(x=>x!==i);if(!e.cells.length)edges.delete(key);}};
 cells.forEach(addEdges);
 const protectedEdges=new Set();let flips=0;
 function flippable(e){
  if(e.cells.length!==2||protectedEdges.has(edgeKey(e.a,e.b)))return null;
  const [i,j]=e.cells,t=cells[i],u=cells[j],c=[t.a,t.b,t.c].find(x=>x!==e.a&&x!==e.b),d=[u.a,u.b,u.c].find(x=>x!==e.a&&x!==e.b);
  if(c===d||edges.has(edgeKey(c,d)))return null;
  if(orient(points[c],points[d],points[e.a])*orient(points[c],points[d],points[e.b])>=-1e-26)return null;
  return {i,j,c,d,a:e.a,b:e.b};
 }
 function flip(f){removeEdges(cells[f.i],f.i);removeEdges(cells[f.j],f.j);cells[f.i]=triangle(f.c,f.d,f.a);cells[f.j]=triangle(f.d,f.c,f.b);addEdges(cells[f.i],f.i);addEdges(cells[f.j],f.j);flips++;}
 for(const [key,s] of segments){
  let attempts=0;const recently=new Set();
  while(!edges.has(key)){
   if(++attempts>count*3)throw Error(`Constraint recovery failed for ${[...s.tags].join(', ')}; simplify nearly coincident edges`);
   let chosen=null,alternative=null;
   for(const [ek,e] of edges){
    if(e.a===s.a||e.b===s.a||e.a===s.b||e.b===s.b||!properIntersection(points[s.a],points[s.b],points[e.a],points[e.b]))continue;
    const f=flippable(e);if(!f)continue;
    if(!properIntersection(points[s.a],points[s.b],points[f.c],points[f.d])){chosen=f;break;}
    if(!recently.has(edgeKey(f.c,f.d)))alternative=f;
   }
   chosen ||= alternative;
   if(!chosen)throw Error(`Unable to recover a geometry edge (${[...s.tags][0]}). Avoid touching/sliver features below the mesh tolerance.`);
   recently.add(edgeKey(chosen.a,chosen.b));flip(chosen);
  }
  protectedEdges.add(key);
 }
 // Lawson relaxation never removes recovered constraints.
 for(let pass=0;pass<12;pass++){
  let changed=0;
  for(const e of [...edges.values()]){
   const current=edges.get(edgeKey(e.a,e.b));if(!current)continue;const f=flippable(current);if(!f)continue;
   const t=cells[f.i],p=points[f.d],dx=p[0]-t.x,dy=p[1]-t.y;
   if(dx*dx+dy*dy<t.r-1e-13){flip(f);changed++;}
  }
  if(!changed)break;
 }
 const kept=[];
 for(const t of cells){const p=[(points[t.a][0]+points[t.b][0]+points[t.c][0])/3,(points[t.a][1]+points[t.b][1]+points[t.c][1])/3],r=regionAt(p,polys);if(r>=0)kept.push({...t,region:r});}
 if(!kept.length)throw Error('The geometry Boolean operations leave an empty domain');
 const used=new Set();for(const t of kept){used.add(t.a);used.add(t.b);used.add(t.c);}
 const remap=new Int32Array(count).fill(-1),nodes=new Float64Array(used.size*2);let n=0;
 for(const old of [...used].sort((a,b)=>a-b)){remap[old]=n;nodes[n*2]=points[old][0]*scale+bounds.x0;nodes[n*2+1]=points[old][1]*scale+bounds.y0;n++;}
 const triangles=new Uint32Array(kept.length*3),regions=new Uint16Array(kept.length),boundaryEdges=new Map();
 for(let i=0;i<kept.length;i++){
  const t=kept[i];triangles.set([remap[t.a],remap[t.b],remap[t.c]],i*3);regions[i]=t.region;
  for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]]){
   const key=edgeKey(a,b);let e=boundaryEdges.get(key);if(!e)boundaryEdges.set(key,e={a,b,count:0,cell:i});e.count++;
   if(e.count>2)throw Error('Non-manifold triangulation');
  }
 }
 const boundaries=[];
 const b={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
 for(let i=0;i<n;i++){b.x0=Math.min(b.x0,nodes[2*i]);b.x1=Math.max(b.x1,nodes[2*i]);b.y0=Math.min(b.y0,nodes[2*i+1]);b.y1=Math.max(b.y1,nodes[2*i+1]);}
 b.width=b.x1-b.x0;b.height=b.y1-b.y0;
 for(const [key,e] of boundaryEdges)if(e.count===1){
  const s=segments.get(key);if(!s)throw Error('Unconstrained exterior edge detected; meshing was not accepted');
  const a=remap[e.a],c=remap[e.b],x=(nodes[2*a]+nodes[2*c])/2,y=(nodes[2*a+1]+nodes[2*c+1])/2;
  const dx=nodes[2*c]-nodes[2*a],dy=nodes[2*c+1]-nodes[2*a+1],length=Math.hypot(dx,dy),side=[];
  if(Math.abs(x-b.x0)<scale*1e-8)side.push('left');if(Math.abs(x-b.x1)<scale*1e-8)side.push('right');
  if(Math.abs(y-b.y0)<scale*1e-8)side.push('bottom');if(Math.abs(y-b.y1)<scale*1e-8)side.push('top');
  boundaries.push({a,b:c,tags:[...s.tags],side,nx:dy/length,ny:-dx/length,length,cell:e.cell});
 }
 const mesh={signature:meshSignature(project,env),nodes,triangles,regions,boundaries,bounds:b,shapeIds:project.shapes.map(s=>s.id),h,scale};
 prepareElements(mesh);
 mesh.stats={nodes:n,elements:kept.length,boundaryEdges:boundaries.length,minQuality:Math.min(...mesh.quality),meanQuality:mesh.quality.reduce((a,b)=>a+b,0)/kept.length,area:mesh.areas.reduce((a,b)=>a+b,0),flips,elapsed:performance.now()-start,components:componentLabels(mesh).count};
 progress({phase:'mesh',message:`${n.toLocaleString()} nodes · ${kept.length.toLocaleString()} triangles · minimum quality ${mesh.stats.minQuality.toFixed(3)}`});
 return mesh;
}
export function prepareElements(mesh){
 const {nodes:p,triangles:t}=mesh,nt=t.length/3;
 mesh.areas=new Float64Array(nt);mesh.gradients=new Float64Array(nt*6);mesh.quality=new Float64Array(nt);
 for(let e=0;e<nt;e++){
  const [a,b,c]=t.subarray(3*e,3*e+3),x0=p[2*a],y0=p[2*a+1],x1=p[2*b],y1=p[2*b+1],x2=p[2*c],y2=p[2*c+1];
  const det=(x1-x0)*(y2-y0)-(y1-y0)*(x2-x0),A=det/2;if(!(A>0))throw Error('Non-positive element Jacobian');
  mesh.areas[e]=A;mesh.gradients.set([(y1-y2)/det,(x2-x1)/det,(y2-y0)/det,(x0-x2)/det,(y0-y1)/det,(x1-x0)/det],e*6);
  const l2=(x0-x1)**2+(y0-y1)**2+(x1-x2)**2+(y1-y2)**2+(x2-x0)**2+(y2-y0)**2;
  mesh.quality[e]=4*Math.sqrt(3)*A/l2;
 }
}
export function componentLabels(mesh){
 const n=mesh.nodes.length/2,parent=Int32Array.from({length:n},(_,i)=>i);
 const find=x=>{while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
 for(let i=0;i<mesh.triangles.length;i+=3){const a=find(mesh.triangles[i]);parent[find(mesh.triangles[i+1])]=a;parent[find(mesh.triangles[i+2])]=a;}
 const groups=new Map(),labels=new Int32Array(n);
 for(let i=0;i<n;i++){const r=find(i);if(!groups.has(r))groups.set(r,groups.size);labels[i]=groups.get(r);}
 return {labels,count:groups.size};
}
export function boundaryMatches(edge,selector){return selector==='all'||edge.side.includes(selector)||edge.tags.includes(selector)||edge.tags.some(t=>selector===`shape:${t.split(':')[0]}`);}
/** Uniform spatial hash for triangle queries, not an O(element-count) mouse scan. */
export class MeshLocator{
 constructor(mesh){
  this.mesh=mesh;this.h=Math.max(mesh.h,mesh.scale/200);this.bins=new Map();
  const p=mesh.nodes,t=mesh.triangles;
  for(let e=0;e<t.length/3;e++){
   const ids=t.subarray(e*3,e*3+3),xs=[...ids].map(i=>p[2*i]),ys=[...ids].map(i=>p[2*i+1]);
   for(let iy=Math.floor(Math.min(...ys)/this.h);iy<=Math.floor(Math.max(...ys)/this.h);iy++)for(let ix=Math.floor(Math.min(...xs)/this.h);ix<=Math.floor(Math.max(...xs)/this.h);ix++){
    const key=`${ix},${iy}`;if(!this.bins.has(key))this.bins.set(key,[]);this.bins.get(key).push(e);
   }
  }
 }
 locate(x,y){
  const p=this.mesh.nodes,t=this.mesh.triangles;
  for(const e of this.bins.get(`${Math.floor(x/this.h)},${Math.floor(y/this.h)}`)||[]){
   const [a,b,c]=t.subarray(e*3,e*3+3),det=2*this.mesh.areas[e];
   const wb=((x-p[2*a])*(p[2*c+1]-p[2*a+1])-(y-p[2*a+1])*(p[2*c]-p[2*a]))/det;
   const wc=((p[2*b]-p[2*a])*(y-p[2*a+1])-(p[2*b+1]-p[2*a+1])*(x-p[2*a]))/det,wa=1-wb-wc;
   if(Math.min(wa,wb,wc)>-1e-9)return {element:e,ids:[a,b,c],weights:[wa,wb,wc]};
  }return null;
 }
 sample(values,x,y){const hit=this.locate(x,y);return hit?hit.ids.reduce((sum,id,i)=>sum+values[id]*hit.weights[i],0):null;}
}

export function meshSignature(project,env){const h=evaluate(project.mesh.size,env,D.length);return JSON.stringify({h,shapes:polygonize(project,env,h).map(p=>({id:p.id,operation:p.operation,points:p.points,tags:p.tags}))});}
