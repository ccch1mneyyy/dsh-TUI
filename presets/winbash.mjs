/**
 * custom-bash (winbash) — the Windows-capable full-featured `bash` tool:
 * foreground execution, background jobs, and promote-on-timeout, with the
 * model-facing behavior aligned to the official @deepseek-ai/dsh-tool-bash.
 *
 * WHY this file exists: the official executor (`dsh-bash-local`, the shell
 * seam behind `dsh-tool-bash`) is POSIX-only — its README states "the bash
 * binary is hardcoded and the underlying service's group semantics are POSIX;
 * Windows is unsupported" — and the official persistent bash needs a PTY
 * backend that is linux/darwin-only. This plugin therefore talks to the
 * cross-platform `ctx.subprocess` seam directly (spawning Git Bash) and
 * adapts the process handle onto the generic job registry (`ctx.jobs`),
 * so `run_in_background`, `job_output`/`job_kill`, and the
 * still-running-hand-off work exactly like the official bash/pwsh tools.
 *
 * Lineage: presets/liangshen/custom-bash.mjs (foreground-only; that copy is
 * untouched and keeps serving the liangshen preset's bootstrap anchor). The
 * executable-resolution chain below is carried over verbatim from it.
 *
 * Semantics (aligned with the official tool where noted):
 * - Each call runs `bash -c <command>` in a fresh shell; state never persists.
 * - `run_in_background: true` admits a job via `registry.start` and returns
 *   the id at once; no timeout applies to background runs.
 * - A foreground call with the registry composed is registered as a job from
 *   its start; when its wait times out the job keeps running and the call
 *   returns the promoted hand-off text (official promoteOnTimeout behavior).
 * - Non-zero exits are reported as `[exit code: N]` markers for the model
 *   to interpret, not surfaced as tool errors; only infrastructure failures
 *   (spawn errors, aborts) throw.
 * - Without a job registry the tool is foreground-only and the registered
 *   tool-level timeout kills the command (the liangshen behavior).
 *
 * Self-contained by design: node: built-ins only. `presentCall` and
 * `presentResult` are native `ctx.tools.register` fields (same shape the
 * official pwsh tool registers), so no framework import is needed.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'custom-bash'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_TIMEOUT_MS = 600000
const DEFAULT_MAX_OUTPUT_BYTES = 64000
const GRACE_MS = 3000

// ─────────────────────────────────────────────────────────────────────────────
// Git Bash executable resolution (carried over verbatim from the liangshen
// preset's custom-bash; explicit override first, then the git tree, then the
// conventional roots; the WSL launcher is always rejected).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The explicit override, if any: `config.bashPath`, else the winbash
 * environment variable, else (for compatibility) the liangshen one.
 */
