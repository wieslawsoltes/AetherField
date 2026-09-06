/** Safe dimensional expression evaluator. Base dimensions: kg, m, s, A, K.
 * No eval/Function, prototype lookups, arbitrary property access or executable imports.
 */
export const D = Object.freeze({one:[0,0,0,0,0], length:[0,1,0,0,0], time:[0,0,1,0,0],
  temperature:[0,0,0,0,1], voltage:[1,2,-3,-1,0], conductivity:[-1,-3,3,2,0],
  thermal:[1,1,-3,0,-1], density:[1,-3,0,0,0], capacity:[0,2,-2,0,-1],
  source:[1,-1,-3,0,0], flux:[1,0,-3,0,0], convection:[1,0,-3,0,-1],
  charge:[0,-3,1,1,0], surfaceCharge:[0,-2,1,1,0], currentFlux:[0,-2,0,1,0],
  invTemperature:[0,0,0,0,-1]});
const quantity=(v,d=D.one)=>({v,d:[...d]});
const units=Object.create(null);
const def=(name,v,d)=>units[name]=quantity(v,d);
def('kg',1,[1,0,0,0,0]);def('g',1e-3,[1,0,0,0,0]);
for(const [n,v] of Object.entries({m:1,mm:1e-3,cm:1e-2,um:1e-6,nm:1e-9}))def(n,v,D.length);
for(const [n,v] of Object.entries({s:1,ms:1e-3,us:1e-6,min:60,h:3600}))def(n,v,D.time);
def('A',1,[0,0,0,1,0]);def('K',1,D.temperature);def('V',1,D.voltage);
def('mV',.001,D.voltage);def('W',1,[1,2,-3,0,0]);def('J',1,[1,2,-2,0,0]);
def('C',1,[0,0,1,1,0]);def('F',1,[-1,-2,4,2,0]);def('S',1,[-1,-2,3,2,0]);
def('ohm',1,[1,2,-3,-2,0]);def('Hz',1,[0,0,-1,0,0]);def('Pa',1,[1,-1,-2,0,0]);
export const sameDimension=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-10);
export function dimensionText(d){return ['kg','m','s','A','K'].map((u,i)=>d[i]?u+(d[i]===1?'':`^${d[i]}`):'').filter(Boolean).join(' ')||'1';}
function combine(a,b,op){
 if(op==='+'||op==='-'){
  if(!sameDimension(a.d,b.d))throw Error(`Unit mismatch: ${dimensionText(a.d)} ${op} ${dimensionText(b.d)}`);
  return quantity(op==='+'?a.v+b.v:a.v-b.v,a.d);
 }
 if(op==='^'){
  if(!sameDimension(b.d,D.one))throw Error('An exponent must be dimensionless');
  return quantity(a.v**b.v,a.d.map(v=>v*b.v));
 }
 if(op==='/'&&b.v===0)throw Error('Division by zero');
 return quantity(op==='*'?a.v*b.v:a.v/b.v,a.d.map((v,i)=>v+(op==='*'?b.d[i]:-b.d[i])));
}
export function compile(text){
 text=String(text).trim().replaceAll('µ','u').replaceAll('·','*');
 if(text.length>2048)throw Error('Expression exceeds 2048 characters');
 const tokens=[];let pos=0;
 const re=/\s*(?:(\d*\.\d+(?:[eE][+-]?\d+)?|\d+\.?\d*(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|([+\-*/^(),\[\]]))/y;
 while(pos<text.length){re.lastIndex=pos;const m=re.exec(text);if(!m)throw Error(`Invalid expression near “${text.slice(pos,pos+18)}”`);tokens.push({kind:m[1]?'num':m[2]?'id':'op',text:m[1]||m[2]||m[3]});pos=re.lastIndex;}
 let i=0;const peek=()=>tokens[i]?.text, take=()=>tokens[i++];
 const expect=t=>{if(take()?.text!==t)throw Error(`Expected “${t}”`);};
 function primary(){
  const t=take();if(!t)throw Error('Expected a value');let node;
  if(t.kind==='num')node={type:'number',value:Number(t.text)};
  else if(t.text==='('){node=sum();expect(')');}
  else if(t.kind==='id'){
   if(peek()==='('){take();let args=[];if(peek()!==')'){args.push(sum());while(peek()===','){take();args.push(sum());}}expect(')');node={type:'call',name:t.text,args};}
   else node={type:'name',name:t.text};
  }else throw Error(`Unexpected token “${t.text}”`);
  if(peek()==='['){take();let u=[];while(peek()!==']'&&i<tokens.length)u.push(take().text);expect(']');node={type:'unit',base:node,unit:u.join('')};}
  return node;
 }
 function unary(){if(peek()==='+'||peek()==='-'){const op=take().text;return {type:'unary',op,arg:unary()};}return power();}
 function power(){let a=primary();if(peek()==='^'){take();a={type:'binary',op:'^',a,b:unary()};}return a;}
 function product(){let a=unary();while(peek()==='*'||peek()==='/'){const op=take().text;a={type:'binary',op,a,b:unary()};}return a;}
 function sum(){let a=product();while(peek()==='+'||peek()==='-'){const op=take().text;a={type:'binary',op,a,b:product()};}return a;}
 const root=sum();if(i!==tokens.length)throw Error(`Unexpected token “${peek()}” (multiplication requires *)`);
 function run(n,resolve){
  if(n.type==='number')return quantity(n.value);
  if(n.type==='name'){
   if(n.name==='pi')return quantity(Math.PI);
   if(n.name==='e')return quantity(Math.E);
   if(n.name==='eps0')return quantity(8.8541878128e-12,[-1,-3,4,2,0]);
   if(Object.hasOwn(units,n.name))return units[n.name];
   const v=typeof resolve==='function'?resolve(n.name):resolve?.[n.name];
   if(v===undefined)throw Error(`Undefined parameter “${n.name}”`);return typeof v==='number'?quantity(v):v;
  }
  if(n.type==='unary'){const a=run(n.arg,resolve);return quantity(n.op==='-'?-a.v:a.v,a.d);}
  if(n.type==='binary')return combine(run(n.a,resolve),run(n.b,resolve),n.op);
  if(n.type==='unit'){
   const a=run(n.base,resolve);if(!sameDimension(a.d,D.one))throw Error('Unit suffix requires a dimensionless value');
   if(n.unit==='degC')return quantity(a.v+273.15,D.temperature);
   return combine(a,compile(n.unit)(Object.create(null)),'*');
  }
  const args=n.args.map(a=>run(a,resolve)),a=args[0];if(!a)throw Error(`${n.name} needs an argument`);
  if(['sin','cos','tan','exp','log'].includes(n.name)){
   if(args.length!==1||!sameDimension(a.d,D.one))throw Error(`${n.name} needs one dimensionless argument`);
   return quantity(Math[n.name](a.v));
  }
  if(n.name==='sqrt'&&args.length===1)return quantity(Math.sqrt(a.v),a.d.map(v=>v/2));
  if(n.name==='abs'&&args.length===1)return quantity(Math.abs(a.v),a.d);
  if(['min','max'].includes(n.name)){
   if(!args.every(v=>sameDimension(v.d,a.d)))throw Error('min/max arguments need matching units');
   return quantity(Math[n.name](...args.map(a=>a.v)),a.d);
  }
  throw Error(`Unknown function or argument count: ${n.name}`);
 }
 return resolve=>{const q=run(root,resolve);if(!Number.isFinite(q.v))throw Error(`Non-finite expression: ${text}`);return q;};
}
const cache=new Map();
export function evaluate(text,env={},expected=null){
 const key=String(text);let f=cache.get(key);if(!f){f=compile(key);if(cache.size>2048)cache.clear();cache.set(key,f);}
 const q=f(env);
 // A bare dimensionless result is interpreted in the field's displayed SI unit.
 if(expected&&!sameDimension(q.d,expected)&&!sameDimension(q.d,D.one))throw Error(`Expected ${dimensionText(expected)}, got ${dimensionText(q.d)}`);
 return q.v;
}
export function resolveParameters(rows){
 const defs=new Map(),done=Object.create(null),active=new Set();
 for(const row of rows){
  if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(row.name)||Object.hasOwn(units,row.name)||['x','y','t','T','pi','eps0','e','__proto__','constructor','prototype'].includes(row.name))throw Error(`Invalid or reserved parameter name: ${row.name}`);
  if(defs.has(row.name))throw Error(`Duplicate parameter: ${row.name}`);defs.set(row.name,row.expression);
 }
 const resolve=name=>{
  if(Object.hasOwn(done,name))return done[name];
  if(active.has(name))throw Error(`Cyclic parameter dependency at ${name}`);
  if(!defs.has(name))throw Error(`Undefined parameter “${name}”`);
  active.add(name);done[name]=compile(defs.get(name))(resolve);active.delete(name);return done[name];
 };
 for(const name of defs.keys())resolve(name);return done;
}
export function spatialEnvironment(env,x,y,t=0,T=293.15){return {...env,x:quantity(x,D.length),y:quantity(y,D.length),t:quantity(t,D.time),T:quantity(T,D.temperature)};}
