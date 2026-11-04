import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const check = join(root, 'tools/check.mjs');
const build = join(root, 'tools/build.mjs');
const upload = join(root, 'tools/upload.mjs');
const template = JSON.parse(readFileSync(join(root, 'tools/test/fixtures/app.json')));
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const git = (dir, ...args) => execFileSync('git', args, {cwd:dir, encoding:'utf8'}).trim();
const json = (p, obj) => { mkdirSync(dirname(p), {recursive:true}); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'appstore-test-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'test@example.com'); git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  return dir;
}
function app(dir, id='hello', changes={}) {
  const folder = join(dir, 'apps', id); mkdirSync(join(folder, 'assets'), {recursive:true});
  const definition = {...structuredClone(template), id, name:'시험 앱', assets:[{id:'icon', version:1}]};
  const store = {summary:'짧은 설명',description:'상세',category:'도구',publisher:'alice',release:1,listed:true,icon:'assets/icon.svg',assets:[{id:'icon',version:1,file:'assets/icon.svg',format:'svg',source:'직접 제작',license:'MIT'}], ...changes};
  json(join(folder, 'app.json'), definition); json(join(folder, 'store.json'), store);
  writeFileSync(join(folder, 'assets/icon.svg'), '<svg/>');
  mkdirSync(join(folder, 'screenshots'), {recursive:true}); writeFileSync(join(folder, 'screenshots/1.png'), png);
  return {folder, definition, store};
}
function commit(dir, msg='head') { git(dir,'add','-A'); git(dir,'commit','-qm',msg); return git(dir,'rev-parse','HEAD'); }
function runCheck(dir, base, author='alice', head='HEAD') {
  return spawnSync(process.execPath,[check,'--base',base,'--head',head,'--author',author],{cwd:dir,encoding:'utf8'});
}
function allCheck(dir) { return spawnSync(process.execPath,[check,'--all'],{cwd:dir,encoding:'utf8'}); }
function expectBad(result, pattern) { assert.notEqual(result.status,0, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, pattern); }

test('정상 새 앱과 --head 및 --all 검사', t => {
  const dir=setup(t), base=git(dir,'rev-parse','HEAD'); app(dir); const head=commit(dir);
  const result=runCheck(dir,base,'alice',head); assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(allCheck(dir).status,0);
});

test('규칙 1: 허용 밖 파일과 비소유자의 도구 변경', t => {
  const dir=setup(t), base=git(dir,'rev-parse','HEAD'); app(dir); writeFileSync(join(dir,'apps/hello/other.txt'),'x'); writeFileSync(join(dir,'README.md'),'changed'); commit(dir);
  expectBad(runCheck(dir,base), /허용|변경/);
});

test('규칙 2: 앱 크기, 스키마, id, 기본 앱', async t => {
  for (const kind of ['schema','id','builtin','size']) await t.test(kind, t => {
    const dir=setup(t), base=git(dir,'rev-parse','HEAD'); const id=kind==='builtin'?'calculator':'hello'; const a=app(dir,id);
    if(kind==='schema') {delete a.definition.ui; json(join(a.folder,'app.json'),a.definition);}
    if(kind==='id') {a.definition.id='other'; json(join(a.folder,'app.json'),a.definition);}
    if(kind==='size') writeFileSync(join(a.folder,'app.json'), ' '.repeat(1024*1024+1));
    commit(dir); expectBad(runCheck(dir,base), /앱|스키마|id|크기/);
  });
});

test('규칙 3: 메타 필드, 남의 앱과 게시자 변경, 소유자 관리자 권한 및 삭제', async t => {
  for(const kind of ['field','new-author','other','publisher','admin','delete']) await t.test(kind,t=>{
    const dir=setup(t); let base=git(dir,'rev-parse','HEAD');
    if(kind==='field'||kind==='new-author') {const a=app(dir); if(kind==='field'){a.store.summary='';json(join(a.folder,'store.json'),a.store);} commit(dir); expectBad(runCheck(dir,base,kind==='new-author'?'bob':'alice'),/게시자|summary|형식/); return;}
    const a=app(dir); commit(dir,'app'); base=git(dir,'rev-parse','HEAD');
    if(kind==='delete') rmSync(a.folder,{recursive:true}); else {a.store.release=2; a.store.summary='바뀜'; if(kind==='publisher') a.store.publisher='bob'; json(join(a.folder,'store.json'),a.store);}
    commit(dir); const r=runCheck(dir,base,kind==='admin'?'eiaserinnys':'bob');
    if(kind==='admin') assert.equal(r.status,0,r.stdout+r.stderr); else expectBad(r,/게시자|수정|삭제/);
  });
});