function explicitBashPath(config, environment) {
  const names = [config.bashPath, environment.DSH_TUI_WINBASH_BASH_PATH, environment.DSH_TUI_LIANGSHEN_BASH_PATH]
  for (const value of names) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function addCandidate(candidates, seen, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return
  const key = candidate.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  candidates.push(candidate)
}

/** Return conventional Git Bash locations in deterministic order (explicit config first). */
export function windowsBashCandidates(config = {}, environment = process.env) {
  const explicit = explicitBashPath(config, environment)
  if (explicit !== undefined) return [explicit]

  const candidates = []
  const seen = new Set()
  for (const root of [
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
  ]) {
    if (typeof root !== 'string' || root.length === 0) continue
    addCandidate(candidates, seen, `${root}\\Git\\bin\\bash.exe`)
    addCandidate(candidates, seen, `${root}\\Git\\usr\\bin\\bash.exe`)
  }
  if (typeof environment.LOCALAPPDATA === 'string' && environment.LOCALAPPDATA.length > 0) {
    addCandidate(candidates, seen, `${environment.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`)
    addCandidate(candidates, seen, `${environment.LOCALAPPDATA}\\Programs\\Git\\usr\\bin\\bash.exe`)
  }
  // Scoop keeps Git under its own root; SCOOP is exported by some setups, but
  // the per-user default location works without it.
  const scoopRoots = []
  if (typeof environment.SCOOP === 'string' && environment.SCOOP.length > 0) {
    scoopRoots.push(environment.SCOOP)
  }
  if (typeof environment.USERPROFILE === 'string' && environment.USERPROFILE.length > 0) {
    scoopRoots.push(`${environment.USERPROFILE}\\scoop`)
  }
  for (const root of scoopRoots) {
    addCandidate(candidates, seen, `${root}\\apps\\git\\current\\bin\\bash.exe`)
    addCandidate(candidates, seen, `${root}\\apps\\git\\current\\usr\\bin\\bash.exe`)
  }
  addCandidate(candidates, seen, 'bash')
  return candidates
}

/** Windows' System32 bash.exe is a WSL launcher, not the Git Bash executor. */
export function isWindowsSubsystemLauncher(path) {
  return /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(path)
}

/**
 * Scoop-style shim launchers keep the real target in a sibling `.shim` text
 * file (`path = "..."`); follow it so a PATH-resolved git.exe still yields
 * its installation tree.
 */
export function resolveShimTarget(exePath, reader = readFileSync) {
  for (const sidecar of [exePath.replace(/\.exe$/i, '') + '.shim', `${exePath}.shim`]) {
    try {
      const text = reader(sidecar, 'utf8')
      const match = text.match(/^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/mi)
      if (match !== null) return match[1]
    } catch { /* not a shim launcher */ }
  }
  return exePath
}

/** Bash candidates derived from a git.exe inside a Git for Windows tree. */
export function bashCandidatesFromGit(gitPath) {
  if (typeof gitPath !== 'string' || gitPath.length === 0) return []
  const parts = gitPath.replace(/\//g, '\\').split('\\').filter((part) => part.length > 0)
  if (parts.at(-1)?.toLowerCase() !== 'git.exe') return []
  const roots = []
  const push = (root) => {
    if (root.length > 0 && !roots.includes(root)) roots.push(root)
  }
  // <root>\cmd\git.exe and <root>\bin\git.exe -> <root>
  if (parts.length >= 3) push(parts.slice(0, -2).join('\\'))
  // <root>\mingw64\bin\git.exe -> <root>; a plain <root>\cmd layout must not
  // also strip its real root.
  if (parts.length >= 5
    && parts.at(-2)?.toLowerCase() === 'bin'
    && /^mingw(32|64)$/.test(parts.at(-3) ?? '')) {
    push(parts.slice(0, -3).join('\\'))
  }
  const candidates = []
  for (const root of roots) {
    candidates.push(`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`)
  }
  return candidates
}

/**
 * Follow the PATH-visible git executable to its installation tree: every
 * Windows Git install ships git-bash next to git, wherever it was installed,
 * so this covers installer, portable, and Scoop layouts without hardcoding.
 */
async function gitTreeCandidates(subprocess, failures) {
  let gitPath
  try {
    gitPath = await subprocess.resolveExecutable('git')
  } catch (error) {
    failures.push(`git: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  return bashCandidatesFromGit(resolveShimTarget(gitPath))
}

/** Resolve Git Bash without accidentally accepting the WSL compatibility shim. */
export async function resolveWindowsBash(subprocess, config = {}, environment = process.env) {
  const failures = []
  const explicit = explicitBashPath(config, environment)
  const candidates = explicit !== undefined
    // An explicit path is honored as-is: never silently substitute a guess.
    ? [explicit]
    : [...await gitTreeCandidates(subprocess, failures), ...windowsBashCandidates(config, environment)]
  for (const candidate of candidates) {
    try {
      const resolved = await subprocess.resolveExecutable(candidate)
      if (isWindowsSubsystemLauncher(resolved)) {
        failures.push(`${candidate}: resolved to the Windows Subsystem for Linux launcher`)
        continue
      }
      return resolved
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Git Bash executable unavailable (${failures.join('; ')})`)
}

function warn(ctx, message) {
  try {
    ctx.logger.warn(message)
  } catch {
    // Logger unavailable — registration is skipped either way.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model-facing rendering (shapes aligned with the official dsh-tool-bash).
// ─────────────────────────────────────────────────────────────────────────────

/** Read one collected stream of a settled process into a value-stream pair. */
function streamValue(handle, channel) {
  const reader = handle?.collected?.[channel]
  if (reader === undefined || typeof reader.readFrom !== 'function') {
    return { text: '', truncated: false }
  }
  try {
    const chunk = reader.readFrom(0)
    return {
      text: typeof chunk?.text === 'string' ? chunk.text : '',
      truncated: chunk?.lossy === true,
    }
  } catch {
    return { text: '', truncated: false }
  }
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
 * errored — the model decides how to react (official semantics).
 */
function renderResult(result) {
  let body = result.stdout.text
  if (result.stderr.text.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${result.stderr.text}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0 && result.exitCode !== null) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** The promoted hand-off text (official wording). */
function renderPromoted(promoted) {
  return `${promoted.output.length > 0 ? promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n` : ''}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.`
}

/** Map an execute() value onto the text block the model reads. */
function renderValue(value) {
  if (value?.kind === 'background') return `started background job ${value.jobId}`
  if (value?.kind === 'promoted') return renderPromoted(value)
  if (value?.kind === 'foreground') return renderResult(value)
  return String(value)
}

/**
 * Reverse the exit-status markers renderResult appends, so presentResult can
 * split a rendered body from its exit facts (small local stand-in for the
 * official dsh-shell parseExitStatus).
 */
function parseExitStatus(raw) {
  const lines = raw.split('\n')
  const exit = {}
  let index = lines.length - 1
  while (index >= 0) {
    const line = lines[index]
    let match
    if ((match = line.match(/^\[exit code: (\d+)\]$/)) !== null) {
      if (exit.exitCode === undefined) exit.exitCode = Number(match[1])
      index -= 1
      continue
    }
    if ((match = line.match(/^\[killed by signal: (.+)\]$/)) !== null) {
      if (exit.signal === undefined) exit.signal = match[1]
      index -= 1
      continue
    }
    if (/^\[timed out after \d+ms\]$/.test(line) || /^\[stopped: .+\]$/.test(line)) {
      index -= 1
      continue
    }
    break
  }
  while (index >= 0 && lines[index] === '') index -= 1
  return { body: lines.slice(0, index + 1).join('\n'), ...exit }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic-job adaptation for subprocess handles (shapes follow the official
// dsh-tool-bash background adaptation).
// ─────────────────────────────────────────────────────────────────────────────

/** Map a settled subprocess onto the job-outcome vocabulary the registry records. */
function processOutcome(settled, aborted) {
  if (aborted) {
    return {
      status: 'killed',
      detail: settled?.signal != null ? `signal: ${settled.signal}` : 'killed before exit',
    }
  }
  return { status: 'completed', detail: `exit code: ${settled?.exitCode ?? 0}` }
}

/**
 * The process's non-consuming stream readers as registry pull sources. They
 * bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job; a read before the spawn yields nothing, and the
 * pump keeps the model's consuming cursor untouched.
 */
function processSources(procRef) {
  const source = (channel) => ({
    channel,
    read: (fromByte) => {
      const reader = procRef()?.collected?.[channel]
      if (reader === undefined || typeof reader.readFrom !== 'function') {
        return { text: '', nextOffset: fromByte, lossy: false }
      }
      try {
        const chunk = reader.readFrom(fromByte)
        return {
          text: typeof chunk?.text === 'string' ? chunk.text : '',
          nextOffset: typeof chunk?.nextOffset === 'number' ? chunk.nextOffset : fromByte,
          lossy: chunk?.lossy === true,
        }
      } catch {
        return { text: '', nextOffset: fromByte, lossy: false }
      }
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * Adapt asynchronous process preparation after job admission without exposing
 * a partial process: job-owned cancellation, completion including settlement.
 */
function processJob(start, outcome) {
  const controller = new AbortController()
  let process
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      try { process?.kill?.() } catch { /* signal abort drives the subprocess service */ }
    },
    done: (async () => {
      let settled
      try {
        process = await start(controller.signal)
        try { if (controller.signal.aborted) process.kill?.() } catch { /* already settling */ }
        settled = await process.done
        return outcome(process, settled, controller.signal.aborted)
      } catch (error) {
        // A cancelled run settles as killed whichever way the teardown
        // surfaces (the subprocess seam rethrows the abort as an error
        // once the process was already running): the intent was the kill.
        return {
          status: controller.signal.aborted ? 'killed' : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    })(),
  }
}

/**
 * The ring chunks of one consuming registry read as the shell tools render a
 * process read: stdout chunks in order, then every stderr chunk in one
 * `[stderr]` section.
 */
function ringDelta(chunks) {
  const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/** Append the dropped-output notice when the model cursor fell behind the ring. */
function withNotices(delta, lossy) {
  if (!lossy) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}[some output was dropped from memory]`
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entry.
// ─────────────────────────────────────────────────────────────────────────────

/** Register the model-facing `bash` tool. */
export async function apply(ctx, config) {
  const source = config === undefined ? {} : config
  const defaultTimeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = Number.isSafeInteger(source.maxTimeoutMs) && source.maxTimeoutMs > 0
    ? Math.max(source.maxTimeoutMs, defaultTimeoutMs)
    : DEFAULT_MAX_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(source.maxOutputBytes) && source.maxOutputBytes > 0 ? source.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES
  const enableRunInBackground = source.enableRunInBackground !== false
  const promote = source.promoteOnTimeout !== false
  const graceMs = Number.isSafeInteger(source.graceMs) && source.graceMs > 0 ? source.graceMs : GRACE_MS

  let bashPath
  try {
    bashPath = await resolveWindowsBash(ctx.subprocess, source)
  } catch (error) {
    // Skip registration on a miss: an absent `bash` in the assembled catalog
    // makes tool-bootstrap fail open to the full catalog, while a registered
    // tool that cannot spawn would fail on every call mid-session.
    warn(ctx, `custom-bash: ${error instanceof Error ? error.message : String(error)} — the Windows bash tool is not registered; the bootstrap filter will expose the full catalog`)
    return
  }

  const bashDescription = (background, promoteOnTimeout) => [
    'Run commands in a bash shell (Git Bash on Windows).',
    '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
    "* State does NOT persist across command calls: each call runs in a fresh shell — chain steps with && or ; inside one command.",
    "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
    '* Please avoid commands that may produce a very large amount of output.',
    '* Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on.',
    '* Windows drives are /d/code/... in this shell; quote native Windows paths.',
    '* NOTE: runs without OS sandbox confinement on Windows (no landlock); treat output as untrusted.',
    ...(background ? [
      '* Pass `run_in_background: true` to run long commands as background jobs (collect with job_output, stop with job_kill); no timeout applies to background runs.',
      ...(promoteOnTimeout ? ['* A foreground command that outlives its timeout keeps running as its background job instead of being killed.'] : []),
    ] : []),
  ].join('\n')

  /**
   * One registration of the `bash` tool. With a registry, every call
   * registers its process as a job at its start; without one the tool is
   * foreground-only and the tool-level timeout kills the command.
   */
  const makeTool = (jobs) => {
    const background = jobs !== undefined
    const foregroundPromote = background && promote

    /** Register the command as a job; the process spawns inside the starter, after admission. */
    const startJob = (registry, args, exec, workdir) => {
      let proc
      let stopped
      return {
        id: registry.start({
          kind: 'bash',
          label: args.command,
          ...(exec?.agent !== undefined ? { owner: exec.agent.id } : {}),
          output: processSources(() => proc),
          run: () => {
            const hooks = processJob(
              (signal) => {
                proc = ctx.subprocess.spawn({
                  argv: [bashPath, '-c', args.command],
                  ...(workdir !== undefined ? { cwd: workdir } : {}),
                  stdio: {
                    stdin: 'ignore',
                    stdout: { maxBytes: maxOutputBytes },
                    stderr: { maxBytes: maxOutputBytes },
                  },
                  signal,
                  graceMs,
                })
                return proc
              },
              (_started, settled, aborted) => processOutcome(settled, aborted),
            )
            return {
              done: hooks.done,
              cancel: (reason) => {
                stopped = reason
                hooks.cancel(reason)
              },
            }
          },
        }),
        process: () => proc,
        stopped: () => stopped,
      }
    }

    /** Wait on a registered foreground command until it settles or the timeout passes. */
    const waitOnJob = async (registry, attached, exec, timeoutMs) => {
      const owner = exec?.agent?.id
      /**
       * Stop the job on this call's own account and stay on it until it
       * settles, so the settlement is awaited and no completion notice
       * follows a result this call already carries; the record then leaves
       * with the call, as the model never saw the id.
       */
      const stop = async (reason) => {
        try { registry.kill(attached.id, owner, reason) } catch { /* already settled */ }
        let settled
        try { settled = await registry.wait(attached.id, timeoutMs, owner) } catch { settled = undefined }
        if (settled !== undefined && settled.status !== 'running' && settled.status !== 'stopping') {
          try { registry.remove(attached.id, owner) } catch { /* already removed */ }
        }
        return settled
      }
      let view
      try {
        view = await registry.wait(attached.id, timeoutMs, owner, exec?.signal)
      } catch {
        await stop('tool call aborted')
        throw new Error('tool call aborted')
      }
      if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
        await stop('timed out during preparation')
        return {
          kind: 'foreground',
          exitCode: null,
          signal: null,
          timedOut: true,
          aborted: false,
          timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }
      }
      if (view.status === 'running' || view.status === 'stopping') {
        let read
        try { read = registry.read(attached.id, owner) } catch { read = { chunks: [], lossy: false } }
        return {
          kind: 'promoted',
          jobId: attached.id,
          timeoutMs,
          output: withNotices(ringDelta(read.chunks ?? []), read.lossy === true),
        }
      }
      try { registry.remove(attached.id, owner) } catch { /* already removed */ }
      const proc = attached.process()
      if (proc === undefined) throw new Error(typeof view.detail === 'string' ? view.detail : 'bash process failed to start')
      let settled
      try {
        settled = await proc.done
      } catch (error) {
        throw new Error(`bash spawn failed: ${String(error)}`)
      }
      const stopped = attached.stopped()
      return {
        kind: 'foreground',
        exitCode: settled.exitCode ?? null,
        signal: settled.signal ?? null,
        timedOut: false,
        aborted: false,
        timeoutMs,
        stdout: streamValue(proc, 'stdout'),
        stderr: streamValue(proc, 'stderr'),
        ...(stopped !== undefined ? { stopped } : {}),
      }
    }

    return {
      name: 'bash',
      description: bashDescription(background, foregroundPromote),
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute (`bash -c` string domain).',
          },
          description: {
            type: 'string',
            description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "List files in current directory"; "git status" → "Show working tree status".',
          },
          workdir: {
            type: 'string',
            description: 'Optional working directory; defaults to the session cwd; a relative path is resolved against it.',
          },
          timeoutMs: {
            type: 'number',
            description: foregroundPromote
              ? 'Timeout in milliseconds. The tool applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
              : 'Timeout in milliseconds. The tool applies its configured default and cap, and kills the command on expiry.',
          },
          ...(background ? {
            run_in_background: {
              type: 'boolean',
              description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No background execution timeout applies.',
            },
          } : {}),
        },
        required: ['command', 'description'],
        additionalProperties: false,
      },
      // With the registry composed the tool-level timeout is the hard cap
      // (the per-call timeout promotes first); without one it is the kill.
      timeoutMs: background ? maxTimeoutMs : defaultTimeoutMs,
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      async execute(args, exec) {
        if (typeof args.command !== 'string' || args.command.trim().length === 0) {
          throw new Error('invalid command: expected a non-empty string')
        }
        if (typeof args.description !== 'string' || args.description.trim().length === 0) {
          throw new Error('invalid description: expected a non-empty string')
        }
        if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
          throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
        }
        const sessionCwd = exec?.agent?.session?.header?.cwd
        let workdir = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : sessionCwd
        if (workdir !== undefined && !isAbsolute(workdir) && sessionCwd !== undefined) {
          workdir = `${sessionCwd}${sep}${workdir}`
        }
        const timeoutMs = Math.min(args.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs)

        if (args.run_in_background === true) {
          if (!enableRunInBackground) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
          if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          if (exec?.signal?.aborted) throw new Error('tool call aborted')
          return { kind: 'background', jobId: startJob(jobs, args, exec, workdir).id }
        }

        if (foregroundPromote) {
          let attached
          try {
            attached = startJob(jobs, args, exec, workdir)
          } catch (error) {
            warn(ctx, `custom-bash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
          }
          if (attached !== undefined) return waitOnJob(jobs, attached, exec, timeoutMs)
        }

        // Foreground without a registry (or when registration was refused):
        // the liangshen behavior — spawn, wait, report.
        const signal = exec?.signal
        let handle
        let outcome
        try {
          handle = ctx.subprocess.spawn({
            argv: [bashPath, '-c', args.command],
            ...(workdir !== undefined ? { cwd: workdir } : {}),
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: maxOutputBytes },
              stderr: { maxBytes: maxOutputBytes },
            },
            ...(signal !== undefined ? { signal } : {}),
            graceMs,
          })
          outcome = await handle.done
        } catch (error) {
          throw new Error(`bash spawn failed: ${String(error)}`)
        }
        return {
          kind: 'foreground',
          exitCode: outcome.exitCode ?? null,
          signal: outcome.signal ?? null,
          timedOut: false,
          aborted: false,
          timeoutMs,
          stdout: streamValue(handle, 'stdout'),
          stderr: streamValue(handle, 'stderr'),
        }
      },
      presentCall: (args) => {
        if (args.run_in_background === true) {
          return {
            card: 'generic',
            title: args.command,
            kind: 'execute',
            rawInput: args.command,
            content: [{ type: 'text', text: args.description }],
          }
        }
        return {
          card: 'terminal',
          title: args.command,
          description: args.description,
          ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
        }
      },
      presentResult: (args, result) => {
        const block = result.content.length === 1 ? result.content[0] : undefined
        if (block === undefined || block.type !== 'text') return undefined
        const raw = block.text
        const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true
        const isPromoted = result.value?.kind === 'promoted'
        if (isBackground || isPromoted || result.isError) {
          return {
            card: 'generic',
            content: [{
              type: 'text',
              text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\``,
            }],
          }
        }
        const { body, ...exit } = parseExitStatus(raw)
        return { card: 'terminal', output: body, ...exit }
      },
    }
  }

  if (!enableRunInBackground) {
    ctx.tools.register(makeTool(undefined))
    return
  }
  let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(makeTool(undefined)) : undefined
  ctx.inject(['jobs'], (jobCtx) => {
    if (typeof foregroundOnly === 'function') {
      foregroundOnly()
      foregroundOnly = undefined
    }
    const unregister = ctx.tools.register(makeTool(jobCtx.jobs))
    jobCtx.effect(() => () => {
      unregister()
      if (ctx.fiber?.state === 2) foregroundOnly = ctx.tools.register(makeTool(undefined))
    })
  })
}
