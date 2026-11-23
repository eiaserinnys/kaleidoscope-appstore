import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'tools/upgrade-check.mjs');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-check-test-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'test@example.com'); git(dir, 'config', 'user.name', 'Test');
  mkdirSync(join(dir, 'apps/demo/assets'), {recursive:true});
  writeFileSync(join(dir, 'apps/demo/assets/example.txt'), 'base bytes');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'apps/demo/assets/example.txt'), 'head bytes');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'head');
  const bin = join(dir, 'bin'), temp = join(dir, 'temp'), kaleidoscope = join(dir, 'kaleidoscope');
  for (const path of [bin, temp, kaleidoscope]) mkdirSync(path);
  writeFileSync(join(bin, 'cargo'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const base = args[args.indexOf('--base') + 1], head = args[args.indexOf('--head') + 1];
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({args, base, head, old:fs.readFileSync(path.join(base, 'demo/assets/example.txt'), 'utf8'), current:fs.readFileSync(path.join(head, 'demo/assets/example.txt'), 'utf8')}));
console.log('판정 도구 stdout'); console.error('판정 도구 stderr');
process.exit(Number(process.env.CARGO_EXIT));
`);
  chmodSync(join(bin, 'cargo'), 0o755);
  return {dir, base, bin, temp, kaleidoscope, capture:join(dir, 'capture.json')};
}

function run(fixture, args, code=0) {
  return spawnSync(process.execPath, [script, ...args], {cwd:fixture.dir, encoding:'utf8',
    env:{...process.env, PATH:`${fixture.bin}:${process.env.PATH}`, TMPDIR:fixture.temp, CAPTURE:fixture.capture, CARGO_EXIT:String(code)}});
}

test('각 ref의 앱을 판정 도구에 전달하고 출력과 종료 코드를 보존하며 임시 파일을 지운다', async t => {
  for (const code of [0, 1, 2]) await t.test(`종료 ${code}`, t => {
    const f=setup(t), r=run(f, ['--kaleidoscope',f.kaleidoscope,'--base',f.base,'--head','HEAD'],code);
    assert.equal(r.status,code,r.stderr); assert.match(r.stdout,/판정 도구 stdout/); assert.match(r.stderr,/판정 도구 stderr/);
    const capture=JSON.parse(readFileSync(f.capture));
    assert.equal(capture.old,'base bytes'); assert.equal(capture.current,'head bytes');
    assert.deepEqual(capture.args.slice(0,8), ['run','-q','--locked','--manifest-path',join(f.kaleidoscope,'Cargo.toml'),'-p','kaleidoscope-contract','--example']);
    assert.deepEqual(capture.args.slice(8,10), ['app_upgrade_check','--']);
    assert.equal(existsSync(dirname(capture.base)),false); assert.equal(existsSync(dirname(capture.head)),false);
    assert.deepEqual(readdirSync(f.temp),[]);
  });
});

test('잘못된 인자와 없는 ref는 입력 오류 2로 끝난다', t => {
  const f=setup(t);
  for (const args of [[], ['--kaleidoscope',f.kaleidoscope,'--base',f.base], ['--kaleidoscope',f.kaleidoscope,'--base','no-such-ref','--head','HEAD']]) {
    const r=run(f,args); assert.equal(r.status,2,r.stderr); assert.equal(existsSync(f.capture),false);
    assert.deepEqual(readdirSync(f.temp),[]);
  }
});

test('업데이트 검사 준비는 base 코드를 우선하고 없을 때만 PR 코드와 안내를 쓴다', async t => {
  for (const present of [true,false]) await t.test(present?'base 있음':'초기 도입',t=>{
    const f=setup(t), tools=join(f.dir,'tools'); mkdirSync(tools);
    if (present) writeFileSync(join(tools,'upgrade-check.mjs'),'신뢰 base');
    git(f.dir,'add','.'); git(f.dir,'commit','-qm','base tools'); const base=git(f.dir,'rev-parse','HEAD');
    writeFileSync(join(tools,'upgrade-check.mjs'),'PR 코드'); git(f.dir,'add','.'); git(f.dir,'commit','-qm','PR');
    const selected=join(f.temp,'store-check/tools'); mkdirSync(selected,{recursive:true});
    if (present) writeFileSync(join(selected,'upgrade-check.mjs'),'신뢰 base');
    const workflow=readFileSync(join(root,'.github/workflows/check.yml'),'utf8');
    const block=/      - name: 업데이트 검사 코드 준비\n[\s\S]*?        run: \|\n((?:          .*\n)+)/.exec(workflow);
    assert.ok(block,'업데이트 검사 준비 단계가 필요합니다');
    const command=block[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
    const summary=join(f.temp,'summary');
    const r=spawnSync('bash',['-e','-o','pipefail','-c',command],{cwd:f.dir,encoding:'utf8',env:{...process.env,RUNNER_TEMP:f.temp,HEAD_SHA:'HEAD',BASE_SHA:base,GITHUB_STEP_SUMMARY:summary}});
    assert.equal(r.status,0,r.stderr); assert.equal(readFileSync(join(selected,'upgrade-check.mjs'),'utf8'),present?'신뢰 base':'PR 코드');
    if(present) assert.equal(existsSync(summary),false);
    else assert.match(readFileSync(summary,'utf8'),/초기화 PR.*업데이트 검사/);
  });
});
