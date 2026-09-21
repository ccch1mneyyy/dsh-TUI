/**
 * Windows console code page: make the console speak UTF-8 before the first
 * frame is painted.
 *
 * Why this exists at all: the dsh subprocess layer decodes EVERY child stream
 * as UTF-8 (`dsh-subprocess-local`, `Buffer.concat(chunks).toString('utf8')`)
 * with no charset fallback, while Windows-native children (`powershell.exe`,
 * `cmd.exe`, `git.exe`, `chcp.com` itself) encode what they write according to
 * the console output code page they are attached to. On a zh-CN/ja-JP Windows
 * that page defaults to the OEM page (measured here: ACP 936, OEMCP 936), so a
 * plain `Write-Output '中文'` comes back as GBK bytes (`d6 d0 ce c4`) that the
 * decoder turns into replacement characters. Measured on this machine
 * 2026-09-21, same command, same tool, only the console differs:
 *
 *   no console (windowsHide, OEM default)  -> d6 d0 ce c4   (GBK)
 *   attached to a 65001 console            -> e4 b8 ad e6 96 87  (UTF-8)
 *
 * Why it has to happen HERE: the switch is one-way console state, and changing
 * the page makes the console re-encode and re-emit its whole buffer. Landing
 * after the first frame, that re-emission overwrites what the TUI has painted,
 * and the diffing renderer never repaints cells it believes are unchanged — the
 * splash then loses its static rows (model / cwd / tip) until Ctrl+L (field
 * report 2026-09-21, sandbox-reproduced). Before the first frame there is
 * nothing to overwrite, and the page is console-wide, so every later child —
 * the agent's shells included — inherits it. The page persists for the life of
 * the console, so one switch is enough: re-issuing `chcp` per command (a plugin
 * workaround this replaces) buys nothing and can trigger that same re-emission
 * mid-session.
 *
 * Fail-open and silent by design: a host without `chcp.com`, a console that
 * refuses the switch, and every non-Windows platform keep their previous
 * behaviour. Nothing here may write to stdout/stderr — the TUI owns the frame.
 *
 * @module dsh-tui/terminal-utils/consoleCodePage
 */
import { spawnSync } from 'node:child_process'

/** The page every dsh child stream is decoded as. */
export const UTF8_CODE_PAGE = 65001

/** Structural spawner type: tests drive a fabricate console through this. */
export type ConsoleSpawnSync = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => { status?: number | null; stdout?: unknown } | null | undefined

export interface ConsoleCodePageResult {
  /** Page observed before the switch; undefined when unreadable. */
  before: number | undefined
  /** Page observed after the switch; undefined when unreadable. */
  after: number | undefined
  /** True when a `chcp.com` switch was actually issued. */
  switched: boolean
}

/**
 * Parse the code page number out of `chcp` output.
 *
 * The text around the number is localised ("Active code page: 65001",
 * "活动代码页: 65001") and may already arrive mangled, so only the digits are
 * trusted: the first 2–5 digit run wins.
 *
 * @param output - Raw `chcp.com` stdout (string or bytes).
 * @returns The code page, or undefined when unparseable.
 */
export function parseCodePage(output: unknown): number | undefined {
  const text = typeof output === 'string'
    ? output
    : output instanceof Uint8Array
      ? Buffer.from(output).toString('utf8')
      : ''
  const match = /(\d{2,5})/.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined
}

/**
 * Options seam: both fields exist for tests, production passes nothing.
 */
export interface EnsureUtf8ConsolePageOptions {
  platform?: NodeJS.Platform
  /** Spawner to use; defaults to `node:child_process.spawnSync`. */
  spawnSync?: ConsoleSpawnSync
}

/**
 * Bring the console this process is attached to to the UTF-8 code page.
 *
 * Deliberately WITHOUT `windowsHide`: libuv maps that flag to
 * `CREATE_NO_WINDOW`, whose child has no console handle at all, and `chcp.com`
 * then has nothing to switch (that is why a host-side attempt always reported
 * the old page back). `chcp.com` is a console program attached to an existing
 * console here, so no window appears and its stdio is piped/ignored anyway.
 *
 * @param options - Test seam (platform + spawner).
 * @returns The observed pages and whether a switch was issued.
 */
export function ensureUtf8ConsolePage(
  options: EnsureUtf8ConsolePageOptions = {},
): ConsoleCodePageResult {
  const platform = options.platform ?? process.platform
  const spawn = options.spawnSync ?? (spawnSync as unknown as ConsoleSpawnSync)

  if (platform !== 'win32') return { before: undefined, after: undefined, switched: false }

  const read = (): number | undefined => {
    try {
      return parseCodePage(spawn('chcp.com', [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 5000,
      })?.stdout)
    } catch {
      return undefined
    }
  }

  const before = read()
  // Already right: never issue a needless write — it re-emits the buffer.
  if (before === UTF8_CODE_PAGE) return { before, after: before, switched: false }

  let switched = false
  try {
    switched = spawn('chcp.com', [String(UTF8_CODE_PAGE)], {
      stdio: 'ignore',
      timeout: 5000,
    })?.status === 0
  } catch {
    switched = false
  }

  return { before, after: read(), switched }
}
