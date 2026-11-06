/**
 * TikZ → SVG through a hardened local TeX run.
 *
 * The figure is compiled with `latex` (DVI) and converted by `dvisvgm`. Both
 * are spawned as argv arrays — never through a shell — in a fresh temporary
 * directory, with a scrubbed environment, `-no-shell-escape`, paranoid
 * `openin_any` and a wall-clock timeout that kills the whole process group.
 * A failure is a typed result and the caller keeps the source block.
 *
 * Results are cached by source + template + toolchain identity (successes and
 * failures alike), so a replay or a theme change never re-runs TeX. Compiles
 * are serialized: a transcript with several figures must not fan out several
 * TeX processes, and the engine is the expensive part of "realtime".
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeightedLru } from '../utils/weightedLru.js'
import { buildTikzDocument, TIKZ_TEMPLATE_VERSION, type TikzSourceFailure } from './source.js'

/** Long enough for a cold TeX + TikZ page on a slow machine, short enough to bound a hostile loop. */
const TEX_TIMEOUT_MS = 12_000
const DVISVGM_TIMEOUT_MS = 6_000
/** dvisvgm output is paths; a hostile figure may still try to inflate it. */
const MAX_SVG_BYTES = 16 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024

export type TikzCompileFailure =
  | TikzSourceFailure
  | 'engine-unavailable'
  | 'compile-error'
  | 'timeout'
  | 'aborted'
  | 'svg-error'
  | 'output-too-large'

export interface TikzSvg {
  readonly svg: string
  readonly widthPt: number
  readonly heightPt: number
}

export type TikzCompileResult =
  | { readonly ok: true; readonly svg: TikzSvg; readonly key: string }
  | { readonly ok: false; readonly failure: TikzCompileFailure }

interface TikzEngineInfo {
  readonly key: string
  readonly latex: string
  readonly dvisvgm: string
}

interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly spawnError: string | undefined
}

const compiled = new WeightedLru<TikzCompileResult>(
  64,
  16 * 1024 * 1024,
  value => value.ok ? value.svg.svg.length * 2 : 64,
)
const inflight = new Map<string, Promise<TikzCompileResult>>()

/** Cache counters, for tests and debug output. */
export const tikzCompileStats = { hits: 0, misses: 0 }

/** Compiles still running or queued (tests wait for 0 before reading the screen). */
export function tikzCompilesInFlight(): number {
  return inflight.size
}

let engineProbe: Promise<TikzEngineInfo | undefined> | undefined
let engineInfo: TikzEngineInfo | undefined

/** The probed engine, once known; undefined while pending or unavailable. */
export function peekTikzEngine(): TikzEngineInfo | undefined {
  return engineInfo
}

/** Clear cached vectors, failures and the engine probe (tests; a future debug command). */
export function clearTikzCompileCaches(): void {
  compiled.clear()
  inflight.clear()
  engineProbe = undefined
  engineInfo = undefined
  tikzCompileStats.hits = 0
  tikzCompileStats.misses = 0
}

/**
 * Compile one figure source to SVG. Concurrent requests for the same source
 * share one compile; different sources queue behind each other.
 */
export function compileTikzSvg(source: string, signal?: AbortSignal): Promise<TikzCompileResult> {
  if (signal?.aborted === true) return Promise.resolve({ ok: false, failure: 'aborted' })
  const built = buildTikzDocument(source)
  if (!built.ok) return Promise.resolve({ ok: false, failure: built.failure })

  return probeEngine().then(engine => {
    if (engine === undefined) return { ok: false, failure: 'engine-unavailable' } as const
    const format = tikzFormatPath()
    const key = sourceKey(engine, source, format)
    const cached = compiled.get(key)
    if (cached !== undefined) {
      tikzCompileStats.hits += 1
      return cached
    }
    const pending = inflight.get(key)
    if (pending !== undefined) return pending
    tikzCompileStats.misses += 1
    const run = enqueue(async (): Promise<TikzCompileResult> => {
      if (signal?.aborted === true) return { ok: false, failure: 'aborted' }
      return compileInTempDir(built.document.document, key, format, signal)
    })
      .then(result => {
        inflight.delete(key)
        // Aborts are request-specific: a later reader may still want this source.
        if (!(result.ok === false && result.failure === 'aborted')) compiled.set(key, result)
        return result
      })
      .catch((): TikzCompileResult => {
        inflight.delete(key)
        return { ok: false, failure: 'compile-error' }
      })
    inflight.set(key, run)
    return run
  })
}