test('규칙 4: 자산 짝, 파일, 총 크기', async t => {
  for(const kind of ['set','missing','size']) await t.test(kind,t=>{const dir=setup(t),base=git(dir,'rev-parse','HEAD'),a=app(dir);
    if(kind==='set'){a.store.assets[0].version=2;json(join(a.folder,'store.json'),a.store);}
    if(kind==='missing')rmSync(join(a.folder,'assets/icon.svg'));
    if(kind==='size')writeFileSync(join(a.folder,'assets/icon.svg'),Buffer.alloc(10*1024*1024+1));
    commit(dir);expectBad(runCheck(dir,base),/자산|크기/);
  });
});

test('규칙 5: 스크린샷 형식과 크기', async t => {
  for(const kind of ['magic','size','name','duplicate']) await t.test(kind,t=>{const dir=setup(t),base=git(dir,'rev-parse','HEAD'),a=app(dir);
    if(kind==='magic')writeFileSync(join(a.folder,'screenshots/1.png'),'fake');
    if(kind==='size')writeFileSync(join(a.folder,'screenshots/1.png'),Buffer.alloc(2*1024*1024+1));
    if(kind==='name')writeFileSync(join(a.folder,'screenshots/6.png'),png);
    if(kind==='duplicate')writeFileSync(join(a.folder,'screenshots/1.webp'),Buffer.from('524946460000000057454250','hex'));
    commit(dir);expectBad(runCheck(dir,base),/스크린샷|허용/);
  });
});

test('규칙 6: 비밀은 가리고 Firebase 공개 키는 허용', t=>{
  const dir=setup(t),base=git(dir,'rev-parse','HEAD'),a=app(dir); a.store.description='sk-'+'A'.repeat(24); json(join(a.folder,'store.json'),a.store);commit(dir);
  const r=runCheck(dir,base);expectBad(r,/비밀/);assert.doesNotMatch(r.stdout+r.stderr,/A{20}/);
});

test('규칙 7: release 증가와 release만 변경 금지',async t=>{
  for(const kind of ['missing','jump','only','valid'])await t.test(kind,t=>{const dir=setup(t),a=app(dir);commit(dir,'app');const base=git(dir,'rev-parse','HEAD');
    if(kind!=='only')a.store.summary='변경'; a.store.release=kind==='missing'?1:kind==='jump'?3:2;json(join(a.folder,'store.json'),a.store);commit(dir);
    const r=runCheck(dir,base); if(kind==='valid')assert.equal(r.status,0,r.stdout+r.stderr); else expectBad(r,/release|판/);
  });
});

