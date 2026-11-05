import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
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
function allCheck(dir, keys=[]) {
  const bin=join(dir,'fake-bin');mkdirSync(bin,{recursive:true});const aws=join(bin,'aws');writeFileSync(aws,'#!/usr/bin/env node\nprocess.stdout.write(process.env.STORE_TEST_KEYS);\n');chmodSync(aws,0o755);
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,R2_ACCOUNT_ID:'test',R2_BUCKET:'test',AWS_ACCESS_KEY_ID:'test',AWS_SECRET_ACCESS_KEY:'test',STORE_TEST_KEYS:JSON.stringify({Contents:keys.map(Key=>({Key}))})};
  return spawnSync(process.execPath,[check,'--all'],{cwd:dir,encoding:'utf8',env});
}
function expectBad(result, pattern) { assert.notEqual(result.status,0, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, pattern); }
const oauth = {name:'fixture',kind:'oauth',base_url:'https://example.com',resource:'https://example.com/mcp',paths:['/api/'],writable:false,description:'시험'};
test('연결 권한과 OAuth 정의는 일치해야 하며 매니페스트에 실린다', async t => {
  for (const kind of ['valid','missing','extra','relay','headers','name','url','path']) await t.test(kind,t=>{
    const dir=setup(t),base=git(dir,'rev-parse','HEAD'),a=app(dir);
    a.definition.requires.modules.connection=1;
    a.definition.permissions=[{module:'connection',id:'api',connection:'fixture',access:'read',label:'연결'}];
    a.store.connections=[structuredClone(oauth)];
    if(kind==='missing')delete a.store.connections;
    if(kind==='extra')a.store.connections[0].name='other';
    if(kind==='relay')a.store.connections[0].kind='relay';
    if(kind==='headers')a.store.connections[0].headers={Authorization:'secret'};
    if(kind==='name')a.store.connections[0].name='Bad_Name';
    if(kind==='url')a.store.connections[0].base_url='https://example.com/?key=secret';
    if(kind==='path')a.store.connections[0].paths=['/../private'];
    json(join(a.folder,'app.json'),a.definition);json(join(a.folder,'store.json'),a.store);commit(dir);
    const result=runCheck(dir,base);
    if(kind==='valid'){
      assert.equal(result.status,0,result.stdout+result.stderr);
      const out=join(dir,'dist');const built=spawnSync(process.execPath,[build,'--out',out],{cwd:dir,encoding:'utf8'});assert.equal(built.status,0,built.stderr);
      const manifest=JSON.parse(readFileSync(join(out,'appstore/apps/hello/1/manifest.json')));
      assert.deepEqual(manifest.connections,[oauth]);
    } else expectBad(result,/연결|형식/);
  });
});
function prepareWorkflow(dir,base,head,destination,eventBase=base){
  const workflow=readFileSync(join(root,'.github/workflows/check.yml'),'utf8');
  const block=/      - name: base 검사 코드 준비\n[\s\S]*?        run: \|\n((?:          .*\n)+)/.exec(workflow);
  assert.ok(block,'워크플로의 준비 run 블록이 필요합니다');
  const command=block[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
  mkdirSync(destination,{recursive:true});const summary=join(destination,'summary');git(dir,'update-ref','refs/remotes/origin/main',base);
  const result=spawnSync('bash',['-e','-o','pipefail','-c',command],{cwd:dir,encoding:'utf8',env:{...process.env,BASE_REF:'main',BASE_SHA:eventBase,HEAD_SHA:head,RUNNER_TEMP:destination,GITHUB_STEP_SUMMARY:summary}});
  assert.equal(result.status,0,result.stderr);return {result,summary,selected:join(destination,'store-check')};
}

test('정상 새 앱과 --head 및 --all 검사', t => {
  const dir=setup(t), base=git(dir,'rev-parse','HEAD'); app(dir); const head=commit(dir);
  const result=runCheck(dir,base,'alice',head); assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(allCheck(dir).status,0);
});

test('프로그램 선언은 스키마를 통과하고 검사 요약 배지에 표시된다', t => {
  const dir=setup(t), base=git(dir,'rev-parse','HEAD');
  for (const [id, commands] of [['one',['ffmpeg']],['many',['ffmpeg','python3']],['legacy',[null,undefined]]]) {
    const a=app(dir,id); a.definition.name=id; a.definition.requires.modules.process=id==='legacy'?1:2;
    a.definition.permissions=commands.map((command,index)=>({module:'process',id:`run-${index}`,label:'실행',...(command===undefined?{}:{command})}));
    json(join(a.folder,'app.json'),a.definition);
  }
  const head=commit(dir), summary=join(dir,'summary');
  const result=spawnSync(process.execPath,[check,'--base',base,'--head',head,'--author','alice'],{cwd:dir,encoding:'utf8',env:{...process.env,GITHUB_STEP_SUMMARY:summary}});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const text=readFileSync(summary,'utf8');
  assert.match(text,/\| one \|.*\| process\(ffmpeg\) \|/);
  assert.match(text,/\| many \|.*\| process\(ffmpeg, python3\) \|/);
  assert.match(text,/\| legacy \|.*\| process \|/);
});

test('큰 블록 트리의 앱 정의를 수 초 안에 검사한다', t => {
  const dir=setup(t), base=git(dir,'rev-parse','HEAD'), a=app(dir);
  const leaf=()=>structuredClone(template.ui.children[0]);
  const stack=children=>({type:'stack',direction:'column',children});
  a.definition.ui=stack(Array.from({length:8},()=>
    stack(Array.from({length:8},()=>stack(Array.from({length:8},leaf))))));
  for(let i=0;i<6;i++)a.definition.ui={type:'when',child:a.definition.ui};
  json(join(a.folder,'app.json'),a.definition); commit(dir);
  const result=spawnSync(process.execPath,[check,'--base',base,'--head','HEAD','--author','alice'],{cwd:dir,encoding:'utf8',timeout:8000});
  assert.equal(result.error,undefined,`8초 안에 검사가 끝나지 않았습니다: ${result.error}`);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/검사 통과: 앱 1개/);
});

