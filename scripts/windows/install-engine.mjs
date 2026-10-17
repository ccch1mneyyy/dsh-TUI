/** Offline installation engine. NSIS owns interaction; this module owns file and version decisions. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import semver from 'semver'
import { DSH_PACKAGE, TUI_PACKAGE, kernelAction, tuiNeedsDowngrade, mergeProfile, updatePath, supportsNode } from './policy.mjs'
import { assertWithin, assertSafePath, FileTransaction, recoverTransaction } from './transaction.mjs'
import { verifyArchive } from './integrity.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`) }
const packageDir = (prefix, name) => join(prefix, 'node_modules', name)
const packageVersion = (prefix, name) => {
  const file = join(packageDir(prefix, name), 'package.json')
  if (!existsSync(file)) return undefined
  const pkg = readJson(file)
  if (pkg.name !== name || !semver.valid(pkg.version)) throw new Error(`Invalid installed package: ${file}`)
  return pkg.version
}
const shimFiles = name => ['', '.cmd', '.ps1'].map(extension => `${name}${extension}`)

function paths(options) {
  const prefix = resolve(options.prefix ?? join(process.env.APPDATA, 'npm'))
  const userHome = resolve(options.home ?? homedir())
  const metadataDir = resolve(options['metadata-dir'] ?? join(process.env.LOCALAPPDATA, 'Programs/dsh-tui'))
  // The one-click installer targets the default layout, so the profile goes to
  // DSH's default home and a custom DSH_HOME is deliberately not consulted.
  const profile = join(userHome, '.dsh/profiles/dsh-tui')
  return { prefix, userHome, metadataDir, profile, stage: join(prefix, '_stage_tui'), roots: [prefix, join(userHome, '.dsh/profiles'), metadataDir] }
}

function windows(action, data, context) {
  if (context.system) return context.system(action, data)
  if (context.fileOnly) {
    if (action === 'inspect') return { path: '', pathContainsPrefix: false, running: [], nodePaths: [], dshPath: null, registration: null }
    return { ok: true }
  }
  const request = join(context.work, `system-${action}.json`)
  const response = join(context.work, `system-${action}-result.json`)
  writeJson(request, data)
  const powerShell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  // Never inherit the caller's working directory: the plug-in directory holds a
  // native System.dll that shadows the .NET reference assembly used by Add-Type.
  const result = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'windows-system.ps1'), '-Action', action, '-InputFile', request, '-OutputFile', response], { encoding: 'utf8', windowsHide: true, timeout: 60_000, cwd: process.env.SystemRoot })
  if (result.error || result.status !== 0) throw new Error(`Windows ${action} failed: ${result.error?.message ?? result.stderr}`)
  return readJson(response)
}

function nodeAvailable(state, prefix, range) {
  const local = join(prefix, 'node.exe')
  const candidates = existsSync(local) ? [local] : state.nodePaths
  return candidates.slice(0, 1).some(candidate => {
    const result = spawnSync(candidate, ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch})'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    if (result.status !== 0) return false
    try {
      const runtime = JSON.parse(result.stdout)
      return supportsNode(runtime.version, runtime.arch, range)
    } catch { return false }
  })
}

/** Windows PowerShell can serialize an absent command as an empty object instead of null; only a path string is a command. */
function commandPath(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function inspectInstallation(target, metadata, context) {
  const inspected = windows('inspect', { prefix: target.prefix }, context)
  const system = { ...inspected, dshPath: commandPath(inspected.dshPath) }
  const kernelInstalled = packageVersion(target.prefix, DSH_PACKAGE)
  const tuiInstalled = packageVersion(target.prefix, TUI_PACKAGE)
  const profileInstalled = packageVersion(target.profile, TUI_PACKAGE)
  const otherProfiles = existsSync(dirname(target.profile)) ? readdirSync(dirname(target.profile), { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'dsh-tui' && entry.name !== 'node_modules' && existsSync(join(dirname(target.profile), entry.name, 'package.json'))).map(entry => entry.name) : []
  return {
    system, kernelInstalled, tuiInstalled, profileInstalled, otherProfiles,
    kernelAction: kernelAction(kernelInstalled, metadata),
    tuiDowngrade: tuiNeedsDowngrade(tuiInstalled, metadata) || tuiNeedsDowngrade(profileInstalled, metadata),
    installNode: !nodeAvailable(system, target.prefix, metadata.nodeRange),
    installPnpm: !existsSync(join(target.prefix, 'pnpm.cmd')),
  }
}

/** Always reject missing, extra or linked entries, even for a verified archive. */
function verifyInventory(payload, metadata) {
  if (metadata.schemaVersion !== 1 || !metadata.files || !Object.keys(metadata.files).length) throw new Error('Invalid payload manifest')
  let count = 0
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(join(directory, entry.name), name)
      else if (!entry.isFile() || !Object.hasOwn(metadata.files, name)) throw new Error(`Unexpected payload entry: ${name}`)
      else count++
    }
  }
  visit(payload)
  if (count !== Object.keys(metadata.files).length) throw new Error('Payload file count mismatch')
}

