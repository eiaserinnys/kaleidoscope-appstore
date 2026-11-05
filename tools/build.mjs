import { readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=process.cwd();
const args=process.argv.slice(2);const outAt=args.indexOf('--out');const out=resolve(outAt===-1?'dist':args[outAt+1]||'dist');
const publishAt=args.indexOf('--publish-pr-url');let publish;
if(publishAt!==-1){
 const url=args[publishAt+1];
 try{if(new URL(url).protocol!=='https:')throw Error();}catch{throw Error('--publish-pr-url에는 HTTPS 주소가 필요합니다');}
 publish={method:'pull_request',url};
}
const target=join(out,'appstore');rmSync(target,{recursive:true,force:true});mkdirSync(target,{recursive:true});
const write=(path,data)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data);};
const writeJson=(path,data)=>write(path,JSON.stringify(data,null,2)+'\n');
const readJson=path=>JSON.parse(readFileSync(path));
const digest=data=>({sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length});
const now=new Date().toISOString();const items=[];const appDir=join(root,'apps');
for(const id of (existsSync(appDir)?readdirSync(appDir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort():[])){
 const dir=join(appDir,id);const appBytes=readFileSync(join(dir,'app.json'));const app=JSON.parse(appBytes);const store=readJson(join(dir,'store.json'));
 const prefix=`apps/${id}/${store.release}`;const files={};
 function add(relative,data,meta={}){const path=`${prefix}/${relative}`;write(join(target,path),data);files[path]={...digest(data),...meta};return path;}
 add('app.json',appBytes);
 for(const asset of store.assets){const data=readFileSync(join(dir,asset.file));add(`assets/${asset.id}/${asset.version}`,data,{format:asset.format,source:asset.source,license:asset.license});}
 const screenshotsDir=join(dir,'screenshots');const screenshots=(existsSync(screenshotsDir)?readdirSync(screenshotsDir).filter(x=>/^[1-5]\.(png|webp)$/.test(x)).sort():[]).map(name=>add(`screenshots/${name}`,readFileSync(join(screenshotsDir,name))));
 const iconAsset=store.assets.find(a=>a.file===store.icon);const icon=iconAsset?`${prefix}/assets/${iconAsset.id}/${iconAsset.version}`:null;
 const badges=[];if(app.permissions?.some(p=>p.module==='process'))badges.push('process');if(Object.hasOwn(app,'worker'))badges.push('worker');
 const manifest={format:1,store_app_id:id,release:store.release,name:app.name,summary:store.summary,description:store.description,category:store.category,publisher:store.publisher,icon,screenshots,requires:app.requires,permissions:app.permissions??[],badges,files,published_at:now};
 if(store.connections!==undefined)manifest.connections=store.connections;
 writeJson(join(target,prefix,'manifest.json'),manifest);
 const detail={format:1,id,name:app.name,summary:store.summary,description:store.description,category:store.category,publisher:store.publisher,release:store.release,icon,screenshots,releases:[{release:store.release,published_at:now,manifest:`${prefix}/manifest.json`}]};
 writeJson(join(target,'apps',id,'index.json'),detail);
 if(store.listed)items.push({id,name:app.name,summary:store.summary,category:store.category,publisher:store.publisher,release:store.release,icon,badges,requires:app.requires,updated_at:now});
}
writeJson(join(target,'index.json'),{format:1,generated_at:now,items,...(publish?{publish}:{})});
if(existsSync(join(root,'site/index.html')))copyFileSync(join(root,'site/index.html'),join(target,'index.html'));
console.log(`빌드 완료: ${items.length}개 공개 앱, ${target}`);
