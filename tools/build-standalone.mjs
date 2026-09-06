/** Dependency-free packaging of our acyclic, named-export ES modules.
 * This is deliberately not a general JavaScript bundler. It supports exactly
 * the import/export grammar used by this repository and fails on leftovers.
 */
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const paths=[];
for(const folder of ['core','view','tests'])for(const file of await readdir(path.join(root,folder)))if(file.endsWith('.js'))paths.push(`${folder}/${file}`);
const sources=Object.fromEntries(await Promise.all(paths.map(async name=>[name,await readFile(path.join(root,name),'utf8')])));
function compile(name,source){
 const names=[...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)].map(m=>m[1]);
 source=source.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,(_,members,target)=>{
  const module=path.posix.normalize(path.posix.join(path.posix.dirname(name),target));
  if(!(module in sources))throw Error(`Missing module ${module}`);
  return `const {${members.replace(/\b(\w+)\s+as\s+(\w+)/g,'$1:$2')}}=__require(${JSON.stringify(module)});`;
 }).replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/g,'');
 if(/\bimport\s*\{|\bexport\s+(?:default|\{)|import\.meta/.test(source))throw Error(`Unsupported module syntax in ${name}`);
 return `__modules[${JSON.stringify(name)}]=()=>{\n${source}\nreturn {${names.join(',')}};\n};\n`;
}
const registry=`const __modules=Object.create(null),__cache=Object.create(null);function __require(name){return __cache[name]||(__cache[name]=__modules[name]());}\n`;
const modules=paths.map(name=>compile(name,sources[name])).join('\n');
const workerSource=`(()=>{${registry}${modules}__require('core/worker.js');})();`;
let app=await readFile(path.join(root,'app.js'),'utf8');
app=app.replace("new Worker(new URL('./core/worker.js',import.meta.url),{type:'module'})","new Worker(__workerURL)");
app=app.replace(/if\(location\.protocol==='file:'\)\{toast\([\s\S]*?\}\s*else startJob\('solve'\);\s*$/, "startJob('solve');");
const script=`(()=>{'use strict';\n${registry}${modules}\nconst __workerURL=URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'}));\n${compile('app.js',app)}\n__require('app.js');\n})();`;
let html=await readFile(path.join(root,'index.html'),'utf8');
const css=await readFile(path.join(root,'styles.css'),'utf8');
html=html.replace('<link rel="stylesheet" href="styles.css">',()=>`<style>${css}</style>`).replace('<script type="module" src="app.js"></script>',()=>`<script>${script.replaceAll('</script','<\\/script')}</script>`);
await writeFile(path.join(root,'AetherField-standalone.html'),html);
console.log(`Built AetherField-standalone.html (${(html.length/1024).toFixed(0)} KB). No external dependencies.`);
