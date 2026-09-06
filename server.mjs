import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT||8080);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.afield':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.md':'text/plain; charset=utf-8','.vtk':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end('Method not allowed');return;}
  const url=new URL(req.url,'http://localhost'),pathname=decodeURIComponent(url.pathname),relative=pathname.replace(/^\/+/,''),file=path.resolve(root,relative||'index.html');
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
  const info=await stat(file);if(!info.isFile()){res.writeHead(404);res.end('Not found');return;}
  const bytes=await readFile(file);
  const standalone=path.basename(file)==='AetherField-standalone.html';
  const script=standalone?bytes.toString('utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1]:null;
  const scriptPolicy=script?`'self' 'sha256-${createHash('sha256').update(script).digest('base64')}'`:"'self'";
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'${standalone?' blob:':''}; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`});
  res.end(req.method==='HEAD'?undefined:bytes);
 }catch(error){res.writeHead(error.code==='ENOENT'?404:400,{'Content-Type':'text/plain'});res.end(error.code==='ENOENT'?'Not found':'Bad request');}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Set PORT to an unused port.`:error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`AetherField: http://localhost:${port}\nStatic source server — no build or dependencies. Ctrl+C to stop.`));
