import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if (!['--kaleidoscope', '--base', '--head'].includes(key) || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) {
    console.error('사용법: node tools/upgrade-check.mjs --kaleidoscope <경로> --base <ref> --head <ref>');
    process.exit(2);
  }
  options[key] = args[i + 1];
}
if (Object.keys(options).length !== 3 || options['--base'].startsWith('-') || options['--head'].startsWith('-')) {
  console.error('사용법: node tools/upgrade-check.mjs --kaleidoscope <경로> --base <ref> --head <ref>');
  process.exit(2);
}

let temporary;
try {
  temporary = mkdtempSync(join(tmpdir(), 'appstore-upgrade-'));
  for (const side of ['base', 'head']) {
    const destination = join(temporary, side);
    const archive = join(temporary, `${side}.tar`);
    mkdirSync(destination);
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, options[`--${side}`], '--', 'apps'], {stdio:'inherit'});
    execFileSync('tar', ['-xf', archive, '-C', destination], {stdio:'inherit'});
  }
  const kaleidoscope = resolve(options['--kaleidoscope']);
  const result = spawnSync('cargo', ['run', '-q', '--locked', '--manifest-path', join(kaleidoscope, 'Cargo.toml'),
    '-p', 'kaleidoscope-contract', '--example', 'app_upgrade_check', '--',
    '--base', join(temporary, 'base/apps'), '--head', join(temporary, 'head/apps')],
  {cwd:kaleidoscope, stdio:'inherit'});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
} catch (error) {
  console.error(`업데이트 검사를 실행할 수 없습니다: ${error.message}`);
  process.exitCode = 2;
} finally {
  if (temporary) rmSync(temporary, {recursive:true, force:true});
}
