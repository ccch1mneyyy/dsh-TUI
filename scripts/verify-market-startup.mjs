/** Actual launcher, controlled pre-composition entry, real managed ledger/update guard.
 * Both launch routes, exact owner adoption, and launcher death; synthetic DSH.
 * Run after compile: node scripts/verify-market-startup.mjs
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, copyFile, writeFile, readFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { materializeRecipe, packageDirectory, runtimeStatus, digest, PACKAGE, PROFILE, RUNTIME_BUNDLE, liveRuntimeProcesses } from '../src/dsh-adapter/market/runtime-profile.mjs'
import { withRuntimeUpdate } from '../src/dsh-adapter/market/prepare.mjs'
import { managedLaunchArgs } from '../src/dsh-adapter/market/launch.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))
const leaseUrl = pathToFileURL(join(source, 'src/dsh-adapter/market/lease.mjs')).href
const scratch = await mkdtemp(join(tmpdir(), 'startup-gap-'))
const put = async (file, data) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data))
}
const waitFor = async (file, child) => {
  const deadline = Date.now() + 15000
  while (!existsSync(file)) {
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`launcher exited before ${file}: ${child.exitCode}/${child.signalCode}`)
    if (Date.now() >= deadline) throw new Error(`private phase receipt deadline: ${file}`)
    await delay(25)
  }
  return JSON.parse(await readFile(file, 'utf8'))
}
const reports = []
assert.equal(managedLaunchArgs(['entry.mjs'], join(scratch, 'unmanaged-source')), undefined, 'source and pre-market launches keep their original command')

try {
for (const mode of ['own-entry', 'dsh-profile', 'own-entry-orphan', 'dsh-profile-orphan']) {
  const slot = join(scratch, mode)
  const home = join(slot, 'private home 中文')
  const dshHome = join(home, '.dsh')
  const dir = join(dshHome, 'profiles/dsh-tui')
  const pkg = packageDirectory(dir)
  const control = join(slot, 'control')
  const bin = join(slot, 'bin')
  const host = join(slot, 'host')
  const version = '0.20.0'
  await mkdir(control, { recursive: true })
  await put(join(host, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.2-rc.2', type: 'module', bin: { dsh: 'cli.mjs' } })
  await put(join(pkg, 'package.json'), { name: PACKAGE, version, type: 'module', main: 'lib/types/index.js', engines: { node: '^22.19 || >=24' }, dshTui: { runtimeBundle: './lib/tui-runtime' } })
  await mkdir(join(pkg, 'bin'), { recursive: true })
  await copyFile(join(source, 'bin/dsh-tui.js'), join(pkg, 'bin/dsh-tui.js'))
  for (const name of ['cli.mjs', 'prepare.mjs', 'runtime-profile.mjs', 'lease.mjs', 'launch.mjs', 'startup.mjs']) {
    const dest = join(pkg, 'src/dsh-adapter/market', name)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(source, 'src/dsh-adapter/market', name), dest)
  }
  await put(join(pkg, 'lib/types/index.js'), '')
  await put(join(pkg, 'lib/types/dsh-adapter/host-dsh.js'), `export { findHostDsh, hostPackageEntry } from ${JSON.stringify(pathToFileURL(join(source, 'lib/types/dsh-adapter/host-dsh.js')).href)}`)
  const controlledEntry = `
    if (!import.meta.main) throw Error('the actual Node main identity was lost')
    import { writeFile, readFile } from 'node:fs/promises'
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    import { setTimeout as delay } from 'node:timers/promises'
    const c = process.env.DSH_TUI_STARTUP_GAP_CONTROL
    const wait = async file => {
      const deadline = Date.now() + 20000
      while (!existsSync(join(c,file))) {
        if (Date.now() > deadline) throw Error('controlled startup deadline: '+file)
        await delay(25)
      }
    }
    await writeFile(join(c,'before-lease.json'), JSON.stringify({pid:process.pid, argv:process.argv, execArgv:process.execArgv}))
    await wait('mount')
    const {apply} = await import(${JSON.stringify(leaseUrl)})
    let dispose
    await apply({get:()=>({dir:${JSON.stringify(dir)},installAnchor:${JSON.stringify(join(host, 'package.json'))}}),
      provide(){},effect: register=>{dispose=register()}})
    await writeFile(join(c,'after-lease.json'),JSON.stringify({pid:process.pid}))
    await wait('exit')
    await dispose()
    await writeFile(join(c,'done.json'), JSON.stringify({pid:process.pid}))
  `
  await put(join(pkg, 'lib/types/dsh-adapter/host-entry.js'), controlledEntry)
  await put(join(host, 'cli.mjs'), `if(process.argv.includes('--version')) { console.log('dsh 0.2.2-rc.2'); process.exit(0) }\n${controlledEntry}`)
  const hostScript = join(host, 'cli.mjs')
  const shim = join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  await put(shim, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${hostScript}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${hostScript}' "$@"\n`)
  if (process.platform !== 'win32') await (await import('node:fs/promises')).chmod(shim, 0o755)
  const patch = '[]\n'
  const bundle = { name: RUNTIME_BUNDLE, version, dependencies: { [PACKAGE]: version }, dsh: { bundle: { patch: './cordis.patch.yml' } }, dshTui: { patchSha256: digest(patch) } }
  await put(join(pkg, 'lib/tui-runtime/cordis.patch.yml'), patch)
  await put(join(pkg, 'lib/tui-runtime/package.json'), bundle)
  const recipe = await materializeRecipe(dir, pkg)
  await cp(recipe, join(dir, 'node_modules', ...RUNTIME_BUNDLE.split('/')), { recursive: true })
  await put(join(dir, 'package.json'), { type:'module', private:true, dependencies: { [PACKAGE]: version, [RUNTIME_BUNDLE]: `file:${recipe}` }, dsh: { profile: { bundles: [RUNTIME_BUNDLE] } } })
  assert.equal(runtimeStatus(dir).ready, true, 'readiness derived from real recipe/files')
  const env = { ...process.env, HOME:home, USERPROFILE:home, DSH_HOME:dshHome,
    DSH_TUI_STARTUP_GAP_CONTROL:control, DSH_TUI_LANG:'en', DSH_TUI_HOST_ENTRY:mode.startsWith('own-entry')?'1':'0' }
  delete env.Path
  env.PATH = [bin, dirname(process.execPath)].join(delimiter)
  for (const key of ['DSH_TUI_NO_DELEGATE','DSH_TUI_LAUNCHER_PATH','DSH_TUI_HOST_ENTRY_PATH','DSH_TUI_RESUME_SESSION','DSH_TUI_WORKSPACE_TARGET']) delete env[key]
  const child = spawn(process.execPath, [join(pkg, 'bin/dsh-tui.js')], { cwd:slot, env, windowsHide:true, stdio:['ignore','inherit','inherit'] })
  const exited = new Promise((resolve,reject) => { child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal})) })
  let report
  try {
    const phase = await waitFor(join(control, 'before-lease.json'), child)
    const before = await liveRuntimeProcesses(dir)
    assert.equal(before.length, 1, 'startup owns a lease before target imports')
    assert.equal(before[0].pid, phase.pid, 'the application owns its actual PID')
    assert.equal(phase.argv[1], mode.startsWith('own-entry') ? join(pkg, 'lib/types/dsh-adapter/host-entry.js') : hostScript)
    assert.ok(!phase.execArgv.some(arg => arg.includes('market/startup.mjs')), 'one-shot preload cannot leak into restart execArgv')
    if (mode.endsWith('-orphan')) {
      assert.notEqual(child.pid, phase.pid, 'terminate only the owned launcher, never the application PID')
      console.log('STARTUP_PARENT_DEATH '+JSON.stringify({mode,launcherPid:child.pid,applicationPid:phase.pid}))
      assert.equal(child.kill('SIGKILL'), true)
      await exited
      let survived = true
      try { process.kill(phase.pid, 0) }
      catch (error) { if (error.code !== 'ESRCH') throw error; survived = false }
      if (!survived) {
        assert.deepEqual(await liveRuntimeProcesses(dir), [], 'no live application remains to protect')
        reports.push({mode,launcherPid:child.pid,applicationPid:phase.pid,survived:false,earlyMutations:0,survivorBranch:'NOT_RUN_APPLICATION_DID_NOT_SURVIVE',end:await exited})
        console.log('STARTUP_GAP_ACTUAL '+JSON.stringify(reports.at(-1)))
        continue
      }
      assert.equal((await liveRuntimeProcesses(dir))[0].pid, phase.pid, 'launcher death does not release application protection')
    }
    let earlyMutations = 0
    await assert.rejects(withRuntimeUpdate(dir, async () => { earlyMutations++ }), /Close the other running TUI/)
    assert.equal(earlyMutations, 0)
    await put(join(control, 'mount'), '')
    const after = await waitFor(join(control, 'after-lease.json'), mode.endsWith('-orphan') ? undefined : child)
    const owners = await liveRuntimeProcesses(dir)
    assert.equal(owners.length,1)
    assert.equal(owners[0].pid,after.pid)
    assert.equal(owners[0].token,before[0].token,'profile row adopts the same owner rather than duplicating it')
    let lateMutations = 0
    await assert.rejects(withRuntimeUpdate(dir,()=>{lateMutations++}), /Close the other running TUI/)
    assert.equal(lateMutations,0)
    report={mode,livePid:phase.pid,beforeLeaseOwners:before.length,earlyMutations,afterLeaseOwners:owners.length,lateMutations,scope:'actual candidate launcher/bootstrap + controlled target; real recipe/lease/update/adoption/parentdeath; synthetic DSH, no official host/renderer proof'}
  } finally { await put(join(control,'mount'),'');await put(join(control,'exit'),'') }
  const end=await exited
  if (!mode.endsWith('-orphan')) assert.deepEqual(end,{code:0,signal:null},'launcher and entry must finish naturally')
  await waitFor(join(control,'done.json'), undefined)
  assert.deepEqual(await liveRuntimeProcesses(dir),[],'lease removed after natural disposal')
  let afterDisposalMutations = 0
  await withRuntimeUpdate(dir, () => { afterDisposalMutations++ })
  assert.equal(afterDisposalMutations, 1, 'adoption leaves no second owner blocking the application update')
  const queryEntry = join(slot, 'query.mjs')
  await put(queryEntry, `
    import assert from 'node:assert/strict'
    import { liveRuntimeProcesses } from ${JSON.stringify(pathToFileURL(join(source, 'src/dsh-adapter/market/runtime-profile.mjs')).href)}
    assert.equal(import.meta.main, true)
    const owners = await liveRuntimeProcesses(${JSON.stringify(dir)})
    assert.equal(owners.length, 1)
    assert.equal(owners[0].pid, process.pid)
    console.log(JSON.stringify({args:process.argv.slice(2),execArgv:process.execArgv}))
  `)
  const query = await promisify(execFile)(process.execPath, ['--trace-warnings', ...managedLaunchArgs([queryEntry, '--', 'space 中文', ''], dir)], {env, timeout:10000, windowsHide:true})
  assert.deepEqual(JSON.parse(query.stdout), {args:['--','space 中文',''],execArgv:['--trace-warnings']}, 'main argv and user Node flags are unchanged; own preload is one-shot')
  assert.deepEqual(await liveRuntimeProcesses(dir), [], 'a query with no profile row exits naturally without retaining a live owner')
  const failedEntry = join(slot, 'failed.mjs')
  await put(failedEntry, `throw new Error('INTENTIONAL_STARTUP_FAILURE')`)
  await assert.rejects(promisify(execFile)(process.execPath, managedLaunchArgs([failedEntry], dir), {env, timeout:10000, windowsHide:true}), error => error.code === 1 && error.stderr.includes('INTENTIONAL_STARTUP_FAILURE'))
  assert.deepEqual(await liveRuntimeProcesses(dir), [], 'a boot failure cannot leave a live startup owner')
  const replacement = join(slot, 'replacement.mjs')
  const receipt = join(control, 'replacement.json')
  await put(replacement, `
    import assert from 'node:assert/strict'
    import { writeFile } from 'node:fs/promises'
    import { liveRuntimeProcesses } from ${JSON.stringify(pathToFileURL(join(source, 'src/dsh-adapter/market/runtime-profile.mjs')).href)}
    assert.equal(import.meta.main, true)
    const owners = await liveRuntimeProcesses(${JSON.stringify(dir)})
    assert.equal(owners.length, 1)
    assert.equal(owners[0].pid, process.pid)
    assert.deepEqual(process.execArgv, ['--trace-warnings'])
    await writeFile(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid,owners:owners.length,args:process.argv.slice(2)}))
  `)
  const driver = join(slot, 'restart-driver.mjs')
  const ownEntry = mode.startsWith('own-entry')
  await put(driver, `
    import { apply } from ${JSON.stringify(leaseUrl)}
    import { restartTui } from ${JSON.stringify(pathToFileURL(join(source, 'lib/types/update.js')).href)}
    let dispose
    await apply({get:()=>({dir:${JSON.stringify(dir)},installAnchor:${JSON.stringify(join(host, 'package.json'))}}),provide(){},effect:register=>{dispose=register()}})
    await dispose()
    const code = await restartTui('', ${JSON.stringify(ownEntry ? {env:{DSH_TUI_HOST_ENTRY_PATH:replacement}} : {dshEntry:replacement})})
    if (code !== 0) throw Error('actual restart failed: '+code)
    console.log('ACTUAL_RESTART_EXIT0')
  `)
  // A DSH invocation's explicit --profile outranks a stale entry-route marker.
  const restartEnv = {...env, DSH_TUI_PROFILE:ownEntry?PROFILE:'dsh-tui-safe', DSH_TUI_HOST_ENTRY_PATH:ownEntry?driver:undefined, DSH_TUI_HOST_ENTRY:ownEntry?'1':'0'}
  const driverArgs = ownEntry ? [driver] : [driver, '--profile', PROFILE, '--', 'space 中文']
  const restarted = await promisify(execFile)(process.execPath, ['--trace-warnings', ...managedLaunchArgs(driverArgs, dir)], {env:restartEnv, timeout:10000, windowsHide:true})
  assert.ok(restarted.stdout.includes('ACTUAL_RESTART_EXIT0'), 'actual compiled restartTui supervised a natural-zero replacement')
  const replacementReceipt = JSON.parse(await readFile(receipt, 'utf8'))
  assert.equal(replacementReceipt.owners, 1)
  assert.deepEqual(replacementReceipt.args, ownEntry ? [] : ['--profile', PROFILE, '--', 'space 中文'])
  assert.deepEqual(await liveRuntimeProcesses(dir), [], 'restart replacement leaves no live owner after natural exit')
  const installedManifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  await put(join(pkg, 'package.json'), {...installedManifest,dshTui:undefined})
  assert.equal(managedLaunchArgs([queryEntry], dir), undefined, 'a backward update to a pre-market release does not replay an obsolete preload')
  await put(join(pkg, 'package.json'), installedManifest)
  report.afterDisposalMutations = afterDisposalMutations
  report.queryAndFailure = 'natural0/natural1; no live owners; argv/Nodeflags preserved'
  report.backwardSelection = 'legacy command retained without preload'
  report.actualRestart = {naturalExit:0,replacementPid:replacementReceipt.pid,ownersBeforeTarget:1,mainAndArgvPreserved:true}
  reports.push({...report,end})
  console.log('STARTUP_GAP_ACTUAL '+JSON.stringify(reports.at(-1)))
}
} finally { await rm(scratch, {recursive:true,force:true}) }
console.log('STARTUP_GAP_REPORT '+JSON.stringify(reports))
assert.ok(reports.every(r=>r.earlyMutations===0),'a managed startup must block package mutation before its lease row: candidate protects both routes')
