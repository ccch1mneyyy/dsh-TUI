const { spawn } = require('node:child_process')
const { createReadStream, statSync } = require('node:fs')
const { join, posix, relative, win32 } = require('node:path')
const { pipeline } = require('node:stream/promises')
const { t: listTar, x: extractTar } = require('tar')

const isBinLink = (path, entry) => entry.type === 'SymbolicLink'
  && /(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(path)
const asciiArgument = value => /^[\x20-\x7e]+$/.test(value)
const canonicalPath = path => path.length > 0 && !path.includes('\\')
  && !win32.isAbsolute(path) && posix.normalize(path) === path
  && (path === 'node_modules' || path.startsWith('node_modules/'))
  && path.split('/').every(part => !/[<>:"|?*\x00-\x1f]/.test(part)
    && !/[ .]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))

/** Resolve typed exclusions before handing the trusted bundle to system tar.
 * bsdtar exclusions match paths, not types: duplicate or aliased paths could
 * otherwise hide a real file or hardlink alongside an omitted POSIX alias.
 */
async function windowsBinExclusions(file, onReadEntry) {
  const paths = new Set()
  const exclusions = []
  let problem
  const parser = listTar({ strict: true, onReadEntry(entry) {
    onReadEntry?.(entry)
    const path = entry.type === 'Directory' ? entry.path.replace(/\/$/, '') : entry.path
    const key = path.toLowerCase()
    if (!canonicalPath(path)) problem ??= `Non-canonical Windows runtime path: ${entry.path}`
    if (paths.has(key)) problem ??= `Duplicate Windows runtime path: ${entry.path}`
    paths.add(key)
    if (!['File', 'OldFile', 'ContiguousFile', 'Directory', 'Link', 'SymbolicLink'].includes(entry.type)) {
      problem ??= `Unsupported Windows runtime entry: ${entry.type} ${entry.path}`
    }
    if (entry.type === 'Link' && !canonicalPath(entry.linkpath)) {
      problem ??= `Non-canonical Windows runtime hardlink: ${entry.path}`
    }
    if (entry.type === 'SymbolicLink') {
      const target = entry.linkpath
      const resolved = posix.normalize(posix.join(posix.dirname(path), target))
      if (!target || target.includes('\\') || win32.isAbsolute(target) || !canonicalPath(resolved)) {
        problem ??= `Unsafe Windows runtime symlink: ${entry.path}`
      }
    }
    if (isBinLink(path, entry)) {
      if (!asciiArgument(path)) problem ??= `Non-ASCII Windows command-link argument: ${entry.path}`
      // libarchive patterns are otherwise unanchored at both ends. Escape
      // glob syntax and anchor the exact canonical path recorded above.
      exclusions.push(`^${path.replace(/[\\*?\[\]^$]/g, '\\$&')}$`)
    }
  } })
  // tar deliberately ignores some valid header types instead of listing them.
  // They must not disappear from the collision check for native exclusions.
  parser.on('ignoredEntry', entry => {
    problem ??= `Unsupported Windows runtime entry: ${entry.type} ${entry.path}`
  })
  await pipeline(createReadStream(file, { highWaterMark: 16 * 1024 * 1024 }), parser)
  // Do not throw inside a streaming callback: reject here so cacheGuard can
  // remove its temporary archive/tree before reporting the invalid bundle.
  if (problem) throw new Error(problem)
  return exclusions
}

async function runWindowsTar(executable, args, cwd, onProgress) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, shell: false, detached: false, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let failure
    const cancel = signal => {
      failure ??= new Error(`Runtime extraction cancelled (${signal})`)
      // The owned, non-detached tar must close before cacheGuard removes the
      // staging tree. Acceptance-test deadlines kill the whole process tree.
      child.kill()
    }
    const interrupt = () => cancel('SIGINT')
    const terminate = () => cancel('SIGTERM')
    const hangup = () => cancel('SIGHUP')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    process.on('SIGHUP', hangup)
    onProgress?.()
    const progress = onProgress ? setInterval(onProgress, 1000) : undefined
    child.stderr.on('data', data => { stderr += data.toString('utf8').slice(0, Math.max(0, 64 * 1024 - stderr.length)) })
    child.once('error', error => { failure ??= error })
    child.once('close', (code, signal) => {
      clearInterval(progress)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      process.off('SIGHUP', hangup)
      if (failure) reject(failure)
      else if (code !== 0 || signal || stderr.trim()) {
        reject(new Error(`Windows runtime extraction failed (${signal ?? code}): ${stderr.trim() || 'tar did not complete'}`))
      } else resolve()
    })
  })
}

/** Both normal launch and --self-test use the same extractor and cache guard. */
async function extractRuntime(options, { windows = process.platform === 'win32', onReadEntry, onProgress, trace = () => {} } = {}) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  const nativeTar = windows && systemRoot ? join(systemRoot, 'System32', 'tar.exe') : undefined
  let nativeAvailable = false
  if (nativeTar) {
    try {
      nativeAvailable = statSync(nativeTar).isFile()
      if (!nativeAvailable) throw new Error('Windows system tar is not a regular file')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!nativeAvailable) {
    trace('extract-start', { method: 'node-tar', synchronous: Boolean(windows) })
    await extractTar({ ...options, sync: Boolean(windows), onReadEntry,
      filter: (path, entry) => !(windows && isBinLink(path, entry)) })
    return
  }

  trace('extract-start', { method: 'windows-tar' })
  trace('extract-scan-start')
  const exclusions = await windowsBinExclusions(options.file, onReadEntry)
  trace('extract-scan-done', { excludedBinLinks: exclusions.length })
  // Node sets Unicode cwd through wide Windows APIs. Some system tar builds
  // decode argv with an ANSI code page, so never pass absolute Unicode paths.
  const archiveArgument = relative(options.cwd, options.file)
  if (!asciiArgument(archiveArgument)) throw new Error('Windows runtime archive requires a non-ASCII tar argument')
  const args = ['-xf', archiveArgument, '--no-same-owner', '--no-same-permissions',
    ...exclusions.flatMap(pattern => ['--exclude', pattern])]
  trace('extract-native-start')
  // No retry after a native error: it may have already written a partial tree.
  await runWindowsTar(nativeTar, args, options.cwd, onProgress)
}

module.exports = { extractRuntime }