/** Check every shipped byte before modifying installed packages. */
export function verifyPayload(payload, metadata) {
  verifyInventory(payload, metadata)
  for (const [name, expected] of Object.entries(metadata.files)) {
    const file = assertWithin(join(payload, name), [payload])
    if (!lstatSync(file).isFile()) throw new Error(`Invalid payload file: ${name}`)
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (actual !== expected) throw new Error(`Payload checksum mismatch: ${name}`)
  }
}

function ensureStopped(state) {
  if (state.system.running.length) throw new Error(`Close dsh / dsh-tui first (PID ${state.system.running.join(', ')})`)
}

function ensureCommandLocation(state, target) {
  if (state.system.dshPath && resolve(state.system.dshPath).toLowerCase() !== join(target.prefix, 'dsh.cmd').toLowerCase()) {
    throw new Error(`Another DSH command takes precedence on PATH: ${state.system.dshPath}. Put ${target.prefix} before that installation and retry.`)
  }
}

function copyForReplacement(source, target, scratch, tx, id, parallel = false) {
  const incoming = join(scratch, String(id))
  if (parallel && process.platform === 'win32') {
    // The verified TUI tree contains only regular files/directories. Robocopy
    // overlaps small-file I/O and still creates independent files across drives.
    mkdirSync(incoming)
    const copied = spawnSync(join(process.env.SystemRoot, 'System32/robocopy.exe'), [source, incoming, '/E', '/COPY:D', '/DCOPY:D', '/MT:8', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8', windowsHide: true, timeout: 600_000 })
    // Robocopy uses 0..7 for successful outcomes; >=8 includes failed files.
    if (copied.error || copied.status === null || copied.status >= 8) throw new Error(`Unable to copy TUI profile: ${copied.error?.message ?? copied.stderr + copied.stdout}`)
  } else cpSync(source, incoming, { recursive: true, dereference: false, errorOnExist: true })
  tx.replace(incoming, target)
}

function cleanupStage(target) {
  assertSafePath(join(target.stage, 'stage-owner.json'), [target.prefix])
  if (readJson(join(target.stage, 'stage-owner.json')).owner !== 'dsh-tui-windows-installer-v1') throw new Error('Unrecognized staging directory')
  rmSync(target.stage, { recursive: true, force: true })
}

function restoreSystem(target, context) {
  const file = join(target.stage, 'system-rollback.json')
  if (!existsSync(file)) return
  const previous = readJson(file)
  const current = windows('inspect', { prefix: target.prefix }, context)
  if (current.path === previous.pathAfter && previous.pathBefore !== previous.pathAfter) {
    windows('path', { expected: current.path, value: previous.pathBefore }, context)
  }
  windows('restore-registration', { registration: previous.registration }, context)
  rmSync(file)
}

function saveSystemRollback(target, state, pathAfter) {
  writeJson(join(target.stage, 'system-rollback.json'), { pathBefore: state.system.path, pathAfter, registration: state.system.registration ?? null })
}

function detachedScratch(target, id) {
  return [join(dirname(target.profile), `.dsh-tui-install-${id}`), join(target.metadataDir, `.install-${id}`)]
}

function finishTransaction(target) {
  // Keep the journal if Windows still holds a backup open; the next run retries.
  try { recoverTransaction(target.stage, target.roots); cleanupStage(target) }
  catch (error) { console.warn(`Installation committed; temporary cleanup will be retried: ${error.message}`) }
}

export function prepareStage(target, context) {
  assertSafePath(join(target.stage, 'stage-owner.json'), target.roots)
  if (existsSync(target.stage)) {
    if (!existsSync(join(target.stage, 'stage-owner.json'))) throw new Error(`Staging directory already exists and is not installer-owned: ${target.stage}`)
    if (readJson(join(target.stage, 'stage-owner.json')).owner !== 'dsh-tui-windows-installer-v1') throw new Error('Unrecognized staging directory owner')
    const journalFile = join(target.stage, 'transaction.json')
    const committed = existsSync(journalFile) && readJson(journalFile).state === 'committed'
    recoverTransaction(target.stage, target.roots)
    if (!committed) restoreSystem(target, context)
    if (existsSync(journalFile)) {
      for (const scratch of detachedScratch(target, readJson(journalFile).id)) {
        assertSafePath(scratch, target.roots)
        if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true })
      }
    }
    cleanupStage(target)
  }
  mkdirSync(target.stage, { recursive: true })
  writeJson(join(target.stage, 'stage-owner.json'), { owner: 'dsh-tui-windows-installer-v1' })
}

