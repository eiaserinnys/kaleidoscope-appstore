import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectChecker(repo,base,head){
 const result=spawnSync('git',['cat-file','-e',`${base}:tools/check.mjs`],{cwd:repo,stdio:'ignore'});
 return result.status===0?{ref:base,bootstrap:false}:{ref:head,bootstrap:true};
}
export function extractChecker(repo,base,head,destination){
 const selected=selectChecker(repo,base,head);mkdirSync(destination,{recursive:true});
 const archive=execFileSync('git',['archive',selected.ref,'tools','schema','package.json','package-lock.json'],{cwd:repo,maxBuffer:30*1024*1024});
 execFileSync('tar',['-x','-C',destination],{input:archive});return selected;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [base,head,destination]=process.argv.slice(2);const selected=extractChecker(process.cwd(),base,head,destination);if(selected.bootstrap){const message='초기화 PR: main에 검사 코드가 없어 이 PR의 검사 코드로 검사했습니다';console.log(message);if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,message+'\n');}else console.log('main의 검사 코드로 검사합니다');}catch(e){console.error(`검사 코드 준비 실패: ${e.message}`);process.exitCode=1;}
}
