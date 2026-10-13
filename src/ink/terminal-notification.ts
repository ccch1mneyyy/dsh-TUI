import { getTerminalFocused } from './terminal-focus-state.js'
import { getNotificationProtocol } from './terminal.js'
import { BEL } from './termio/ansi.js'
import { OSC, osc, wrapForMultiplexer } from './termio/osc.js'
import { logForDebugging } from '../utils/debug.js'

export type TaskNotifications = 'off' | 'unfocused' | 'always'
export type NotificationMethod = 'auto' | 'osc9' | 'bel'

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
      const resolved = method === 'auto' ? getNotificationProtocol() : method
      let sequence: string
      if (resolved === 'osc777') {
        // OSC 777 separates title and body with semicolons; only the body
        // may contain that delimiter. OSC 9 has no separate title field.
        sequence = osc(OSC.GHOSTTY, 'notify', title.replaceAll(';', ' '), message)
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
        sequence = resolved === 'bel' ? BEL : osc(OSC.ITERM2, message ? `${title}: ${message}` : title)
      }
      try {
        stdout.write(resolved === 'bel' ? sequence : wrapForMultiplexer(sequence))
      } catch (error) {
        logForDebugging(`terminal notification failed (${error instanceof Error ? error.message : String(error)})`)
      }
    },
  }
}
