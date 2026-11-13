/** Real compiled cliUpdate with an owned launcher, offline registry and no-op dsh. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmodSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {delimiter,dirname,join,resolve,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

const repo=realpathSync(fileURLToPath(new URL('..',import.meta.url)))
const name='@deepseek-harness-tui/dsh-tui'
const version=JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version

if(process.argv[2]==='--child'){
 const [mode,root]=process.argv.slice(3)
 const profile=join(root,'profile',...name.split('/'))
 const prefix=join(root,mode,'npm-prefix')
 const target=join(prefix,...(process.platform==='win32'?[]:['lib']),'node_modules',...name.split('/'))
 const old=mode==='ahead'?'99.0.0':'0.16.1'
 mkdirSync(join(target,'bin'),{recursive:true})
 const originalBin=Buffer.from('#!/usr/bin/env node\n// old launcher fixture\n')
 writeFileSync(join(target,'package.json'),JSON.stringify({name,version:old,bin:{'dsh-tui':'bin/dsh-tui.js'}}))
 writeFileSync(join(target,'bin','dsh-tui.js'),originalBin,{mode:0o755})
 if(mode!=='unproven'){
  if(process.platform==='win32')writeFileSync(join(prefix,'dsh-tui.cmd'),`@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/node_modules/${name}/bin/dsh-tui.js" %*\r\n`)
  else{mkdirSync(join(prefix,'bin'),{recursive:true});symlinkSync(join('..','lib','node_modules',...name.split('/'),'bin','dsh-tui.js'),join(prefix,'bin','dsh-tui'))}
 }
 if(mode==='unproven')writeFileSync(join(root,mode,'npm-prefix','package.json'),JSON.stringify({name:'fixture-project',private:true}))
 const bin=join(root,mode,'stub-bin');mkdirSync(bin,{recursive:true})
 const calls=join(bin,'calls.jsonl')
 const stub=`import {appendFileSync} from 'node:fs';import {basename,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';const file=fileURLToPath(import.meta.url);const tool=basename(file,'.mjs');const args=process.argv.slice(2);appendFileSync(join(dirname(file),'calls.jsonl'),JSON.stringify({tool,args})+'\\n');if(tool!=='dsh')process.exit(97);if(args.includes('--version'))console.log('0.2.2-rc.2');`
 for(const tool of ['dsh','npm','pnpm']){
  writeFileSync(join(bin,tool+'.mjs'),stub)
  if(process.platform==='win32')writeFileSync(join(bin,tool+'.cmd'),`@echo off\r\n"${process.execPath}" "${join(bin,tool+'.mjs')}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
  else{writeFileSync(join(bin,tool),'#!/usr/bin/env node\n'+stub);chmodSync(join(bin,tool),0o755)}
 }
 for(const key of ['DSH_TUI_LAUNCHER_PATH','DSH_TUI_LAUNCHER_VERSION','DSH_TUI_LAUNCHER_ABSENT','DSH_TUI_UPDATE_LAUNCHER','DSH_TUI_STANDALONE','DSH_TUI_STANDALONE_BINARY'])delete process.env[key]
 process.env.DSH_TUI_UPDATE_ENGINE='0'
 process.env.DSH_HOME=join(root,mode,'dsh-home')
 process.env.NPM_CONFIG_REGISTRY='https://fixture.invalid'
 process.env.PATH=bin+delimiter+dirname(process.execPath)+delimiter+(process.env.PATH??'')
 if(mode==='absent')process.env.DSH_TUI_LAUNCHER_ABSENT='1'
 else if(mode==='fallback-argv')process.argv[1]=join(target,'bin','dsh-tui.js')
 else{
  process.env.DSH_TUI_LAUNCHER_PATH=join(target,'bin','dsh-tui.js')
  process.env.DSH_TUI_LAUNCHER_VERSION=old
 }
 if(mode==='disabled')process.env.DSH_TUI_UPDATE_LAUNCHER='0'
 const urls=[]
 globalThis.fetch=async url=>{
  const value=String(url);urls.push(value)
  if(mode!=='latest')throw Error('fixture offline')
  if(value.includes('@deepseek-harness-tui/dsh-tui'))return Response.json({version,peerDependencies:{'@deepseek-ai/dsh-agent':'0.2.2-rc.2'}})
  if(value.includes('@deepseek-ai/dsh'))return Response.json({versions:{'0.2.2-rc.2':{}}})
  throw Error('unexpected fixture URL '+value)
 }
 const update=await import(pathToFileURL(join(profile,'lib','types','update.js')).href)
 const plan=await update.resolveUpdatePlan()
 const stdout=process.stdout.write.bind(process.stdout);const stderr=process.stderr.write.bind(process.stderr)
 let out='',err='',code
 process.stdout.write=chunk=>{out+=String(chunk);return true}
 process.stderr.write=chunk=>{err+=String(chunk);return true}
 try{code=await update.cliUpdate('fixture-profile')}finally{process.stdout.write=stdout;process.stderr.write=stderr}
 const after=JSON.parse(readFileSync(join(target,'package.json'),'utf8'))
 const repaired=mode==='latest'||mode==='fallback'||mode==='fallback-argv'
 const called=existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
 console.log(JSON.stringify({mode,code,tui:plan.tui.kind,launcher:plan.launcher.kind,launcherReason:plan.launcher.reason,sourceVersion:version,targetBefore:old,targetAfter:after.version,stdout:out,stderr:err,calls:called,urls}))
 assert.equal(code,0,'the owned CLI update succeeds')
 assert.equal(after.version,repaired?version:old,'launcher alignment follows the proven plan, including a no-op fallback')
 assert.equal(readFileSync(join(target,'bin','dsh-tui.js')).equals(repaired?readFileSync(join(profile,'bin','dsh-tui.js')):originalBin),true,'the actual launcher bytes are repaired or preserved')
 assert.equal(called.some(call=>call.tool!=='dsh'),false,'no real or fake npm/pnpm installer runs')
 assert.equal(called.filter(call=>call.args.includes('--latest')).length,mode==='latest'?0:1,'only the unknown TUI uses the no-op --latest installer')
 if(mode!=='latest')assert.ok(out.includes('version did not advance'),'a no-op fallback remains reported truthfully')
}else{
 const local=join(repo,'.local');mkdirSync(local,{recursive:true})
 const root=realpathSync(mkdtempSync(join(local,'verify-cli-launcher-repair-')))
 try{
  const profile=join(root,'profile',...name.split('/'))
  mkdirSync(profile,{recursive:true})
  cpSync(join(repo,'lib','types'),join(profile,'lib','types'),{recursive:true,dereference:true})
  cpSync(join(repo,'package.json'),join(profile,'package.json'))
  mkdirSync(join(profile,'bin'),{recursive:true});cpSync(join(repo,'bin','dsh-tui.js'),join(profile,'bin','dsh-tui.js'))
  mkdirSync(join(profile,'assets'),{recursive:true})
  for(const file of ['windows-installer.ps1','windows-installer.cs'])cpSync(join(repo,'assets',file),join(profile,'assets',file))
  let failures=0
  for(const mode of ['latest','fallback','fallback-argv','disabled','ahead','absent','unproven']){
   const env={...process.env};delete env.Path;env.PATH=process.env.PATH??process.env.Path??''
   const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child',mode,root],{env,encoding:'utf8',windowsHide:true})
   process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'')
   if(result.error||result.status!==0){failures+=1;console.error(`FAIL ${mode}: ${result.error??result.status}`)}else console.log(`PASS ${mode}`)
  }
  console.log(`verify-cli-launcher-repair: ${7-failures}/7 scenarios passed`)
  process.exitCode=failures===0?0:1
 }finally{
  const parent=realpathSync(local)
  assert.ok(resolve(root).startsWith(parent+sep)&&dirname(root)===parent&&root.includes('verify-cli-launcher-repair-'),'cleanup stays in the freshly owned fixture directory')
  rmSync(root,{recursive:true,force:true})
 }
}
