/**
 * The inspector — full detail for the focused row, in a fixed-height slot —
 * ported from the Ink `Inspector.tsx` to a pure string renderer for pi-tui.
 *
 * Two properties matter more than what it shows:
 *
 * **It follows the cursor with no keystroke.** Moving down updates it; there
 * is no "open" step. That is one decision removed from the most common
 * action in the view, and it is the reason a run of rows can be triaged by
 * holding ↓ rather than by opening and closing each one.
 *
 * **Its height never changes.** A pane that grew with its content would
 * resize the frame on every cursor move. Fixed geometry means moving the
 * cursor emits style bytes and nothing else. `Enter` opens the same content
 * as a full-height page, which is a deliberate, once-per-inspection resize.
 */

import { formatDuration } from '../../../trajectory/format.js'
import type { InspectDetail } from '../../../dsh-adapter/trajectory/index.js'
import type { TrajNode } from '../../../dsh-adapter/types.js'
import { clip, fg } from './paint.js'
import { visibleWidth } from '../../public.js'

export interface InspectorProps {
  node: TrajNode | undefined
  detail: InspectDetail | undefined
  /** Rows this pane occupies, borders included. Never varies with content. */
  height: number
  width: number
  /** True when `Enter` has promoted the pane to a full-height reading page. */
  expanded: boolean
  /** First body line to show, for paging an expanded pane. */
  scroll: number
}

interface BodyLine {
  readonly text: string
  readonly tone?: 'error' | 'dim'
  readonly head?: boolean
}

export function renderInspector({ node, detail, height, width, expanded, scroll }: InspectorProps): string[] {
  const bodyHeight = Math.max(1, height - 1)

  if (node === undefined || detail === undefined) {
    return padToHeight([fg('subtle', '—')], height)
  }

  // Flatten every section into display lines up front, so paging and
  // clipping operate on one uniform list.
  const lines: BodyLine[] = []
  for (const section of detail.sections) {
    // A lone section whose heading repeats the pane title (a message row's
    // `assistant` under `assistant`) spends a line saying nothing.
    const redundant =
      detail.sections.length === 1 && section.title.toLowerCase() === detail.title.toLowerCase()
    if (!redundant) lines.push({ text: section.title, tone: section.tone, head: true })
    for (const raw of section.body.split('\n')) {
      // Tabs would break column alignment inside the pane.
      lines.push({ text: raw.replace(/\t/g, '  '), tone: section.tone })
    }
  }

  // The pane always paints exactly `height` rows: one header plus bodyHeight
  // body rows, the last of which becomes the overflow marker when content
  // runs past the slot, and blank padding when it does not.
  const overflow = lines.length - scroll > bodyHeight
  const visibleCount = overflow ? bodyHeight - 1 : bodyHeight
  const clipped = lines.slice(scroll, scroll + visibleCount)
  const hidden = lines.length - scroll - visibleCount
  const status = node.status === 'error' ? 'error' : node.status === 'running' ? 'success' : 'inactive'

  const titleText = `▎${detail.title}`
  const durationText = node.durationMs === undefined ? '' : formatDuration(node.durationMs)
  const factsWidth = Math.max(0, width - visibleWidth(titleText) - visibleWidth(durationText) - 2)
  const header =
    fg(status, titleText, { bold: true }) +
    ' ' +
    fg('subtle', clip(detail.facts.join(' · '), factsWidth)) +
    (durationText === '' ? '' : ' ' + fg(status, durationText))

  const body: string[] = [clip(header, width)]
  for (let index = 0; index < bodyHeight; index++) {
    if (overflow && index === bodyHeight - 1) {
      body.push(fg('subtle', clip(`    …${hidden} more · ${expanded ? 'j/k' : 'enter'}`, width)))
      continue
    }
    const line = clipped[index]
    if (line === undefined) {
      body.push(' ')
      continue
    }
    if (line.head) {
      body.push(clip(fg(line.tone === 'error' ? 'error' : 'permission', `  ${line.text}`, { bold: true }), width))
      continue
    }
    body.push(
      clip(
        fg(
          line.tone === 'error' ? 'error' : line.tone === 'dim' ? 'subtle' : 'inactiveShimmer',
          `    ${line.text}`,
        ),
        width,
      ),
    )
  }
  return padToHeight(body, height)
}

/** Fill the pane with blank lines so its row count never moves. */
function padToHeight(lines: string[], height: number): string[] {
  while (lines.length < height) lines.push(' ')
  return lines
}