export function installPayload(target, payload, metadata, decisions, context) {
  mkdirSync(target.prefix, { recursive: true })
  recoverTransaction(target.stage, target.roots)
  const state = inspectInstallation(target, metadata, context)
  ensureStopped(state)
  ensureCommandLocation(state, target)
  if (['downgrade', 'incompatible'].includes(state.kernelAction) && !decisions.kernelDowngrade) throw new Error('Kernel replacement requires both downgrade confirmations')
  if (state.tuiDowngrade && !decisions.tuiDowngrade) throw new Error('TUI downgrade requires both confirmations')
  const installPnpm = state.installPnpm
  let selectedMetadata = metadata
  let verifiedArchive = false
  const packed = decisions.extract && metadata.archives !== undefined
  const existingFile = join(target.profile, 'package.json')
  const profileManifest = mergeProfile(existsSync(existingFile) ? readJson(existingFile) : undefined, metadata.tuiVersion)
  const tx = new FileTransaction(target.stage, target.roots)
  const scratch = join(target.stage, 'prepared')
  const consumePayload = resolve(payload) === join(target.stage, 'payload')
  const [profileScratch, metadataScratch] = detachedScratch(target, tx.journal.id)
  assertSafePath(profileScratch, target.roots)
  assertSafePath(metadataScratch, target.roots)
  // An interrupted extraction must also leave enough journal information to
  // remove its profile staging directory, including on a different volume.
  tx.save()
  const preparedProfile = join(profileScratch, 'tui')
  let index = 0
  let pathChange
  const oldReceiptFile = join(target.metadataDir, 'installation.json')
  const oldReceipt = existsSync(oldReceiptFile) ? readJson(oldReceiptFile) : {}
  try {
    mkdirSync(scratch, { recursive: true })
    mkdirSync(dirname(profileScratch), { recursive: true })
    mkdirSync(profileScratch)
    if (packed) {
      if (!consumePayload) throw new Error('Archive extraction requires the installer staging directory')
      const selected = ['common', 'tui', ...(state.kernelAction !== 'keep' ? ['dsh'] : []), ...(installPnpm ? ['pnpm'] : []), ...(state.installNode ? ['node'] : [])]
      const plan = join(target.stage, 'extraction.json')
      writeJson(plan, { metadata, selected, stage: target.stage, payload, profile: preparedProfile, roots: target.roots })
      context.report?.('Verifying and extracting required offline components…')
      const extracted = spawnSync(process.execPath, [join(here, 'archive.mjs'), plan], { encoding: 'utf8', windowsHide: true, timeout: 600_000 })
      if (extracted.error || extracted.status !== 0) throw new Error(`Unable to extract offline components: ${extracted.error?.message ?? extracted.stderr}`)
      const names = new Set(selected.flatMap(id => metadata.archives[id].files.map(file => file.name)))
      selectedMetadata = { ...metadata, files: Object.fromEntries(Object.entries(metadata.files).filter(([name]) => names.has(name))) }
      verifiedArchive = true
    } else if (decisions.extract) {
      if (!consumePayload) throw new Error('Archive extraction requires the installer staging directory')
      assertSafePath(join(target.stage, 'payload.tar'), target.roots)
      assertSafePath(payload, target.roots)
      if (existsSync(payload)) throw new Error('Archive extraction requires a fresh payload directory')
      if (metadata.archiveSha256 !== undefined) {
        context.report?.('Verifying the offline archive…')
        verifyArchive(join(target.stage, 'payload.tar'), metadata.archiveSha256)
        verifiedArchive = true
      }
      const excluded = []
      if (state.kernelAction === 'keep') excluded.push(`global/node_modules/${DSH_PACKAGE}`)
      if (!installPnpm) excluded.push('global/node_modules/pnpm')
      if (!state.installNode) excluded.push('node')
      selectedMetadata = { ...metadata, files: Object.fromEntries(Object.entries(metadata.files).filter(([name]) => !excluded.some(prefix => name === prefix || name.startsWith(`${prefix}/`)))) }
      context.report?.('Extracting required offline components…')
      mkdirSync(payload, { recursive: true })
      // Keep tar arguments ASCII: Windows tar can lose Unicode absolute paths.
      const tar = join(process.env.SystemRoot, 'System32/tar.exe')
      // bsdtar exclusions otherwise match at any depth (including dist/node in
      // dependencies). Its ^ anchor restricts each exclusion to the archive root.
      const extracted = spawnSync(tar, ['-xf', 'payload.tar', '-C', 'payload', ...excluded.map(name => `--exclude=^${name}`)], { cwd: target.stage, encoding: 'utf8', windowsHide: true, timeout: 600_000 })
      if (extracted.error || extracted.status !== 0) throw new Error(`Unable to extract offline components: ${extracted.error?.message ?? extracted.stderr}`)
    }
    if (verifiedArchive) {
      // Contents were checked while extracting indexed files, or before tar
      // extraction. Check inventory without reopening every file's contents.
      verifyInventory(payload, selectedMetadata)
    } else {
      context.report?.(`Verifying ${Object.keys(selectedMetadata.files).length} offline files…`)
      verifyPayload(payload, selectedMetadata)
    }
    context.report?.('Installing verified components…')
    // The EXE extracts beside the destination, on the same volume. Promote those
    // verified files through the existing rollback journal instead of copying
    // tens of thousands of files and then deleting the temporary originals.
    mkdirSync(metadataScratch, { recursive: true })
    const replacePayload = (source, destination) => {
      if (consumePayload) tx.replace(source, destination)
      else copyForReplacement(source, destination, scratch, tx, index++)
    }
    const replaceGlobal = name => {
      const source = packageDir(join(payload, 'global'), name)
      const commands = Object.keys(readJson(join(source, 'package.json')).bin)
      replacePayload(source, packageDir(target.prefix, name))
      for (const command of commands) {
        for (const file of shimFiles(command)) replacePayload(join(payload, 'global', file), join(target.prefix, file))
      }
    }
    if (state.kernelAction !== 'keep') replaceGlobal(DSH_PACKAGE)
    replaceGlobal(TUI_PACKAGE)
    if (installPnpm) replaceGlobal('pnpm')
    if (state.installNode) {
      for (const file of ['node.exe', 'npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1']) {
        const source = join(payload, 'node', file)
        if (existsSync(source)) replacePayload(source, join(target.prefix, file))
      }
      replacePayload(join(payload, 'node/node_modules/npm'), packageDir(target.prefix, 'npm'))
      replacePayload(join(payload, 'node/LICENSE'), join(target.prefix, 'node-LICENSE.txt'))
    }
    context.report?.('Updating the TUI profile…')
    if (packed) tx.replace(preparedProfile, packageDir(target.profile, TUI_PACKAGE))
    else copyForReplacement(packageDir(target.prefix, TUI_PACKAGE), packageDir(target.profile, TUI_PACKAGE), profileScratch, tx, index++, true)
    const newManifest = join(profileScratch, 'manifest.json'); writeJson(newManifest, profileManifest)
    tx.replace(newManifest, existingFile)
    // Match dsh-app-boot's standard profile template. The application's update
    // command manages per-release pnpm allowances when the user later upgrades.
    for (const [name, content] of [['cordis.patch.yml', '[]\n'], ['pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n']]) {
      if (!existsSync(join(target.profile, name))) {
        const file = join(profileScratch, name); writeFileSync(file, content)
        tx.replace(file, join(target.profile, name))
      }
    }
    pathChange = state.system.pathContainsPrefix ? { value: state.system.path, changed: false } : updatePath(state.system.path, target.prefix, 'add')
    const receipt = { schemaVersion: 1, tuiVersion: metadata.tuiVersion, kernelVersion: state.kernelAction === 'keep' ? state.kernelInstalled : metadata.kernelVersion, prefix: target.prefix, userHome: target.userHome, addedPath: oldReceipt.addedPath === true || pathChange.changed, installNode: state.installNode || oldReceipt.installNode === true }
    const receiptSource = join(metadataScratch, 'installation.json'); writeJson(receiptSource, receipt)
    tx.replace(receiptSource, oldReceiptFile)
    if (decisions.uninstaller) copyForReplacement(decisions.uninstaller, join(target.metadataDir, 'unins000.exe'), metadataScratch, tx, index++)
    saveSystemRollback(target, state, pathChange.value)
    if (pathChange.changed) {
      const applied = windows('path', { expected: state.system.path, value: pathChange.value }, context)
      // A refused broadcast only means already-open shells keep the old PATH.
      if (applied.notified === false) context.report?.('Installed, but Windows did not refresh the environment for already-open programs.')
    }
    windows('register', { version: metadata.tuiVersion, metadataDir: target.metadataDir }, context)
    tx.commit()
  } catch (error) {
    tx.rollback()
    restoreSystem(target, context)
    throw error
  } finally {
    assertWithin(profileScratch, target.roots)
    rmSync(profileScratch, { recursive: true, force: true })
    if (existsSync(metadataScratch)) rmSync(metadataScratch, { recursive: true, force: true })
  }
  context.report?.('Cleaning temporary installation files…')
  finishTransaction(target)
  return state
}

