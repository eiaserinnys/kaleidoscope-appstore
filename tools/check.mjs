import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here=dirname(fileURLToPath(import.meta.url));
const ajv=new Ajv2020({allErrors:true,strict:false});
const appAjv=new Ajv2020({allErrors:false,strict:false});
for(const instance of [ajv,appAjv]){
 addFormats(instance);
 for(const bits of [8,16,32,64])instance.addFormat(`uint${bits}`,{type:'number',validate:value=>Number.isInteger(value)&&value>=0&&value<2**bits});
 instance.addFormat('double',{type:'number',validate:Number.isFinite});
}
const validateApp=appAjv.compile(JSON.parse(readFileSync(resolve(here,'../schema/app-definition.schema.json'))));
const builtin=new Set(JSON.parse(readFileSync(resolve(here,'builtin-ids.json'))));
const formats=['html','svg','png','webp','jpeg','gif','javascript','woff2','ttf','otf'];
const validateStore=ajv.compile({type:'object',additionalProperties:false,required:['summary','description','category','publisher','release','listed','icon','assets'],properties:{
  summary:{type:'string',minLength:1,maxLength:80},description:{type:'string',maxLength:4000},category:{type:'string',minLength:1,maxLength:24},publisher:{type:'string',minLength:1},release:{type:'integer',minimum:1},listed:{type:'boolean'},icon:{type:['string','null']},
  assets:{type:'array',items:{type:'object',additionalProperties:false,required:['id','version','file','format','source','license'],properties:{id:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9._-]*$'},version:{type:'integer',minimum:1},file:{type:'string',pattern:'^assets/(?!.*(?:^|/)\\.\\.?/)[^\\\\]+$'},format:{enum:formats},source:{type:'string'},license:{type:'string'}}}}
  ,connections:{type:'array',items:{type:'object',additionalProperties:false,required:['name','kind','base_url','paths','writable','description'],properties:{name:{type:'string',pattern:'^[a-z0-9-]{1,64}$'},kind:{const:'oauth'},base_url:{type:'string'},issuer:{type:['string','null']},resource:{type:['string','null']},scopes:{type:['string','null']},paths:{type:'array',items:{type:'string'}},writable:{type:'boolean'},description:{type:'string'}}}}
}});
function validBaseUrl(value){
 try{const url=new URL(value);return (url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))&&!value.includes('?')&&!value.includes('#')&&!url.username&&!url.password;}
 catch{return false;}
}
function validPath(path){
 if(path==='/')return true;
 if(!path.startsWith('/')||/[?#\\\\\s]/u.test(path)||/%00/i.test(path))return false;
 const rest=path.slice(1).replace(/\/$/,'');
 return !!rest&&rest.split('/').every(part=>part!==''&&part.toLowerCase().replace(/%2e/g,'.').replace(/%2f|%5c/g,'/').split('/').every(piece=>piece!=='.'&&piece!=='..'));
}
const secret=/sk-ant-[A-Za-z0-9_-]*|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]*|xox[abpr]-[A-Za-z0-9-]*|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const maskSecrets=value=>value.replace(secret,match=>`${match.slice(0,4)}…`);
const args=process.argv.slice(2); const flag=k=>args[args.indexOf(k)+1];
const all=args.includes('--all'); const author=flag('--author');
function git(...args){return execFileSync('git',args,{maxBuffer:30*1024*1024,stdio:['ignore','pipe','pipe']});}
function commit(ref){return git('rev-parse','--verify',`${ref}^{commit}`).toString().trim();}
function files(ref,prefix=''){return git('ls-tree','-r','-z','--full-tree',ref,'--',prefix).toString().split('\0').filter(Boolean).map(line=>{const m=/^(\d+) \w+ [0-9a-f]+\t(.*)$/s.exec(line);return {mode:m[1],path:m[2]};});}
function blob(ref,path){try{return git('show',`${ref}:${path}`);}catch{return null;}}
function parse(ref,path,errors){const data=blob(ref,path);if(!data){errors.push(`${path}: 파일이 없습니다`);return null;}try{return JSON.parse(data);}catch{errors.push(`${path}: JSON 형식이 잘못되었습니다`);return null;}}
function recordError(path,message){return `${path}: ${message}`;}
function safeFile(path){return path.startsWith('assets/') && !path.split('/').some(x=>!x || x==='.' || x==='..') && !path.includes('\\');}
function scrub(value,path,errors){if(typeof value==='string'){for(const match of value.matchAll(secret))errors.push(recordError(path,`비밀값으로 보이는 문자열 ${match[0]}를 지워 주세요`));}else if(value&&typeof value==='object'){for(const [key,child] of Object.entries(value)){scrub(key,path,errors);scrub(child,path,errors);}}}
function checkApp(ref,id,errors){
 const dir=`apps/${id}`, appPath=`${dir}/app.json`, storePath=`${dir}/store.json`;
 const entries=files(ref,dir+'/'); const byPath=new Map(entries.map(e=>[e.path,e]));
 for(const e of entries)if(e.mode!=='100644'&&e.mode!=='100755')errors.push(recordError(e.path,'일반 파일만 올릴 수 있습니다'));
 const appBytes=blob(ref,appPath); if(appBytes&&appBytes.length>1024*1024)errors.push(recordError(appPath,'앱 정의 크기는 1 MiB 이하여야 합니다'));
 const app=parse(ref,appPath,errors), store=parse(ref,storePath,errors);
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))errors.push(recordError(dir,'앱 폴더 id 형식이 올바르지 않습니다'));
 if(builtin.has(id))errors.push(recordError(dir,'기본 앱 id는 사용할 수 없습니다'));
 if(app){if(!validateApp(app))errors.push(recordError(appPath,`앱 스키마가 맞지 않습니다: ${appAjv.errorsText(validateApp.errors)}`));if(app.id!==id)errors.push(recordError(appPath,'앱 id와 폴더 이름이 다릅니다'));scrub(app,appPath,errors);}
 let assets=[];
 if(store){if(!validateStore(store))errors.push(recordError(storePath,`스토어 형식이 맞지 않습니다: ${ajv.errorsText(validateStore.errors)}`));scrub(store,storePath,errors); if(Array.isArray(store.assets))assets=store.assets.filter(a=>a&&typeof a==='object');}
 const connections=Array.isArray(store?.connections)?store.connections:[];
 for(const connection of connections){
  if(connection&&typeof connection==='object'&&(!validBaseUrl(connection.base_url)||!Array.isArray(connection.paths)||connection.paths.some(path=>typeof path!=='string'||!validPath(path))))errors.push(recordError(storePath,'연결 주소 또는 경로가 올바르지 않습니다'));
 }
 const names=connections.map(connection=>connection?.name);
 const required=[...new Set((Array.isArray(app?.permissions)?app.permissions:[]).filter(p=>p?.module==='connection').map(p=>p.connection))];
 if(new Set(names).size!==names.length||required.some(name=>!names.includes(name))||names.some(name=>!required.includes(name)))errors.push(recordError(storePath,'연결 정의 이름은 앱의 연결 권한과 같아야 합니다'));
 const allowed=new Set([appPath,storePath]);let bytes=0;
 const keys=[];
 for(const a of assets){if(typeof a.id==='string'&&Number.isInteger(a.version))keys.push(`${a.id}@${a.version}`);if(typeof a.file!=='string'||!safeFile(a.file)){errors.push(recordError(storePath,'자산 파일은 assets/ 아래에 있어야 합니다'));continue;}const path=`${dir}/${a.file}`;allowed.add(path);const content=blob(ref,path);if(!content)errors.push(recordError(path,'자산 파일이 없습니다'));else bytes+=content.length;}
 if(bytes>10*1024*1024)errors.push(recordError(storePath,'자산 크기 합계는 10 MiB 이하여야 합니다'));
 if(new Set(keys).size!==keys.length)errors.push(recordError(storePath,'자산 id와 판이 중복되었습니다'));
 const appKeys=Array.isArray(app?.assets)?app.assets.map(a=>`${a.id}@${a.version}`).sort():[];
 if(JSON.stringify([...keys].sort())!==JSON.stringify(appKeys))errors.push(recordError(storePath,'앱 정의와 자산 id 및 판이 다릅니다'));
 if(store?.icon!==null&&store?.icon!==undefined&&!assets.some(a=>a.file===store.icon))errors.push(recordError(storePath,'아이콘은 자산 파일 중 하나여야 합니다'));
 if(app?.icon){
  const iconAsset=assets.find(a=>a.id===app.icon.asset&&a.version===app.icon.version);
  if(!iconAsset||store?.icon!==iconAsset.file)errors.push(recordError(storePath,'app.json의 아이콘과 store.json의 icon이 다른 자산을 가리킵니다'));
  if(iconAsset&&!['svg','png','webp'].includes(iconAsset.format))errors.push(recordError(storePath,'앱 아이콘 자산 형식은 SVG, PNG 또는 WebP여야 합니다'));
  if(app.requires?.blocks<26)errors.push(recordError(appPath,'앱 아이콘을 사용하려면 blocks 26 이상이 필요합니다'));
 }
 const screens=entries.filter(e=>/^screenshots\/[1-5]\.(png|webp)$/.test(e.path.slice(dir.length+1)));
 if(screens.length>5||new Set(screens.map(e=>/\/([1-5])\.(?:png|webp)$/.exec(e.path)[1])).size!==screens.length)errors.push(recordError(`${dir}/screenshots`,'스크린샷은 번호마다 한 장씩 다섯 장까지입니다'));
 for(const e of screens){allowed.add(e.path);const data=blob(ref,e.path);if(data.length>2*1024*1024)errors.push(recordError(e.path,'스크린샷 크기는 2 MiB 이하여야 합니다'));const png=data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));const webp=data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';if((e.path.endsWith('.png')&&!png)||(e.path.endsWith('.webp')&&!webp))errors.push(recordError(e.path,'스크린샷 파일 형식이 올바르지 않습니다'));}
 for(const e of entries)if(!allowed.has(e.path))errors.push(recordError(e.path,'허용하지 않는 앱 파일입니다'));
 return {app,store,entries};
}
function changedContent(base,head,id,oldStore,newStore){
 const prefix=`apps/${id}/`;const changes=git('diff','--name-only','--no-renames','-z',base,head,'--',prefix).toString().split('\0').filter(Boolean);
 if(changes.some(p=>p!==`${prefix}store.json`))return true;
 const a={...oldStore},b={...newStore};delete a.release;delete b.release;return !isDeepStrictEqual(a,b);
}
function remoteReleases(){
 const {R2_ACCOUNT_ID:account,R2_BUCKET:bucket,AWS_ACCESS_KEY_ID:access,AWS_SECRET_ACCESS_KEY:secretKey}=process.env;
 if(!account||!bucket||!access||!secretKey)throw Error('R2 기존 판을 확인하려면 R2 접속 설정이 필요합니다');
 try{const data=gitlessAws(['s3api','list-objects-v2','--bucket',bucket,'--prefix','appstore/apps/','--output','json','--endpoint-url',`https://${account}.r2.cloudflarestorage.com`,'--region','auto']);return (JSON.parse(data).Contents||[]).map(item=>item.Key);}
 catch{throw Error('R2 기존 판 목록을 읽지 못했습니다. R2 접속 설정을 확인해 주세요');}
}
function gitlessAws(args){return execFileSync('aws',args,{encoding:'utf8',maxBuffer:30*1024*1024,stdio:['ignore','pipe','pipe']});}
try{
 const head=commit(args.includes('--head')?flag('--head'):'HEAD'); const base=all?null:git('merge-base',commit(flag('--base')),head).toString().trim();
 if(!all&&!author)throw Error('--author와 --base가 필요합니다');
 const remote=all?remoteReleases():[];
 const changed=all?files(head,'apps/').map(x=>x.path):git('diff','--name-only','--no-renames','-z',base,head).toString().split('\0').filter(Boolean);
 const errors=[];const ids=new Set();
 for(const path of changed){const match=/^apps\/([^/]+)\//.exec(path);if(match)ids.add(match[1]);else if(!all&&author!=='eiaserinnys')errors.push(recordError(path,'이 경로는 저장소 관리자만 변경할 수 있습니다'));}
 const summaries=[];
 for(const id of [...ids].sort()){
  const path=`apps/${id}/store.json`,old=base?blob(base,path):null,current=blob(head,path),oldStore=old?parse(base,path,errors):null;
  if(base&&oldStore){if(author!==oldStore.publisher&&author!=='eiaserinnys')errors.push(recordError(path,'이 앱의 게시자만 수정하거나 삭제할 수 있습니다'));}
  if(!current){if(files(head,`apps/${id}/`).length)errors.push(recordError(path,'스토어 파일이 없습니다'));continue;}
  const result=checkApp(head,id,errors),s=result.store;
  if(!s)continue;
  if(all&&remote.some(key=>{const match=/^appstore\/apps\/([^/]+)\/(\d+)\/manifest\.json$/.exec(key);return match&&match[1]===id&&Number(match[2])>s.release;}))errors.push(recordError(path,'R2에 더 높은 판이 있어 배포할 수 없습니다'));
  if(base){if(oldStore){if(s.publisher!==oldStore.publisher)errors.push(recordError(path,'게시자를 바꿀 수 없습니다'));const changed=changedContent(base,head,id,oldStore,s);if(changed&&s.release!==oldStore.release+1)errors.push(recordError(path,'내용 변경 시 release를 정확히 1 올려 주세요'));if(!changed&&s.release!==oldStore.release)errors.push(recordError(path,'내용 없이 release만 바꿀 수 없습니다'));}else{if(s.publisher!==author)errors.push(recordError(path,'새 앱 게시자는 PR 작성자여야 합니다'));if(s.release!==1)errors.push(recordError(path,'새 앱 release는 1이어야 합니다'));}}
  if(result.app){const badges=[];const processes=result.app.permissions?.filter(p=>p.module==='process')??[];const commands=processes.map(p=>p.command).filter(command=>command!=null);if(processes.length)badges.push(commands.length?`process(${commands.join(', ')})`:'process');if(Object.hasOwn(result.app,'worker'))badges.push('worker');summaries.push(`| ${String(result.app.name).replaceAll('|','\\|')} | ${s.release} | ${JSON.stringify(result.app.permissions??[]).replaceAll('|','\\|')} | ${(badges.join(', ')||'없음').replaceAll('|','\\|')} |`);}
 }
 if(errors.length){for(const e of errors)console.error(maskSecrets(e));process.exitCode=1;}else{console.log(`검사 통과: 앱 ${ids.size}개`);if(process.env.GITHUB_STEP_SUMMARY&&summaries.length)appendFileSync(process.env.GITHUB_STEP_SUMMARY,maskSecrets(`\n| 이름 | release | 권한 | 배지 |\n| --- | --- | --- | --- |\n${summaries.join('\n')}\n`));}
}catch(error){console.error(maskSecrets(`검사를 실행할 수 없습니다: ${error.message}`));process.exitCode=1;}
