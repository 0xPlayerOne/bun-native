import { parseSync } from 'oxc-parser';
import { readdir,readFile } from 'node:fs/promises';
import { resolve,dirname,relative,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const allowed:Record<string,readonly string[]>={contracts:[],client:['contracts'],runtime:['contracts'],artifacts:[],cli:['artifacts','contracts']};
export function inspectSource(filename:string,source:string,root:string):string[] {
 const file=relative(root,filename).split(sep).join('/');const own=file.match(/^packages\/([^/]+)\//)?.[1];
 if(!own || !(own in allowed)) return [];const errors:string[]=[];const browser=own==='client'||own==='contracts';
 const parsed=parseSync(filename,source,{sourceType:'module'});
 if(parsed.errors.length) return parsed.errors.map(error=>`${file}: parse error: ${error.message}`);
 const inspect=(specifier:string)=>{
  if(specifier.startsWith('.')) {
   const target=relative(root,resolve(dirname(filename),specifier)).split(sep).join('/');
   const pkg=target.match(/^packages\/([^/]+)\//)?.[1];
   if(!pkg || (pkg!==own&&!allowed[own]!.includes(pkg)))errors.push(`${file}: forbidden relative import ${specifier}`);
  }else if(specifier.startsWith('@bunly/')) {
   const pkg=specifier.slice('@bunly/'.length).split('/')[0]!;
   if(pkg!==own&&!allowed[own]!.includes(pkg))errors.push(`${file}: forbidden package ${specifier}`);
  }else if(browser)errors.push(`${file}: browser package imports ${specifier}`);
 };
 function object(value:unknown):Record<string,unknown>|undefined {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
 }
 function literal(value:unknown):string|undefined {
  const node=object(value);if(!node)return undefined;
  if(typeof node['value']==='string')return node['value'];
  if(node['type']==='TSLiteralType')return literal(node['literal']);
  return undefined;
 }
 function moduleSource(value:unknown):void {
  const source=literal(value);
  if(source===undefined)errors.push(`${file}: non-literal module load cannot be boundary-checked`);else inspect(source);
 }
 function walk(value:unknown):void {
  if(Array.isArray(value)){for(const child of value)walk(child);return;}
  const node=object(value);if(!node)return;
  const type=node['type'];
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(type as string)&&node['source'])moduleSource(node['source']);
  if(type==='ImportExpression')moduleSource(node['source']);
  if(type==='TSImportType')moduleSource(node['source']??node['argument']);
  if(type==='TSExternalModuleReference')moduleSource(node['expression']);
  const callee=object(node['callee']);
  if(type==='CallExpression'&&callee?.['type']==='Identifier'&&callee['name']==='require') {
   const args=node['arguments'];moduleSource(Array.isArray(args)?args[0]:undefined);
  }
  if(browser&&type==='Identifier'&&['Bun','process','require'].includes(node['name'] as string))errors.push(`${file}: browser package uses host global ${node['name']}`);
  for(const child of Object.values(node))if(child&&typeof child==='object')walk(child);
 }
 walk(parsed.program);return errors;
}
async function files(dir:string):Promise<string[]> {
 const result:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})) {
  if(['node_modules','dist','target'].includes(e.name))continue;const path=resolve(dir,e.name);
  if(e.isDirectory())result.push(...await files(path));else if(/\.[mc]?tsx?$/.test(e.name))result.push(path);
 }return result;
}
export async function checkBoundaries(root:string):Promise<string[]> {
 const errors:string[]=[];
 for(const file of await files(resolve(root,'packages')))errors.push(...inspectSource(file,await readFile(file,'utf8'),root));
 for(const [name,deps] of Object.entries(allowed)) {
  const pkg=JSON.parse(await readFile(resolve(root,`packages/${name}/package.json`),'utf8')) as {dependencies?:Record<string,string>};
  for(const key of Object.keys(pkg.dependencies??{}))if(!deps.map(d=>'@bunly/'+d).includes(key))errors.push(`${name}: unexpected runtime dependency ${key}`);
 }
 return errors;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const errors=await checkBoundaries(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
 if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Workspace and browser boundaries verified');
}