function sourceKey(engine: TikzEngineInfo, source: string, format: string): string {
  return createHash('sha256')
    .update(`${engine.key}\u0000${TIKZ_TEMPLATE_VERSION}\u0000${format}\u0000${source}`)
    .digest('hex')
}

/** Optional preloaded format produced by the Nix package (mylatexformat). */
function tikzFormatPath(): string {
  const value = process.env.DSH_TUI_TIKZ_FORMAT
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

let queueTail: Promise<unknown> = Promise.resolve()

/** Serialize compiles; TeX is a whole child process and the app stays interactive. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task)
  queueTail = run.then(() => undefined, () => undefined)
  return run
}

function probeEngine(): Promise<TikzEngineInfo | undefined> {
  engineProbe ??= Promise.all([
    processVersion('latex'),
    processVersion('dvisvgm'),
  ]).then(([latex, dvisvgm]) => {
    const info = latex === undefined || dvisvgm === undefined
      ? undefined
      : {
          key: createHash('sha256').update(`${latex}\u0000${dvisvgm}`).digest('hex').slice(0, 16),
          latex,
          dvisvgm,
        }
    engineInfo = info
    return info
  }).catch(() => {
    engineInfo = undefined
    return undefined
  })
  return engineProbe
}

async function processVersion(command: string): Promise<string | undefined> {
  const result = await runProcess(command, ['--version'], {
    cwd: tmpdir(),
    env: { ...process.env },
    timeoutMs: 4_000,
  })
  if (result.timedOut || result.aborted || result.spawnError !== undefined || result.code !== 0) return undefined
  const line = (result.stdout || result.stderr).split('\n', 1)[0]?.trim()
  return line === undefined || line === '' ? undefined : line
}

async function compileInTempDir(document: string, key: string, format: string, signal?: AbortSignal): Promise<TikzCompileResult> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tikz-')).catch(() => undefined)
  if (dir === undefined) return { ok: false, failure: 'compile-error' }
  try {
    const texPath = join(dir, 'figure.tex')
    const dviPath = join(dir, 'figure.dvi')
    const svgPath = join(dir, 'figure.svg')
    await writeFile(texPath, document, 'utf8')

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      TMPDIR: dir,
      TEXMFVAR: join(dir, 'texmf-var'),
      TEXMFCONFIG: join(dir, 'texmf-config'),
      TEXMFHOME: join(dir, 'texmf-home'),
      TEXMFCACHE: join(dir, 'texmf-cache'),
      // Defense in depth; the command line pins openin_any too. `openin_any=p`
      // blocks \input of absolute paths, `openout_any=p` keeps writes inside
      // the temp directory, and shell_escape=f mirrors -no-shell-escape.
      openin_any: 'p',
      openout_any: 'p',
      shell_escape: 'f',
      SOURCE_DATE_EPOCH: '0',
      LC_ALL: 'C',
    }
    const texArgs = (preloaded: boolean): string[] => [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-no-shell-escape',
      '-cnf-line=openin_any=p',
      ...(preloaded ? [`-fmt=${format}`] : []),
      '-output-directory',
      dir,
      texPath,
    ]
    // A format is a speed lever, not a correctness dependency: if the
    // preloaded run fails (stale path, format/engine mismatch, source error)
    // retry the normal document once. A malformed source fails both times;
    // the repeated 0.3-0.9 s is the price of never turning a valid figure
    // into source because a cache path went stale.
    let tex = await runProcess('latex', texArgs(format !== ''), { cwd: dir, env, timeoutMs: TEX_TIMEOUT_MS, signal })
    if (format !== '' && !tex.aborted && !tex.timedOut && tex.spawnError === undefined && tex.code !== 0) {
      await rm(dviPath, { force: true }).catch(() => {})
      tex = await runProcess('latex', texArgs(false), { cwd: dir, env, timeoutMs: TEX_TIMEOUT_MS, signal })
    }
    if (tex.aborted) return { ok: false, failure: 'aborted' }
    if (tex.timedOut) return { ok: false, failure: 'timeout' }
    if (tex.spawnError !== undefined) return { ok: false, failure: 'engine-unavailable' }
    if (tex.code !== 0) return { ok: false, failure: 'compile-error' }
    if (!(await exists(dviPath))) return { ok: false, failure: 'compile-error' }

    const svgArgs = (currentColor: boolean): string[] => [
      '--no-fonts',
      ...(currentColor ? ['--currentcolor'] : []),
      '--bbox=min',
      `--output=${svgPath}`,
      dviPath,
    ]
    let converted = await runProcess('dvisvgm', svgArgs(true), { cwd: dir, env, timeoutMs: DVISVGM_TIMEOUT_MS, signal })
    if (converted.code !== 0 && !converted.aborted && !converted.timedOut && converted.spawnError === undefined) {
      // Older dvisvgm builds reject --currentcolor; the SVG then carries
      // literal #000, which the rasterizer recolours just the same.
      await rm(svgPath, { force: true }).catch(() => {})
      converted = await runProcess('dvisvgm', svgArgs(false), { cwd: dir, env, timeoutMs: DVISVGM_TIMEOUT_MS, signal })
    }
    if (converted.aborted) return { ok: false, failure: 'aborted' }
    if (converted.timedOut) return { ok: false, failure: 'timeout' }
    if (converted.spawnError !== undefined) return { ok: false, failure: 'engine-unavailable' }
    if (converted.code !== 0) return { ok: false, failure: 'svg-error' }
    const info = await stat(svgPath).catch(() => undefined)
    if (info === undefined || !info.isFile()) return { ok: false, failure: 'svg-error' }
    if (info.size > MAX_SVG_BYTES) return { ok: false, failure: 'output-too-large' }
    const svg = await readFile(svgPath, 'utf8')
    if (unsafeSvg(svg)) return { ok: false, failure: 'svg-error' }
    const dimensions = svgDimensions(svg)
    if (dimensions === undefined) return { ok: false, failure: 'svg-error' }
    return { ok: true, key, svg: { svg, ...dimensions } }
  } catch {
    return { ok: false, failure: 'compile-error' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() === true
}

/** Defence in depth on the SVG sharp will parse; dvisvgm output is local and path-only. */
function unsafeSvg(svg: string): boolean {
  return /<script\b|<foreignObject\b|<image\b|\son[a-z]+\s*=|javascript:|href\s*=\s*['"]https?:|url\(\s*['"]?https?:/iu.test(svg)
}

function svgDimensions(svg: string): { widthPt: number; heightPt: number } | undefined {
  const root = /<svg\b[^>]*>/u.exec(svg)?.[0]
  if (root === undefined) return undefined
  const width = /\bwidth\s*=\s*['"]\s*([\d.]+)\s*(?:pt)?\s*['"]/u.exec(root)?.[1]
  const height = /\bheight\s*=\s*['"]\s*([\d.]+)\s*(?:pt)?\s*['"]/u.exec(root)?.[1]
  if (width === undefined || height === undefined) return undefined
  const widthPt = Number(width)
  const heightPt = Number(height)
  return Number.isFinite(widthPt) && Number.isFinite(heightPt) && widthPt > 0 && heightPt > 0
    ? { widthPt, heightPt }
    : undefined
}

interface RunOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

/** Spawn one command, bound its output, and kill the process group on timeout/abort. */
function runProcess(command: string, args: readonly string[], options: RunOptions): Promise<ProcessResult> {
  return new Promise(resolve => {
    if (options.signal?.aborted === true) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, spawnError: undefined })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: a new process group lets the timeout kill TeX's own children
        // (fonts, or a shell-escape attempt in a misconfigured install).
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: String(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut, aborted, spawnError })
    }
    const kill = (): void => {
      const pid = child.pid
      if (pid === undefined) return
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
          killer.on('error', () => {})
        } catch {
          // Fall through to child.kill.
        }
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        return
      }
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_PROCESS_OUTPUT_BYTES) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_PROCESS_OUTPUT_BYTES) stderr += String(chunk)
    })
    child.on('error', (error: Error) => {
      finish(null, error.message)
    })
    child.on('close', (code: number | null) => {
      finish(code)
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