test('오래된 PR에서는 main에 나중에 추가된 다른 앱을 변경으로 보지 않는다',t=>{
  const dir=setup(t),fork=git(dir,'rev-parse','HEAD');git(dir,'checkout','-qb','pr',fork);app(dir,'hello');const head=commit(dir,'PR 앱');
  git(dir,'checkout','-qb','upstream',fork);app(dir,'other',{publisher:'bob'});const base=commit(dir,'다른 앱 추가');
  const result=runCheck(dir,base,'alice',head);assert.equal(result.status,0,result.stdout+result.stderr);
});

test('--all은 빌드 전에 R2에 있는 더 높은 판을 거부한다',t=>{
  const dir=setup(t);app(dir);commit(dir);expectBad(allCheck(dir,['appstore/apps/hello/2/manifest.json']),/더 높은 판/);
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
    commit(dir); expectBad(runCheck(dir,base), kind==='schema'?/앱 스키마가 맞지 않습니다:/ : /앱|스키마|id|크기/);
  });
});

test('규칙 3: 메타 필드, 남의 앱과 게시자 변경, 소유자 관리자 권한 및 삭제', async t => {
  for(const kind of ['field','new-author','other','publisher','admin','delete']) await t.test(kind,t=>{
    const dir=setup(t); let base=git(dir,'rev-parse','HEAD');
    if(kind==='field'||kind==='new-author') {const a=app(dir); if(kind==='field'){a.store.summary='';a.store.category='';json(join(a.folder,'store.json'),a.store);} commit(dir); const r=runCheck(dir,base,kind==='new-author'?'bob':'alice');expectBad(r,/게시자|summary|형식/);if(kind==='field'){assert.match(r.stderr,/summary/);assert.match(r.stderr,/category/);}return;}
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

test('앱 아이콘과 스토어 아이콘은 같은 이미지 자산을 가리킨다',async t=>{
  for(const kind of ['valid','different','format','blocks'])await t.test(kind,t=>{
    const dir=setup(t),base=git(dir,'rev-parse','HEAD'),a=app(dir);
    a.definition.icon={asset:'icon',version:1};a.definition.requires.blocks=kind==='blocks'?25:26;
    if(kind==='different'){
      a.definition.assets.push({id:'other',version:1});a.store.assets.push({id:'other',version:1,file:'assets/other.svg',format:'svg',source:'직접 제작',license:'MIT'});
      a.store.icon='assets/other.svg';writeFileSync(join(a.folder,'assets/other.svg'),'<svg/>');
    }
    if(kind==='format')a.store.assets[0].format='gif';
    json(join(a.folder,'app.json'),a.definition);json(join(a.folder,'store.json'),a.store);commit(dir);
    const result=runCheck(dir,base);
    if(kind==='valid')assert.equal(result.status,0,result.stdout+result.stderr);
    else if(kind==='different')expectBad(result,/app\.json의 아이콘과 store\.json의 icon/);
    else if(kind==='format')expectBad(result,/아이콘.*형식/);
    else expectBad(result,/아이콘.*blocks 26/);
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

test('스키마 오류 경로에 있는 비밀값을 출력에서 가린다',t=>{
  const dir=setup(t),base=git(dir,'rev-parse','HEAD'),a=app(dir);const token='sk-'+'A'.repeat(24);
  a.definition.sources={[token]:{bad:true}};json(join(a.folder,'app.json'),a.definition);commit(dir);
  const r=runCheck(dir,base);assert.equal(r.status,1);assert.equal(r.stderr.includes(token),false);assert.ok(r.stderr.includes('sk-A…'));
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
  const output=[];await mod.runUpload(out,{list:async()=>['appstore/apps/hello/1/manifest.json','appstore/apps/gone/index.json'],get:async()=>old,put:()=>assert.fail('dry-run upload'),remove:()=>assert.fail('dry-run delete')},{dryRun:true,log:line=>output.push(line)});
  assert.match(output.join('\n'),/건너/);assert.match(output.join('\n'),/삭제 appstore\/apps\/gone\/index.json/);
  const changed=structuredClone(old);changed.files[Object.keys(changed.files)[0]].sha256='0'.repeat(64);
  await assert.rejects(mod.planUpload(out,{list:async()=>['appstore/apps/hello/1/manifest.json'],get:async()=>changed}),/sha256/);
  await assert.rejects(mod.planUpload(out,{list:async()=>['appstore/apps/hello/2/manifest.json'],get:async()=>old}),/더 높은 판/);
  const dry=spawnSync(process.execPath,[upload,'--dist',out,'--dry-run'],{cwd:dir,encoding:'utf8'});assert.equal(dry.status,0,dry.stderr);
});

test('워크플로 준비 단계는 base 검사 코드를 고르고 초기화 때 head를 쓴다',t=>{
  const dir=setup(t);mkdirSync(join(dir,'tools'),{recursive:true});mkdirSync(join(dir,'schema'),{recursive:true});writeFileSync(join(dir,'tools/check.mjs'),'base');writeFileSync(join(dir,'schema/schema.json'),'base-schema');writeFileSync(join(dir,'package.json'),'{}');writeFileSync(join(dir,'package-lock.json'),'{}');commit(dir,'tools');const base=git(dir,'rev-parse','HEAD');
  writeFileSync(join(dir,'tools/check.mjs'),'head');writeFileSync(join(dir,'tools/other.mjs'),'변조');commit(dir,'change');
  const selected=prepareWorkflow(dir,base,'HEAD',join(dir,'runner-base'));assert.equal(readFileSync(join(selected.selected,'tools/check.mjs'),'utf8'),'base');
  const initial=git(dir,'rev-list','--max-parents=0','HEAD');const bootstrap=prepareWorkflow(dir,initial,'HEAD',join(dir,'runner-head'));
  assert.equal(readFileSync(join(bootstrap.selected,'tools/check.mjs'),'utf8'),'head');const notice='초기화 PR: main에 검사 코드가 없어 이 PR의 검사 코드로 검사했습니다';
  assert.ok(bootstrap.result.stdout.includes(notice));assert.ok(readFileSync(bootstrap.summary,'utf8').includes(notice));
});

test('오래된 이벤트 base 대신 현재 base 브랜치 끝에서 검사 코드를 꺼낸다',t=>{
  const dir=setup(t),fork=git(dir,'rev-parse','HEAD');git(dir,'checkout','-qb','pr',fork);writeFileSync(join(dir,'contribution.txt'),'PR');const head=commit(dir,'PR');
  git(dir,'checkout','-qb','upstream',fork);mkdirSync(join(dir,'tools'),{recursive:true});mkdirSync(join(dir,'schema'),{recursive:true});
  writeFileSync(join(dir,'tools/check.mjs'),'현재 main 검사');writeFileSync(join(dir,'schema/schema.json'),'schema');writeFileSync(join(dir,'package.json'),'{}');writeFileSync(join(dir,'package-lock.json'),'{}');const tip=commit(dir,'검사 추가');
  const selected=prepareWorkflow(dir,tip,head,join(dir,'runner'),fork);
  assert.equal(readFileSync(join(selected.selected,'tools/check.mjs'),'utf8'),'현재 main 검사');assert.equal(selected.result.stdout.includes('초기화 PR'),false);
});

test('PR이 검사 코드를 고쳐도 base 검사로 남의 앱 변경을 거부한다',async t=>{
  const dir=setup(t), a=app(dir);mkdirSync(join(dir,'tools'),{recursive:true});mkdirSync(join(dir,'schema'),{recursive:true});
  for(const file of ['check.mjs','builtin-ids.json'])cpSync(join(root,'tools',file),join(dir,'tools',file));
  cpSync(join(root,'schema/app-definition.schema.json'),join(dir,'schema/app-definition.schema.json'));
  cpSync(join(root,'package.json'),join(dir,'package.json'));cpSync(join(root,'package-lock.json'),join(dir,'package-lock.json'));
  commit(dir,'trusted base');const base=git(dir,'rev-parse','HEAD');
  a.store.summary='남의 앱 변경';a.store.release=2;json(join(a.folder,'store.json'),a.store);writeFileSync(join(dir,'tools/check.mjs'),'process.exit(0)');commit(dir,'untrusted head');
  const selected=prepareWorkflow(dir,base,'HEAD',join(dir,'runner')).selected;symlinkSync(join(root,'node_modules'),join(selected,'node_modules'),'dir');
  const r=spawnSync(process.execPath,[join(selected,'tools/check.mjs'),'--base',base,'--head','HEAD','--author','bob'],{cwd:dir,encoding:'utf8'});
  expectBad(r,/게시자|수정/);
});
