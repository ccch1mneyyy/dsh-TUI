/** Journaled file replacement. Backups stay beside targets, including redirected user folders. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function assertWithin(path, roots) {
  const full = resolve(path)
  if (!roots.some(root => {
    const rel = relative(resolve(root), full)
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
  })) throw new Error(`Path outside installer roots: ${full}`)
  return full
}

/** Refuse redirected parent directories; the leaf itself may be an npm/pnpm link. */
function checkParents(path, roots) {
  let parent = dirname(path)
  while (!existsSync(parent)) parent = dirname(parent)
  const real = realpathSync(parent)
  // A not-yet-created root has an existing ancestor outside the root itself.
  if (real.toLowerCase() === resolve(parent).toLowerCase() && roots.some(root => {
    const rel = relative(parent, root)
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  })) return
  if (!roots.some(root => resolve(root).toLowerCase() === real.toLowerCase())) assertWithin(real, roots)
}

export function assertSafePath(path, roots) {
  const full = assertWithin(path, roots)
  checkParents(full, roots)
  return full
}

function removeOwned(path, roots) {
  assertWithin(path, roots)
  checkParents(path, roots)
  if (existsSync(path) || (() => { try { return lstatSync(path).isSymbolicLink() } catch { return false } })()) {
    rmSync(path, { recursive: true, force: true })
  }
}

export class FileTransaction {
  constructor(stage, roots, journal) {
    this.roots = roots.map(root => resolve(root))
    this.file = assertWithin(resolve(stage, 'transaction.json'), this.roots)
    this.journal = journal ?? { id: randomUUID(), state: 'pending', entries: [] }
    mkdirSync(stage, { recursive: true })
  }

  save() {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.journal, null, 2)}\n`)
    renameSync(`${this.file}.tmp`, this.file)
  }

  /** incoming and target must be on the same volume; stage profile files beside that profile. */
  replace(incoming, target) {
    target = assertWithin(target, this.roots)
    if (incoming !== undefined) {
      incoming = assertSafePath(incoming, this.roots)
      lstatSync(incoming)
    }
    checkParents(target, this.roots)
    mkdirSync(dirname(target), { recursive: true })
    const backup = `${target}.dsh-tui-backup-${this.journal.id}`
    const hadOriginal = (() => { try { lstatSync(target); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } })()
    const entry = { target, backup, incoming, hadOriginal }
    this.journal.entries.push(entry)
    this.save()
    if (hadOriginal) renameSync(target, backup)
    if (incoming !== undefined) renameSync(incoming, target)
  }

  rollback() {
    for (const entry of [...this.journal.entries].reverse()) {
      assertWithin(entry.target, this.roots)
      assertWithin(entry.backup, this.roots)
      if (existsSync(entry.backup) || (() => { try { return lstatSync(entry.backup).isSymbolicLink() } catch { return false } })()) {
        removeOwned(entry.target, this.roots)
        renameSync(entry.backup, entry.target)
      } else if (!entry.hadOriginal) removeOwned(entry.target, this.roots)
    }
    this.journal.state = 'rolled-back'
    this.save()
  }

  commit() {
    this.journal.state = 'committed'
    this.save()
    // A cleanup failure must not turn a committed installation into a partial rollback.
    try { this.cleanBackups() } catch (error) { console.warn(`Backup cleanup deferred: ${error.message}`) }
  }

  cleanBackups() {
    if (process.platform === 'win32' && this.journal.entries.some(entry => {
      try { return lstatSync(entry.backup).isDirectory() } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    })) {
      const cleaned = spawnSync(process.execPath, [fileURLToPath(new URL('./cleanup.mjs', import.meta.url)), this.file, JSON.stringify(this.roots)], { encoding: 'utf8', windowsHide: true, timeout: 600_000 })
      if (cleaned.error || cleaned.status !== 0) throw new Error(`Backup cleanup failed: ${cleaned.error?.message ?? cleaned.stderr}`)
      return
    }
    for (const entry of this.journal.entries) removeOwned(entry.backup, this.roots)
  }
}

/** Called before a new installation; an interrupted commit is rolled back, never guessed successful. */
export function recoverTransaction(stage, roots) {
  const file = resolve(stage, 'transaction.json')
  if (!existsSync(file)) return
  const journal = JSON.parse(readFileSync(assertWithin(file, roots), 'utf8'))
  if (!/^[a-f\d-]{36}$/.test(journal.id) || !Array.isArray(journal.entries)) throw new Error('Invalid installation journal')
  for (const entry of journal.entries) {
    if (entry.backup !== `${entry.target}.dsh-tui-backup-${journal.id}`) throw new Error('Invalid installation backup path')
  }
  const tx = new FileTransaction(stage, roots, journal)
  if (journal.state === 'committed') tx.cleanBackups()
  else if (journal.state === 'pending') tx.rollback()
  else if (journal.state !== 'rolled-back') throw new Error('Invalid installation journal state')
}
