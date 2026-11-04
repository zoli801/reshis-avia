#!/usr/bin/env node
/** Offline publication gate. It reports locations and rules, never matched values. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,readdirSync,readFileSync,readlinkSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const runtimeDirectories=new Set(['.git','node_modules','dist','.next','.vinext','.wrangler','.sites-runtime','coverage']);
const forbiddenDirectories=new Set(['.git','node_modules','dist','.next','.vinext','.wrangler','.sites-runtime','.codex','.agents','outputs','work','coverage']);
const examples=new Set(['.env.example','.dev.vars.example']);
const sensitiveKey=/(?:TOKEN|SECRET|PASSWORD|PEPPER|PRIVATE_KEY|API_KEY|ACCESS_KEY|DATABASE_URL)/i;
const rules=[
 ['telegram-token',/(?<![A-Za-z0-9])\d{6,12}:[A-Za-z0-9_-]{30,50}/g],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{30,255})\b/g],
 ['openai-key',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g],
 ['google-api-key',/\bAIza[0-9A-Za-z_-]{35}\b/g],
 ['aws-access-key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
 ['slack-token',/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
 ['docker-token',/\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
 ['credential-url',/\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/<>:@"']+:[^\s/<>@"']+@/g],
];
const digest=data=>createHash('sha256').update(data).digest('hex');

function git(root,args,input){
 const r=spawnSync('git',['-C',root,...args],{input,encoding:null,maxBuffer:128*1024*1024,timeout:30000});
 if(r.status!==0||r.error)throw new Error('Не удалось прочитать локальный Git. Проверьте режим и ссылку на коммит.');
 return r.stdout;
}
function requireOwnRepository(root){
 const top=git(root,['rev-parse','--show-toplevel']).toString().trim();
 if(realpathSync(top)!==realpathSync(root))throw new Error('Каталог проверки должен быть корнем отдельного Git-репозитория.');
}
function workingEntries(root){
 const result=[];
 function walk(relative=''){
  for(const name of readdirSync(path.join(root,relative))){
   if(runtimeDirectories.has(name)||name==='.DS_Store')continue;
   const relativeName=relative?relative+'/'+name:name,absolute=path.join(root,relativeName),stat=lstatSync(absolute);
   if(stat.isDirectory())walk(relativeName);
   else if(stat.isSymbolicLink())result.push({path:relativeName,mode:'120000',data:Buffer.from(readlinkSync(absolute))});
   else if(stat.isFile())result.push({path:relativeName,mode:stat.mode&0o111?'100755':'100644',data:readFileSync(absolute)});
  }
 }
 walk();return result;
}
function indexRecords(root){
 return git(root,['ls-files','--stage','-z']).toString().split('\0').filter(Boolean).map(line=>{
  const tab=line.indexOf('\t'),header=line.slice(0,tab).split(' ');
  if(tab<0||header[2]!=='0')throw new Error('Индекс содержит неразрешённый конфликт.');
  return {path:line.slice(tab+1),mode:header[0],oid:header[1]};
 });
}
function treeRecords(root,ref){
 return git(root,['ls-tree','-r','-z',ref]).toString().split('\0').filter(Boolean).map(line=>{
  const tab=line.indexOf('\t'),header=line.slice(0,tab).split(' ');
  if(tab<0)throw new Error('Не удалось прочитать дерево Git.');
  return {path:line.slice(tab+1),mode:header[0],oid:header[2]};
 });
}
function withBlobData(root,records){
 const ids=[...new Set(records.filter(r=>r.mode!=='160000').map(r=>r.oid))];
 if(!ids.length)return records.map(r=>({...r,data:Buffer.alloc(0)}));
 const output=git(root,['cat-file','--batch'],Buffer.from(ids.join('\n')+'\n')),blobs=new Map();let cursor=0;
 for(const oid of ids){
  const end=output.indexOf(10,cursor);if(end<0)throw new Error('Неполный ответ Git при чтении файлов.');
  const header=output.subarray(cursor,end).toString().split(' '),size=Number(header[2]);
  if(header[0]!==oid||header[1]!=='blob'||!Number.isSafeInteger(size)||size<0||size>32*1024*1024)throw new Error('Неподдерживаемый или слишком большой файл в публикации.');
  const start=end+1;blobs.set(oid,output.subarray(start,start+size));cursor=start+size+1;
 }
 return records.map(r=>({...r,data:r.mode==='160000'?Buffer.alloc(0):blobs.get(r.oid)}));
}
export function publicationEntries(root,mode='working',ref='HEAD'){
 if(mode==='working')return workingEntries(root);
 requireOwnRepository(root);
 if(mode==='staged')return withBlobData(root,indexRecords(root));
 if(mode==='tree')return withBlobData(root,treeRecords(root,ref));
 if(mode==='history'){
  const commits=git(root,['rev-list',ref]).toString().trim().split('\n').filter(Boolean);
  if(commits.length>5000)throw new Error('История слишком велика для этой локальной проверки.');
  const unique=new Map();
  for(const commit of commits)for(const record of treeRecords(root,commit))unique.set(record.path+'\0'+record.mode+'\0'+record.oid,record);
  return withBlobData(root,[...unique.values()]);
 }
 throw new Error('Неизвестный режим проверки.');
}
function parseEnvironment(data){
 return data.toString().split(/\r?\n/).flatMap((line,index)=>{
  const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(!match)return [];
  let value=match[2].trim();
  if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  else value=value.replace(/\s+#.*$/,'').trim();
  return [{key:match[1],value,line:index+1}];
 });
}
export function knownSecrets(environmentPaths=[]){
 const values=new Set();
 for(const file of environmentPaths){
  if(!existsSync(file))throw new Error('Указанный локальный файл секретов не найден.');
  for(const {key,value} of parseEnvironment(readFileSync(file)))if(sensitiveKey.test(key)&&value.length>=12){
   values.add(value);values.add(encodeURIComponent(value));values.add(Buffer.from(value).toString('base64'));
  }
 }
 return [...values].map(value=>Buffer.from(value));
}
function forbiddenPath(name){
 const parts=name.split('/'),base=parts.at(-1);
 if(parts.some(p=>forbiddenDirectories.has(p)))return true;
 if(examples.has(base))return false;
 return /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.DS_Store)$/.test(base)||/\.(?:pem|key|p12|pfx|keystore|sqlite|sqlite3|db|bak|log|zip|tar|tgz|gz)$/i.test(base);
}
export function auditEntries(entries,secrets=[]){
 const findings=[],seen=new Set();
 function add(entry,rule,line=0){const key=entry.path+'\0'+entry.oid+'\0'+rule+'\0'+line;if(seen.has(key))return;seen.add(key);findings.push({path:entry.path,rule,...(line?{line}:{})});}
 for(const entry of entries){
  if(forbiddenPath(entry.path))add(entry,'forbidden-publication-path');
  if(!['100644','100755'].includes(entry.mode))add(entry,'symlink-or-submodule');
  const data=entry.data;
  if(secrets.some(value=>data.includes(value)))add(entry,'known-secret-value');
  if(data.subarray(0,8192).includes(0))continue; // Raw known-value checks still cover binary assets.
  const text=data.toString('utf8');
  for(const [rule,pattern] of rules){pattern.lastIndex=0;const match=pattern.exec(text);if(match)add(entry,rule,text.slice(0,match.index).split('\n').length);}
  if(examples.has(path.basename(entry.path)))for(const item of parseEnvironment(data))if(sensitiveKey.test(item.key)&&item.value)add(entry,'nonempty-secret-example',item.line);
 }
 return findings;
}
export function contentManifest(entries){
 return entries.map(e=>({path:e.path,sha256:digest(e.data)})).sort((a,b)=>a.path.localeCompare(b.path)||a.sha256.localeCompare(b.sha256));
}
function outsideRoot(root,file){const relative=path.relative(root,path.resolve(file));if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Файл отчёта должен находиться вне каталога публикации.');}
export function main(argv=process.argv.slice(2)){
 const options={root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),mode:'working',ref:'HEAD',known:[]};
 for(let i=0;i<argv.length;i++){
  const [flag,inline]=argv[i].split(/=(.*)/s,2),value=inline??argv[++i];
  if(value===undefined)throw new Error('Не задано значение параметра.');
  if(flag==='--root')options.root=path.resolve(value);
  else if(flag==='--mode')options.mode=value;
  else if(flag==='--ref')options.ref=value;
  else if(flag==='--known-env')options.known.push(path.resolve(value));
  else if(flag==='--manifest')options.manifest=path.resolve(value);
  else if(flag==='--verify-manifest')options.verify=path.resolve(value);
  else throw new Error('Неизвестный параметр проверки.');
 }
 const entries=publicationEntries(options.root,options.mode,options.ref),findings=auditEntries(entries,knownSecrets(options.known)),files=contentManifest(entries);
 if(options.verify){outsideRoot(options.root,options.verify);const previous=JSON.parse(readFileSync(options.verify,'utf8'));if(JSON.stringify(previous.files)!==JSON.stringify(files))findings.push({path:'.',rule:'reviewed-manifest-mismatch'});}
 if(findings.length){process.stderr.write(JSON.stringify({status:'blocked',files_scanned:entries.length,findings},null,2)+'\n');return 1;}
 const report={status:'passed',mode:options.mode,files_scanned:entries.length,manifest_sha256:digest(JSON.stringify(files)),files};
 if(options.manifest){outsideRoot(options.root,options.manifest);writeFileSync(options.manifest,JSON.stringify(report,null,2)+'\n');}
 process.stdout.write(JSON.stringify({status:report.status,mode:options.mode,files_scanned:report.files_scanned,manifest_sha256:report.manifest_sha256})+'\n');return 0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{process.exitCode=main();}catch{process.stderr.write('Проверка секретов не завершена. Проверьте параметры, корень репозитория и доступность локальных файлов.\n');process.exitCode=2;}}
