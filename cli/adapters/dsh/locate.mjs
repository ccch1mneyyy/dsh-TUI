/** Resolve a built DSH JS bin without executing a shell or importing the TUI. */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { CliError } from '../../protocol.mjs'

function fromPackage(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh') return undefined
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof bin !== 'string') return undefined
    const path = resolve(dir, bin)
    if (!existsSync(path)) return undefined
    return { path: realpathSync(path), version: manifest.version }
  } catch { return undefined }
}

function above(path) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const found = fromPackage(dir)
    if (found) return found
    if (dirname(dir) === dir) return undefined
  }
}

/** Explicit bin -> standalone install anchor -> first executable on PATH. */
export function locateDsh(request, env = process.env) {
  const configured = request.dshBin ?? env.DSH_TUI_CLI_DSH_BIN
  if (configured !== undefined) {
    const path = resolve(request.cwd, configured)
    if (!/\.[cm]?js$/iu.test(path) || !existsSync(path)) throw new CliError('ADAPTER_UNAVAILABLE', 'Explicit DSH bin must be an existing built JavaScript entry', 3)
    const found = above(path)
    if (!found) throw new CliError('ADAPTER_UNAVAILABLE', 'Explicit bin must belong to an installed @deepseek-ai/dsh package', 3)
    return { ...found, path: realpathSync(path) }
  }
  if (env.DSH_TUI_CLI_INSTALL_ANCHOR) {
    const found = fromPackage(env.DSH_TUI_CLI_INSTALL_ANCHOR)
    if (found) return found
    throw new CliError('ADAPTER_UNAVAILABLE', 'Standalone DSH installation is incomplete', 3)
  }
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      try { accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK) } catch { continue }
      const beside = fromPackage(join(dir, 'node_modules', '@deepseek-ai', 'dsh'))
      if (beside) return beside
      let real
      try { real = realpathSync(candidate) } catch { break }
      const direct = above(real)
      if (direct) return direct
      const size = statSync(real).size
      const bytes = size < 65536 ? readFileSync(real) : Buffer.alloc(0)
      if (size < 65536 && !bytes.subarray(0, 4096).includes(0)) {
        const text = bytes.toString('utf8')
        const tokens = /"([^"\r\n]+?\.[cm]?js)"|'([^'\r\n]+?\.[cm]?js)'|([^\s"'`;|&<>()]+\.[cm]?js)(?=[\s"';|&)]|$)/gmu
        for (const match of text.matchAll(tokens)) {
          const script = (match[1] ?? match[2] ?? match[3])
            .replace(/^\$\{?basedir\}?/u, dirname(real))
            .replace(/^%~dp0%?/iu, `${dirname(real)}\\`)
            .replace(/^%dp0%/iu, dirname(real))
            .replace(/^\$PSScriptRoot/iu, dirname(real))
          if (/[$%]/u.test(script)) continue
          const found = above(resolve(dirname(real), script))
          if (found) return found
        }
      }
      // Do not quietly launch a different installation than the first shim.
      throw new CliError('ADAPTER_UNAVAILABLE', `Cannot resolve the first ${basename(candidate)} on PATH; use --dsh-bin`, 3)
    }
  }
  throw new CliError('ADAPTER_UNAVAILABLE', 'DSH was not found on PATH; install the official CLI or pass --dsh-bin', 3)
}
