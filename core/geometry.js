import {evaluate,D} from './units.js';
export const orient=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
export const edgeKey=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`;
export function pointInPolygon(p,poly){
 let inside=false;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const a=poly[i],b=poly[j];
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }
 return inside;
}
export function pointSegmentDistance(p,a,b){
 const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy;
 const t=l?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l)):0;
 return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
export function properIntersection(a,b,c,d,eps=1e-14){return orient(a,b,c)*orient(a,b,d)<-eps*eps&&orient(c,d,a)*orient(c,d,b)<-eps*eps;}
export function polygonize(project,env,h){
 return project.shapes.map(s=>{
  const val=x=>evaluate(x,env,D.length);let points,tags;
  if(s.type==='rectangle'){
   const x=val(s.x),y=val(s.y),w=val(s.width),ht=val(s.height);
   if(!(w>0&&ht>0))throw Error(`${s.name}: rectangle dimensions must be positive`);
   points=[[x,y],[x+w,y],[x+w,y+ht],[x,y+ht]];tags=['bottom','right','top','left'];
  }else if(s.type==='circle'){
   const x=val(s.x),y=val(s.y),r=val(s.radius);if(!(r>0))throw Error(`${s.name}: radius must be positive`);
   const n=Math.min(256,Math.max(24,Math.ceil(2*Math.PI*r/h)));
   points=Array.from({length:n},(_,i)=>[x+r*Math.cos(i*2*Math.PI/n),y+r*Math.sin(i*2*Math.PI/n)]);tags=points.map(()=>'curve');
  }else{
   if(!Array.isArray(s.points)||s.points.length<3||s.points.length>256)throw Error(`${s.name}: polygon needs 3–256 vertices`);
   points=s.points.map(p=>[val(p[0]),val(p[1])]);tags=points.map((_,i)=>`edge${i+1}`);
   for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
    if(j===i+1||(i===0&&j===points.length-1))continue;
    if(properIntersection(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length],1e-24))throw Error(`${s.name}: self-intersecting polygon`);
   }
  }
  for(let i=0;i<points.length;i++)if(Math.hypot(points[i][0]-points[(i+1)%points.length][0],points[i][1]-points[(i+1)%points.length][1])<1e-14)throw Error(`${s.name}: zero-length edge`);
  return {...s,points,tags:tags.map(t=>`${s.id}:${t}`)};
 });
}
export function boundsOf(polygons){
 let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
 for(const p of polygons)for(const [x,y] of p.points){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
 if(!Number.isFinite(x0)||!(x1>x0&&y1>y0))throw Error('Geometry has no two-dimensional extent');
 return {x0,y0,x1,y1,width:x1-x0,height:y1-y0};
}
export function regionAt(point,polygons){let region=-1;for(let i=0;i<polygons.length;i++)if(pointInPolygon(point,polygons[i].points))region=polygons[i].operation==='subtract'?-1:i;return region;}