test('빌드: 공개 색인, 비공개 상세, 해시 및 선택적인 사이트',t=>{
  const dir=setup(t), a=app(dir,'one'), b=app(dir,'two',{listed:false}); const out=join(dir,'dist');
  let r=spawnSync(process.execPath,[build,'--out',out],{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.equal(existsSync(join(out,'appstore/index.html')),false);
  mkdirSync(join(dir,'site/fixtures'),{recursive:true});writeFileSync(join(dir,'site/index.html'),'사이트');writeFileSync(join(dir,'site/fixtures/hidden'),'fixture');
  r=spawnSync(process.execPath,[build,'--out',out],{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(join(out,'appstore/index.html'),'utf8'),'사이트');assert.equal(existsSync(join(out,'appstore/fixtures')),false);
  const index=JSON.parse(readFileSync(join(out,'appstore/index.json')));assert.deepEqual(index.items.map(x=>x.id),['one']);
  assert.equal(existsSync(join(out,'appstore/apps/two/index.json')),true);
  const manifest=JSON.parse(readFileSync(join(out,'appstore/apps/one/1/manifest.json')));
  for(const [path,meta] of Object.entries(manifest.files)){const bytes=readFileSync(join(out,'appstore',path));assert.equal(meta.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(meta.bytes,bytes.length);}
});

test('업로드 계획: 불변 판 건너뛰기와 내려진 앱 상세 삭제',async t=>{
  const dir=setup(t);app(dir);const out=join(dir,'dist');const r=spawnSync(process.execPath,[build,'--out',out],{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const mod=await import(pathToFileURL(upload));const old=JSON.parse(readFileSync(join(out,'appstore/apps/hello/1/manifest.json')));
  const plan=await mod.planUpload(out,{list:async()=>['appstore/apps/hello/1/manifest.json','appstore/apps/gone/index.json'],get:async key=> key.includes('/hello/')?old:null});
  assert.match(plan.join('\n'),/건너|skip/i);assert.match(plan.join('\n'),/gone\/index.json/);
  const changed=structuredClone(old);changed.files[Object.keys(changed.files)[0]].sha256='0'.repeat(64);
  await assert.rejects(mod.planUpload(out,{list:async()=>['appstore/apps/hello/1/manifest.json'],get:async()=>changed}),/sha256/);
  await assert.rejects(mod.planUpload(out,{list:async()=>['appstore/apps/hello/2/manifest.json'],get:async()=>old}),/더 높은 판/);
  const dry=spawnSync(process.execPath,[upload,'--dist',out,'--dry-run'],{cwd:dir,encoding:'utf8'});assert.equal(dry.status,0,dry.stderr);
});

test('base 검사 코드 선택과 초기화 예외',async t=>{
  const dir=setup(t);mkdirSync(join(dir,'tools'),{recursive:true});mkdirSync(join(dir,'schema'),{recursive:true});writeFileSync(join(dir,'tools/check.mjs'),'base');writeFileSync(join(dir,'schema/schema.json'),'base-schema');writeFileSync(join(dir,'package.json'),'{}');writeFileSync(join(dir,'package-lock.json'),'{}');commit(dir,'tools');const base=git(dir,'rev-parse','HEAD');
  writeFileSync(join(dir,'tools/check.mjs'),'head');commit(dir,'change');
  const mod=await import(pathToFileURL(join(root,'tools/trusted-check.mjs')));
  const selected=mod.selectChecker(dir,base,'HEAD');assert.equal(selected.ref,base);assert.equal(selected.bootstrap,false);
  const extracted=join(dir,'extracted');mod.extractChecker(dir,base,'HEAD',extracted);assert.equal(readFileSync(join(extracted,'tools/check.mjs'),'utf8'),'base');
  const initial=git(dir,'rev-list','--max-parents=0','HEAD');assert.deepEqual(mod.selectChecker(dir,initial,'HEAD'),{ref:'HEAD',bootstrap:true});
  const bootstrap=join(dir,'bootstrap');mod.extractChecker(dir,initial,'HEAD',bootstrap);assert.equal(readFileSync(join(bootstrap,'tools/check.mjs'),'utf8'),'head');
});

test('PR이 검사 코드를 고쳐도 base 검사로 남의 앱 변경을 거부한다',async t=>{
  const dir=setup(t), a=app(dir);mkdirSync(join(dir,'tools'),{recursive:true});mkdirSync(join(dir,'schema'),{recursive:true});
  for(const file of ['check.mjs','builtin-ids.json'])cpSync(join(root,'tools',file),join(dir,'tools',file));
  cpSync(join(root,'schema/app-definition.schema.json'),join(dir,'schema/app-definition.schema.json'));
  cpSync(join(root,'package.json'),join(dir,'package.json'));cpSync(join(root,'package-lock.json'),join(dir,'package-lock.json'));
  commit(dir,'trusted base');const base=git(dir,'rev-parse','HEAD');
  a.store.summary='남의 앱 변경';a.store.release=2;json(join(a.folder,'store.json'),a.store);writeFileSync(join(dir,'tools/check.mjs'),'process.exit(0)');commit(dir,'untrusted head');
  const mod=await import(pathToFileURL(join(root,'tools/trusted-check.mjs')));const selected=join(dir,'selected');mod.extractChecker(dir,base,'HEAD',selected);symlinkSync(join(root,'node_modules'),join(selected,'node_modules'),'dir');
  const r=spawnSync(process.execPath,[join(selected,'tools/check.mjs'),'--base',base,'--head','HEAD','--author','bob'],{cwd:dir,encoding:'utf8'});
  expectBad(r,/게시자|수정/);
});
