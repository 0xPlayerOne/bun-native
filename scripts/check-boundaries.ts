import ts from 'typescript';
import { readdir,readFile } from 'node:fs/promises';
import { resolve,dirname,relative,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const allowed:Record<string,readonly string[]>={contracts:[],client:['contracts'],runtime:['contracts'],artifacts:[],cli:['artifacts','contracts']};
export function inspectSource(filename:string,source:string,root:string):string[] {
 const file=relative(root,filename).split(sep).join('/');const own=file.match(/^packages\/([^/]+)\//)?.[1];
 if(!own || !(own in allowed)) return [];const errors:string[]=[];const browser=own==='client'||own==='contracts';
 const parsed=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
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
 function walk(node:ts.Node):void {
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))inspect(node.moduleSpecifier.text);
  if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal))inspect(node.argument.literal.text);
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))) {
   const arg=node.arguments[0];if(arg&&ts.isStringLiteralLike(arg))inspect(arg.text);else errors.push(`${file}: non-literal module load cannot be boundary-checked`);
  }
  if(browser&&ts.isIdentifier(node)&&['Bun','process','require'].includes(node.text))errors.push(`${file}: browser package uses host global ${node.text}`);
  ts.forEachChild(node,walk);
 }
 walk(parsed);return errors;
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
