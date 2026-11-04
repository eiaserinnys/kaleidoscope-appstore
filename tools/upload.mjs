import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const json=p=>JSON.parse(readFileSync(p));
const writeJson=(p,data)=>writeFileSync(p,JSON.stringify(data,null,2)+'\n');
const immutable='public, max-age=31536000, immutable';const short='public, max-age=60';
const types={html:'text/html; charset=utf-8',javascript:'text/javascript; charset=utf-8',svg:'image/svg+xml',png:'image/png',webp:'image/webp',jpeg:'image/jpeg',gif:'image/gif',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};
const historyPattern=/^appstore\/apps\/([^/]+)\/(\d+)\/manifest\.json$/;
function hashes(files){return Object.fromEntries(Object.entries(files).map(([p,v])=>[p,v.sha256]).sort(([a],[b])=>a.localeCompare(b)));}
async function prepare(dist,remote){
 const root=join(dist,'appstore');const listing=await remote.list();const keys=new Set(listing);const index=json(join(root,'index.json'));const detailRoot=join(root,'apps');
 const ids=existsSync(detailRoot)?readdirSync(detailRoot,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort():[];
 const puts=[],skips=[],deletes=[];
 for(const id of ids){
  const detailPath=join(detailRoot,id,'index.json');const detail=json(detailPath);const release=detail.release;const prefix=`appstore/apps/${id}/${release}`;const manifestPath=join(root,'apps',id,String(release),'manifest.json');const current=json(manifestPath);
  const histories=listing.map(k=>[k,historyPattern.exec(k)]).filter(([,m])=>m&&m[1]===id).map(([key,m])=>({key,release:Number(m[2])}));
  if(histories.some(h=>h.release>release))throw Error(`${id} ${release}판: 기존에 더 높은 판이 있어 배포할 수 없습니다`);
  const old=[];for(const h of histories){const m=await remote.get(h.key);old.push({release:h.release,published_at:m.published_at,manifest:h.key.slice('appstore/'.length)});}
  if(keys.has(`${prefix}/manifest.json`)){
   const existing=await remote.get(`${prefix}/manifest.json`);
   if(JSON.stringify(hashes(existing.files))!==JSON.stringify(hashes(current.files)))throw Error(`${id} ${release}판: 이미 배포된 파일의 sha256이 다릅니다`);
   current.published_at=existing.published_at;skips.push(`건너뛰기 ${prefix}/ (이미 배포된 판)`);
  }else{
   for(const [path,meta] of Object.entries(current.files)){
    const format=meta.format||(path.endsWith('.json')?'json':path.split('.').pop());const type=format==='json'?'application/json':types[format];
    puts.push({key:`appstore/${path}`,file:join(root,path),type,cache:immutable,attachment:format==='html'||format==='javascript'});
   }
   puts.push({key:`${prefix}/manifest.json`,file:manifestPath,type:'application/json',cache:immutable});
  }
  detail.releases=[...old.filter(h=>h.release!==release),{release,published_at:current.published_at,manifest:`apps/${id}/${release}/manifest.json`}].sort((a,b)=>b.release-a.release);
  const item=index.items.find(i=>i.id===id);if(item)item.updated_at=current.published_at;
  writeJson(manifestPath,current);writeJson(detailPath,detail);
  puts.push({key:`appstore/apps/${id}/index.json`,file:detailPath,type:'application/json',cache:short});
 }
 writeJson(join(root,'index.json'),index);
 puts.push({key:'appstore/index.json',file:join(root,'index.json'),type:'application/json',cache:short});
 if(existsSync(join(root,'index.html')))puts.push({key:'appstore/index.html',file:join(root,'index.html'),type:'text/html; charset=utf-8',cache:short});
 for(const key of listing){const match=/^appstore\/apps\/([^/]+)\/index\.json$/.exec(key);if(match&&!ids.includes(match[1]))deletes.push(key);}
 // Upload all immutable files before publishing any mutable index.
 puts.sort((a,b)=>(a.cache===short)-(b.cache===short));
 return {puts,skips,deletes};
}
export async function planUpload(dist,remote){const plan=await prepare(resolve(dist),remote);return [...plan.skips,...plan.puts.map(p=>`올리기 ${p.key}`),...plan.deletes.map(k=>`삭제 ${k}`)];}
function s3(){
 const account=process.env.R2_ACCOUNT_ID,bucket=process.env.R2_BUCKET;if(!account||!bucket||!process.env.AWS_ACCESS_KEY_ID||!process.env.AWS_SECRET_ACCESS_KEY)throw Error('R2 접속 설정이 없습니다');
 const endpoint=`https://${account}.r2.cloudflarestorage.com`;const aws=(...args)=>{try{return execFileSync('aws',[...args,'--endpoint-url',endpoint,'--region','auto'],{maxBuffer:30*1024*1024,stdio:['ignore','pipe','pipe']});}catch{throw Error('R2 요청에 실패했습니다. 접속 설정과 저장소 상태를 확인해 주세요');}};
 return {list:async()=>{const data=JSON.parse(aws('s3api','list-objects-v2','--bucket',bucket,'--prefix','appstore/','--output','json'));return(data.Contents||[]).map(o=>o.Key);},get:async key=>JSON.parse(aws('s3','cp',`s3://${bucket}/${key}`,'-').toString()),
  put:p=>{const args=['s3','cp',p.file,`s3://${bucket}/${p.key}`,'--content-type',p.type,'--cache-control',p.cache];if(p.attachment)args.push('--content-disposition','attachment');aws(...args);},remove:key=>aws('s3','rm',`s3://${bucket}/${key}`)};
}
async function main(){const args=process.argv.slice(2);const at=args.indexOf('--dist');if(at<0||!args[at+1])throw Error('--dist 경로가 필요합니다');const dist=resolve(args[at+1]);const dry=args.includes('--dry-run');const remote=dry?{list:async()=>[],get:async()=>null}:s3();const plan=await prepare(dist,remote);for(const s of plan.skips)console.log(s);for(const p of plan.puts){console.log(`올리기 ${p.key}`);if(!dry)remote.put(p);}for(const key of plan.deletes){console.log(`삭제 ${key}`);if(!dry)remote.remove(key);}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
