/**
 * User prompt row for the pi-tui transcript (plan §1.3, WP-03).
 *
 * Port of `src/components/messages/UserPromptMessage.tsx`: `❯ text` in bold
 * `briefLabelYou` gold with no background fill. The wrap is done here (not
 * left to the renderer) so continuation lines get a hanging indent aligned
 * under the text rather than column zero; the width keeps the old 3-cell
 * safety margin against the scroll edge.
 */
import chalk from 'chalk'
import { POINTER } from '../../../cc/figures.js'
import { visibleWidth } from '../../public.js'
import { wrapWidth } from '../../../sessions/format.js'
import { fg } from './style.js'
import { CachedRow } from './shared.js'

export class UserRow extends CachedRow {
  protected build(width: number, marginTop: boolean): string[] {
    const promptPrefix = `${POINTER} `
    const prefixWidth = visibleWidth(promptPrefix)
    const continuation = ' '.repeat(prefixWidth)
    const lines = wrapWidth(this.row.text, Math.max(1, width - prefixWidth - 3))
    const out: string[] = marginTop ? [''] : []
    for (let index = 0; index < lines.length; index++) {
      const prefix = index === 0 ? promptPrefix : continuation
      out.push(chalk.bold(fg('briefLabelYou', prefix + lines[index])))
    }
    return out
  }
}