export function uninstallPackages(target, metadata, full, confirmedShared, context) {
  const state = inspectInstallation(target, metadata, context)
  ensureStopped(state)
  if (full && state.otherProfiles.length && !confirmedShared) throw new Error(`Other profiles may need DSH: ${state.otherProfiles.join(', ')}`)
  const receiptFile = join(target.metadataDir, 'installation.json')
  const receipt = existsSync(receiptFile) ? readJson(receiptFile) : {}
  prepareStage(target, context)
  const tx = new FileTransaction(target.stage, target.roots)
  try {
    for (const name of full ? [TUI_PACKAGE, DSH_PACKAGE] : [TUI_PACKAGE]) {
      const source = packageDir(target.prefix, name)
      if (existsSync(join(source, 'package.json'))) {
        for (const command of Object.keys(readJson(join(source, 'package.json')).bin)) {
          for (const file of shimFiles(command)) {
            const path = join(target.prefix, file)
            if (existsSync(path) && readFileSync(path, 'utf8').replaceAll('\\', '/').includes(`node_modules/${name}/`)) tx.replace(undefined, path)
          }
        }
        tx.replace(undefined, source)
      }
    }
    const sharedCommands = readdirSync(target.prefix).some(name => /\.(cmd|exe|ps1)$/i.test(name))
    const change = updatePath(state.system.path, target.prefix, 'remove', receipt.addedPath, sharedCommands)
    saveSystemRollback(target, state, change.value)
    if (change.changed) windows('path', { expected: state.system.path, value: change.value }, context)
    windows('unregister', {}, context)
    tx.commit()
  } catch (error) { tx.rollback(); restoreSystem(target, context); throw error }
  finishTransaction(target)
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`)
    if (['--file-only', '--kernel-downgrade', '--tui-downgrade', '--full', '--confirm-shared', '--extract'].includes(name)) options[name.slice(2)] = true
    else { if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`); options[name.slice(2)] = args[++index] }
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options
  try {
    const operation = process.argv[2]
    options = parseArgs(process.argv.slice(3))
    const target = paths(options)
    const metadata = readJson(options.metadata)
    const context = { fileOnly: options['file-only'], work: dirname(resolve(options.result ?? join(here, 'result.ini'))), report: message => console.log(message) }
    let result
    if (operation === 'runtime') {
      if (!supportsNode(process.versions.node, process.arch, metadata.nodeRange)) throw new Error('Incompatible Node runtime')
      result = {}
    } else if (operation === 'inspect') result = inspectInstallation(target, metadata, context)
    else if (operation === 'prepare') { prepareStage(target, context); result = {} }
    else if (operation === 'discard') { prepareStage(target, context); cleanupStage(target); result = {} }
    else if (operation === 'install') result = installPayload(target, resolve(options.payload), metadata, { kernelDowngrade: options['kernel-downgrade'], tuiDowngrade: options['tui-downgrade'], uninstaller: options.uninstaller, extract: options.extract }, context)
    else if (operation === 'uninstall') { uninstallPackages(target, metadata, options.full, options['confirm-shared'], context); result = {} }
    else if (operation === 'verify') { verifyPayload(resolve(options.payload), metadata); result = {} }
    else throw new Error(`Unknown operation: ${operation}`)
    if (options.result) {
      const fields = { kernelAction: result.kernelAction ?? '', kernelInstalled: result.kernelInstalled ?? '', tuiInstalled: result.tuiInstalled ?? result.profileInstalled ?? '', tuiDowngrade: result.tuiDowngrade ? 'yes' : 'no', installNode: result.installNode ? 'yes' : 'no', installPnpm: result.installPnpm ? 'yes' : 'no', running: result.system?.running.join(', ') ?? '', otherProfiles: result.otherProfiles?.join(', ') ?? '' }
      writeFileSync(options.result, `\uFEFF[result]\r\n${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\r\n')}\r\n`, 'utf16le')
    }
    console.log(`${operation}: OK`)
  } catch (error) {
    console.error(error.stack ?? error)
    if (options?.result) writeFileSync(options.result, `\uFEFF[result]\r\nerror=${error.message.replace(/[\r\n]/g, ' ')}\r\n`, 'utf16le')
    process.exitCode = 1
  }
}
