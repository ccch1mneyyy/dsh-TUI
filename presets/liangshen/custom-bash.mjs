/**
 * custom-bash — a Windows-capable `bash` tool that registers under the SAME
 * name (`bash`) as the official persistent bash, with a Minimal-compatible
 * description, but executes through `ctx.subprocess.spawn` instead of a PTY.
 *
 * WHY: DeepSeek's first-request trajectory anchor keys on the tool SCHEMA
 * matching the RL training distribution (issue #11: persistent
 * bash + str_replace_editor anchored 5/5 at maxTokens=256000, pwsh/read
 * 8/8 standard-like). The official persistent bash uses a PTY, and DSH's PTY
 * backend is linux/darwin-only — `subprocess-local` throws "terminal
 * inspection is unsupported on platform win32". A custom tool that presents
 * the same name and a Minimal-like description but spawns Git Bash through
 * the ordinary (cross-platform) subprocess seam keeps the schema anchor
 * without the PTY dependency.
 *
 * Executable resolution, in order (an explicit entry is the ONLY candidate:
 * a miss fails loudly instead of silently substituting a guess):
 *  1. explicit `config.bashPath` or the `DSH_TUI_LIANGSHEN_BASH_PATH`
 *     environment variable (absolute path to a Git Bash bash.exe);
 *  2. a `git` on PATH followed to its installation tree — every Windows Git
 *     install ships bash next to git, wherever it was installed, so this
 *     covers installer, portable, and Scoop layouts (a Scoop `.shim` sidecar
 *     is followed to the real target) — yielding `<root>\bin\bash.exe` and
 *     `<root>\usr\bin\bash.exe`;
 *  3. conventional install roots (`ProgramFiles`, `ProgramFiles(x86)`,
 *     `%LOCALAPPDATA%\Programs\Git`);
 *  4. Scoop's conventional roots (`%SCOOP%`, else `%USERPROFILE%\scoop`)
 *     under `apps\git\current\` — Scoop does not always export `SCOOP`;
 *  5. bare `bash` on PATH.
 * `C:\Windows\System32\bash.exe` (and Sysnative) is the WSL launcher, not
 * the Git Bash executor: it is ALWAYS rejected, so a PATH lookup can never
 * silently hand the model a WSL shell. Resolution runs ONCE at apply time —
 * a total miss warns and SKIPS registration, so `tool-bootstrap`'s
 * missing-tool path fails open to the full catalog instead of registering a
 * `bash` tool whose every call would fail mid-session.
 *
 * Semantics mirror the official bash tool: `bash -c <command>` in a fresh
 * process, bounded output, non-zero exit reported not thrown. No sandbox
 * confinement on Windows (the sandbox backend is linux-only); the tool
 * description says so. The bootstrap catalog pairs this with
 * `str_replace_editor` (Minimal's two tools).
 */

import { readFileSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'custom-bash'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

/** Tool parameter schema for the model-facing command. */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash -c` string domain).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory; defaults to the session cwd.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

function addCandidate(candidates, seen, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return
  const key = candidate.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  candidates.push(candidate)
}

/** The explicit override, if any: `config.bashPath`, else the environment variable. */
function explicitBashPath(config, environment) {
  for (const value of [config.bashPath, environment.DSH_TUI_LIANGSHEN_BASH_PATH]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
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
      const match = text.match(/^\s*path\s*=\s*"?(.+?)"?\s*$/mi)
      if (match !== null) return match[1]
    } catch { /* not a shim launcher */ }
  }
  return exePath
}

/** Bash candidates derived from a git.exe inside a Git for Windows tree. */
export function bashCandidatesFromGit(gitPath) {
  if (typeof gitPath !== 'string' || gitPath.length === 0) return []
  const parts = gitPath.replace(/\//g, '\\').split('\\').filter(part => part.length > 0)
  if (parts.at(-1)?.toLowerCase() !== 'git.exe') return []
  const roots = []
  const push = root => {
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

/** Register the model-facing `bash` tool. */
export async function apply(ctx, config) {
  const source = config === undefined ? {} : config
  const timeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(source.maxOutputBytes) && source.maxOutputBytes > 0 ? source.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  let bashPath
  try {
    bashPath = await resolveWindowsBash(ctx.subprocess, source)
  } catch (error) {
    // Skip registration on a miss: an absent `bash` in the assembled catalog
    // makes tool-bootstrap fail open to the full catalog, while a registered
    // tool that cannot spawn would fail on every call mid-session.
    warn(ctx, `custom-bash: ${error instanceof Error ? error.message : String(error)} — the Windows bootstrap bash tool is not registered; the bootstrap filter will expose the full catalog`)
    return
  }

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows)',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* You don't have access to the internet via this tool.",
      '* You do have access to a mirror of common linux and python packages via apt and pip.',
      '* State does NOT persist across command calls: each call runs in a fresh shell.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      '* NOTE: runs without OS sandbox confinement on Windows (no landlock); treat output as untrusted.',
    ].join('\n'),
    parameters: commandSchema,
    timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : exec?.agent?.session?.header?.cwd
      const signal = exec?.signal
      const handle = ctx.subprocess.spawn({
        argv: [bashPath, '-c', args.command],
        ...workdir !== undefined ? { cwd: workdir } : {},
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        ...signal !== undefined ? { signal } : {},
        graceMs: 3000,
      })
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        // A spawn-level failure (bad executable, EPERM) surfaces as a throw,
        // which the runtime turns into an isError result.
        throw new Error(`bash spawn failed: ${String(error)}`)
      }
      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // Collected readers may be unavailable on some backends; tolerate.
      }
      const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      const tail = text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`
      if (outcome.exitCode !== 0) {
        // Non-zero exit is a reported failure, not a throw: the model sees the
        // command output plus the exit code.
        throw new Error(tail)
      }
      return { text: tail }
    },
  })
}
