import {validateProject} from './model.js';
import {gradient} from './fem.js';
export function parseProject(text){if(text.length>2000000)throw Error('Project file exceeds 2 MB');const project=JSON.parse(text);validateProject(project);return project;}
export const projectJSON=p=>JSON.stringify(p,null,2);
export const resultJSON=r=>JSON.stringify(r,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v);
const csvCell=x=>`"${String(x??'').replaceAll('"','""')}"`;
export function resultsCSV(run,frame){
 const {mesh:m}=run,lines=['node,x_m,y_m,temperature_K,potential_V'];
 for(let i=0;i<m.nodes.length/2;i++)lines.push([i,m.nodes[i*2],m.nodes[i*2+1],frame.T?.[i]??'',frame.V?.[i]??''].join(','));return lines.join('\n');
}
export function elementsCSV(run,frame){
 const {mesh:m}=run,lines=['element,domain,node0,node1,node2,area_m2,quality,heat_flux_W_m2,electric_field_V_m,joule_W_m3'];
 for(let i=0;i<m.areas.length;i++)lines.push([i,csvCell(m.shapeIds[m.regions[i]]),...m.triangles.subarray(3*i,3*i+3),m.areas[i],m.quality[i],frame.heatFlux[i],frame.electricField[i],frame.joule[i]].join(','));return lines.join('\n');
}
export function probesCSV(run){const lines=['probe,x_m,y_m,time_s,temperature_K,potential_V'];for(const p of run.probes)for(const s of p.samples)lines.push([csvCell(p.name),p.x,p.y,s.time,s.T??'',s.V??''].join(','));return lines.join('\n');}
export function vtk(run,frame){
 const m=run.mesh,n=m.nodes.length/2,nt=m.triangles.length/3,lines=['# vtk DataFile Version 3.0','AetherField computed finite-element results','ASCII','DATASET UNSTRUCTURED_GRID',`POINTS ${n} double`];
 for(let i=0;i<n;i++)lines.push(`${m.nodes[2*i]} ${m.nodes[2*i+1]} 0`);
 lines.push(`CELLS ${nt} ${nt*4}`);for(let i=0;i<nt;i++)lines.push(`3 ${m.triangles[i*3]} ${m.triangles[i*3+1]} ${m.triangles[i*3+2]}`);
 lines.push(`CELL_TYPES ${nt}`);for(let i=0;i<nt;i++)lines.push('5');
 const scalar=(name,values)=>{lines.push(`SCALARS ${name} double 1`,'LOOKUP_TABLE default');for(const v of values)lines.push(String(v));};
 lines.push(`POINT_DATA ${n}`);if(frame.T)scalar('temperature_K',frame.T);if(frame.V)scalar('potential_V',frame.V);
 lines.push(`CELL_DATA ${nt}`);scalar('material_region',m.regions);scalar('quality',m.quality);scalar('heat_flux_magnitude_W_m2',frame.heatFlux);scalar('electric_field_magnitude_V_m',frame.electricField);scalar('joule_W_m3',frame.joule);
 for(const [name,values] of [['heat_flux_W_m2',frame.heatVector],['electric_field_V_m',frame.electricVector],['current_density_A_m2',frame.currentVector]]){lines.push(`VECTORS ${name} double`);for(let i=0;i<nt;i++)lines.push(`${values[2*i]} ${values[2*i+1]} 0`);}
 return lines.join('\n');
}
