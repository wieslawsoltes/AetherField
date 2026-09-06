/** Compressed sparse row algebra, assembly scatter maps and Float64 PCG. */
export function buildPattern(mesh){
 const n=mesh.nodes.length/2,rows=Array.from({length:n},(_,i)=>new Set([i])),t=mesh.triangles;
 for(let k=0;k<t.length;k+=3)for(let i=0;i<3;i++)for(let j=0;j<3;j++)rows[t[k+i]].add(t[k+j]);
 const rowPtr=new Uint32Array(n+1),lists=rows.map(s=>[...s].sort((a,b)=>a-b));
 for(let i=0;i<n;i++)rowPtr[i+1]=rowPtr[i]+lists[i].length;
 const col=new Uint32Array(rowPtr[n]),lookup=lists.map((list,i)=>{const m=new Map();list.forEach((c,j)=>{col[rowPtr[i]+j]=c;m.set(c,rowPtr[i]+j);});return m;});
 const scatter=new Uint32Array(t.length*3);
 for(let e=0;e<t.length/3;e++)for(let i=0;i<3;i++)for(let j=0;j<3;j++)scatter[e*9+i*3+j]=lookup[t[e*3+i]].get(t[e*3+j]);
 return {n,rowPtr,col,scatter,lookup};
}
export function matvec(A,x,out=new Float64Array(A.n)){
 for(let i=0;i<A.n;i++){let s=0;for(let k=A.rowPtr[i];k<A.rowPtr[i+1];k++)s+=A.values[k]*x[A.col[k]];out[i]=s;}return out;
}
export function dot(a,b){let sum=0,compensation=0;for(let i=0;i<a.length;i++){const y=a[i]*b[i]-compensation,t=sum+y;compensation=(t-sum)-y;sum=t;}return sum;}
export const norm=a=>Math.sqrt(Math.max(0,dot(a,a)));
export function residual(A,x,b){const r=matvec(A,x);for(let i=0;i<A.n;i++)r[i]=b[i]-r[i];return r;}
export function relativeResidual(A,x,b){return norm(residual(A,x,b))/Math.max(norm(b),1e-300);}
export function reduceDirichlet(A,b,fixed){
 const map=new Int32Array(A.n).fill(-1),free=[];
 for(let i=0;i<A.n;i++)if(!fixed.has(i)){map[i]=free.length;free.push(i);}
 const n=free.length,rowPtr=new Uint32Array(n+1),cols=[],values=[],rhs=new Float64Array(n);
 for(let j=0;j<n;j++){
  const i=free[j];rhs[j]=b[i];
  for(let k=A.rowPtr[i];k<A.rowPtr[i+1];k++){
   const c=A.col[k];if(fixed.has(c))rhs[j]-=A.values[k]*fixed.get(c);else{cols.push(map[c]);values.push(A.values[k]);}
  }
  rowPtr[j+1]=cols.length;
 }
 return {A:{n,rowPtr,col:Uint32Array.from(cols),values:Float64Array.from(values)},b:rhs,free,expand:x=>{const out=new Float64Array(A.n);for(const [i,v] of fixed)out[i]=v;for(let j=0;j<n;j++)out[free[j]]=x[j];return out;}};
}
export function diagonal(A){
 const d=new Float64Array(A.n);
 for(let i=0;i<A.n;i++){for(let k=A.rowPtr[i];k<A.rowPtr[i+1];k++)if(A.col[k]===i){d[i]=A.values[k];break;}
  if(!(d[i]>0)||!Number.isFinite(d[i]))throw Error(`Non-positive matrix diagonal at degree of freedom ${i}; check material values and constraints`);
 }return d;
}
export function scaleSPD(A,b,x0){
 const s=diagonal(A);for(let i=0;i<A.n;i++)s[i]=1/Math.sqrt(s[i]);
 const values=new Float64Array(A.values.length),rhs=new Float64Array(A.n),y=new Float64Array(A.n);
 for(let i=0;i<A.n;i++){
  rhs[i]=s[i]*b[i];y[i]=(x0?.[i]||0)/s[i];
  for(let k=A.rowPtr[i];k<A.rowPtr[i+1];k++)values[k]=A.values[k]*s[i]*s[A.col[k]];
 }
 return {A:{...A,values},b:rhs,x:y,unscale:y=>Float64Array.from(y,(v,i)=>v*s[i])};
}
export function pcg(A,b,{tolerance=1e-9,maxIterations=3000,x0,onIteration=()=>{},label='Linear solve'}={}){
 const n=A.n;if(!n)return {x:new Float64Array(),iterations:0,relativeResidual:0,history:[0],backend:'Float64 CPU'};
 const x=x0?Float64Array.from(x0):new Float64Array(n),bn=norm(b);
 if(bn===0)return {x:new Float64Array(n),iterations:0,relativeResidual:0,history:[0],backend:'Float64 CPU'};
 const d=diagonal(A),r=residual(A,x,b),z=new Float64Array(n),p=new Float64Array(n),ap=new Float64Array(n),history=[];
 let rn=norm(r),rel=rn/bn,rz=0;
 for(let i=0;i<n;i++){z[i]=r[i]/d[i];p[i]=z[i];}rz=dot(r,z);history.push(rel);
 if(rel<=tolerance)return {x,iterations:0,relativeResidual:rel,history,backend:'Float64 CPU'};
 let iterations=0;
 for(let k=1;k<=maxIterations;k++){
  iterations=k;matvec(A,p,ap);const pap=dot(p,ap);
  if(!(pap>0)||!Number.isFinite(pap))throw Error(`${label}: PCG breakdown at iteration ${k}; the system is not numerically SPD`);
  const alpha=rz/pap;
  for(let i=0;i<n;i++){x[i]+=alpha*p[i];r[i]-=alpha*ap[i];}
  rel=norm(r)/bn;history.push(rel);
  if(k%12===0||rel<=tolerance)onIteration({iteration:k,residual:rel,label,backend:'Float64 CPU'});
  if(rel<=tolerance){
   const trueR=residual(A,x,b),verified=norm(trueR)/bn;
   if(verified<=tolerance*1.1){rel=verified;break;}
   r.set(trueR);for(let i=0;i<n;i++){z[i]=r[i]/d[i];p[i]=z[i];}rz=dot(r,z);continue;
  }
  // Residual replacement + restart limits accumulated recurrence error.
  if(k%160===0){r.set(residual(A,x,b));for(let i=0;i<n;i++){z[i]=r[i]/d[i];p[i]=z[i];}rz=dot(r,z);continue;}
  for(let i=0;i<n;i++)z[i]=r[i]/d[i];const next=dot(r,z),beta=next/rz;
  for(let i=0;i<n;i++)p[i]=z[i]+beta*p[i];rz=next;
 }
 rel=relativeResidual(A,x,b);
 if(!Number.isFinite(rel)||rel>tolerance*1.1)throw Error(`${label}: failed to converge in ${iterations} iterations (true relative residual ${rel.toExponential(3)}, required ${tolerance})`);
 return {x,iterations,relativeResidual:rel,history,backend:'Float64 CPU'};
}
