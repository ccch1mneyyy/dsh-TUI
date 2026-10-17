/** Finish a committed transaction before returning success; never follow package links. */
import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { assertSafePath } from './transaction.mjs'

function removeFiles(files) {
  for (const file of files) {
    try { unlinkSync(file) }
    catch (error) {
      if (error.code === 'ENOENT') continue
      // rm handles Windows read-only files and directory junction leaves.
      // Never recurse here: a link must not turn into traversal of its target.
      if (error.code === 'EPERM' || error.code === 'EISDIR') rmSync(file, { force: true })
      else throw error
    }
  }
}

export async function cleanCommittedBackups(journalFile, roots) {
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  if (journal.state !== 'committed' || !/^[a-f\d-]{36}$/.test(journal.id) || !Array.isArray(journal.entries)) throw new Error('Invalid committed installation journal')
  const files = new Set(), directories = new Set()
  const walk = path => {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) { files.add(path); return }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(child)
      else files.add(child)
    }
    directories.add(path)
  }
  for (const entry of journal.entries) {
    if (entry.backup !== `${entry.target}.dsh-tui-backup-${journal.id}`) throw new Error('Invalid installation backup path')
    assertSafePath(entry.backup, roots)
    try { walk(entry.backup) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const list = [...files]
  const count = Math.min(16, availableParallelism(), Math.ceil(list.length / 256)) || 1
  if (count === 1) removeFiles(list)
  else {
    const results = await Promise.allSettled(Array.from({ length: count }, (_, id) => new Promise((complete, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: list.filter((_, index) => index % count === id) })
      let failure
      worker.once('error', error => { failure = error })
      worker.once('exit', code => failure || code !== 0 ? reject(failure ?? new Error(`Cleanup worker exited ${code}`)) : complete())
    })))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

if (!isMainThread) removeFiles(workerData)
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cleanCommittedBackups(process.argv[2], JSON.parse(process.argv[3])) }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1 }
}
