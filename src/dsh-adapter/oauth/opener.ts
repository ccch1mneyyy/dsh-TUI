/**
 * Best-effort host-side conveniences for OAuth flows: opening the default
 * browser and copying short text to the clipboard.
 *
 * pi-ai's flows emit an `auth_url` event whose instructions assume the host
 * opens the browser itself ("A browser window should open…"), because the
 * authorize URL is hundreds of characters — unclickable and practically
 * uncopyable once a terminal panel wraps it (wrap artifacts inside the
 * encoded `redirect_uri` are exactly how hand-copied URLs die with
 * `invalid_authorize_request`). These helpers restore that host contract.
 * Every path is best-effort and never throws: a missing opener or clipboard
 * degrades to the URL staying on screen with a copy action.
 *
 * @module @deepseek-harness-tui/dsh-tui/oauth/opener
 */

import { spawn } from 'node:child_process'

/** The browser-opening command for this platform, or undefined when unknown. */
export function openerFor(url: string): { command: string; args: readonly string[]; verbatim: boolean } | undefined {
  if (process.platform === 'win32') {
    // cmd.exe parses `&` as a command separator, so an unquoted authorize
    // URL (hundreds of chars of `?a=1&b=2…`) is truncated at the first `&`
    // and the browser opens a param-less page — OpenAI answers "missing
    // required parameter". Node only quotes argv containing spaces/quotes,
    // which a URL has neither of, so the protection must be explicit: the
    // whole `start` command rides as ONE verbatim argv token, with the URL
    // double-quoted inside it (`start` treats a leading quoted arg as the
    // window title, hence the empty "" first).
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `start "" "${url}"`],
      verbatim: true,
    }
  }
  if (process.platform === 'darwin') return { command: 'open', args: [url], verbatim: false }
  return { command: 'xdg-open', args: [url], verbatim: false }
}

/**
 * Open `url` in the default browser, detached; the TUI keeps running.
 * @returns whether the opener process could be spawned at all (not whether
 *   a browser eventually appeared — that is not observable here).
 */
export function openInBrowser(url: string): boolean {
  const opener = openerFor(url)
  if (opener === undefined) return false
  try {
    const child = spawn(opener.command, [...opener.args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...(opener.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Feed `text` to one clipboard helper's stdin; resolves whether it exited 0. */
function pipeTo(command: string, args: readonly string[], text: string): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
    child.stdin.on('error', () => resolve(false))
    child.stdin.end(text)
  })
}

/** Clipboard helper candidates per platform, in try order. */
function clipboardCandidates(): readonly { command: string; args: readonly string[] }[] {
  if (process.platform === 'win32') return [{ command: 'clip.exe', args: [] }]
  if (process.platform === 'darwin') return [{ command: 'pbcopy', args: [] }]
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ]
}

/**
 * Copy `text` to the system clipboard, trying this platform's helpers in
 * order. Resolves whether one succeeded; never rejects.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const candidate of clipboardCandidates()) {
    if (await pipeTo(candidate.command, candidate.args, text)) return true
  }
  return false
}
