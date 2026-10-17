import { getTerminalFocused } from './terminal-focus-state.js'
import { getNotificationProtocol } from './terminal.js'
import { BEL } from './termio/ansi.js'
import { OSC, osc, wrapForMultiplexer } from './termio/osc.js'
import { logForDebugging } from '../utils/debug.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

export type TaskNotifications = 'off' | 'unfocused' | 'always'
/** How a task completion is delivered: probe the terminal (`auto`), force
 *  OSC 9 or BEL, or ask for the native Windows toast. */
export type NotificationMethod = 'auto' | 'osc9' | 'bel' | 'windows'

// Ghostty 1.2.3 has a 2048-byte OSC buffer. Counting the entire unwrapped
// sequence also reserves the introducer and terminator conservatively.
const MAX_OSC_BYTES = 2048

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const suffix = maxBytes >= 3 ? '…' : ''
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  let out = ''
  let bytes = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const size = Buffer.byteLength(segment)
    if (bytes + size > budget) break
    out += segment
    bytes += size
  }
  return out + suffix
}

/** Terminal-owned notification transport; never writes to redirected output. */
export function createTerminalNotifier(stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>) {
  let condition: TaskNotifications = 'unfocused'
  let method: NotificationMethod = 'auto'
  let notificationId = 0
  return {
    configure(nextCondition: TaskNotifications = 'unfocused', nextMethod: NotificationMethod = 'auto'): void {
      condition = nextCondition
      method = nextMethod
    },
    notify(title: string, message = ''): void {
      if (!stdout.isTTY || condition === 'off' || (condition === 'unfocused' && getTerminalFocused())) return
      // `windows` is a host transport (the native toast), not a terminal
      // sequence, so this notifier resolves it like `auto` - which is also the
      // resolution off Windows.
      const resolved = method === 'auto' || method === 'windows' ? getNotificationProtocol() : method
      let sequence: string
      if (resolved === 'osc777') {
        // OSC 777 separates title and body with semicolons; only the body
        // may contain that delimiter. OSC 9 has no separate title field.
        const titleBudget = MAX_OSC_BYTES - Buffer.byteLength(osc(OSC.GHOSTTY, 'notify', '', ''))
        const safeTitle = truncateUtf8(title.replaceAll(';', ' '), titleBudget)
        const bodyBudget = MAX_OSC_BYTES - Buffer.byteLength(osc(OSC.GHOSTTY, 'notify', safeTitle, ''))
        sequence = osc(OSC.GHOSTTY, 'notify', safeTitle, truncateUtf8(message, bodyBudget))
      } else if (resolved === 'osc99') {
        const id = ++notificationId
        sequence = osc(OSC.KITTY, `i=${id}:d=0:p=title`, title)
        // Kitty caps each raw payload at 2048 UTF-8 bytes. Chunk on code
        // points and mark only the last part done, so it shows one notice.
        const chunks: string[] = []
        let chunk = ''
        let bytes = 0
        for (const character of message) {
          const size = Buffer.byteLength(character)
          if (bytes + size > 2048) { chunks.push(chunk); chunk = ''; bytes = 0 }
          chunk += character
          bytes += size
        }
        chunks.push(chunk)
        sequence += chunks.map((part, index) => osc(OSC.KITTY, `i=${id}:d=${index === chunks.length - 1 ? 1 : 0}:p=body`, part)).join('')
      } else {
        const payload = message ? `${title}: ${message}` : title
        const budget = MAX_OSC_BYTES - Buffer.byteLength(osc(OSC.ITERM2, ''))
        sequence = resolved === 'bel' ? BEL : osc(OSC.ITERM2, truncateUtf8(payload, budget))
      }
      try {
        stdout.write(resolved === 'bel' ? sequence : wrapForMultiplexer(sequence))
      } catch (error) {
        logForDebugging(`terminal notification failed (${error instanceof Error ? error.message : String(error)})`)
      }
    },
  }
}
