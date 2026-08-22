/**
 * Assistant text row for the pi-tui transcript (plan §1.3, WP-03).
 *
 * Port of `src/components/messages/AssistantTextMessage.tsx` (+ the
 * streaming branch of MessageList): a `●` bullet in theme `text` followed by
 * the markdown body, continuation lines hanging under the text. The body is
 * rendered by the fork's `Markdown` component (Kimi's
 * `assistant-message.ts` pattern: one Markdown child per row, `setText` on
 * content change, both caches keyed on width).
 *
 * Deliberate simplifications vs the old React path:
 * - `StreamingMarkdown`'s stable-prefix incremental layout is NOT ported —
 *   a streaming row re-renders its full markdown per chunk.
 * - The Ctrl+O metadata line (timestamp + model, old `MessageMetadata`) is
 *   dropped: the model name is not part of `TranscriptProjection`.
 */
import { Markdown } from '../../public.js'
import { BLACK_CIRCLE } from '../../../cc/figures.js'
import { stripPromptXMLTags } from '../../../cc/markdown.js'
import { stripNarration } from '../../../utils/narration.js'
import { createTranscriptMarkdownTheme } from './markdown-theme.js'
import { fg, trimPad } from './style.js'
import { CachedRow } from './shared.js'

export class AssistantRow extends CachedRow {
  private markdown: Markdown | undefined

  override invalidate(): void {
    super.invalidate()
    this.markdown?.invalidate()
  }

  protected build(width: number, marginTop: boolean): string[] {
    // The ⏵ self-narration line is stripped: the live working line on the
    // status bar already shows it (same contract as the old row).
    const text = stripNarration(this.row.text).trim()
    const bullet = `${fg('text', BLACK_CIRCLE)} `
    const body = text === '' ? [] : this.renderMarkdown(text, Math.max(1, width - 2))
    const out: string[] = marginTop ? [''] : []
    if (body.length === 0) {
      out.push(bullet)
      return out
    }
    for (let index = 0; index < body.length; index++) {
      out.push((index === 0 ? bullet : '  ') + trimPad(body[index]!))
    }
    return out
  }

  private renderMarkdown(text: string, width: number): string[] {
    if (this.markdown === undefined) {
      this.markdown = new Markdown(text, 0, 0, createTranscriptMarkdownTheme(), undefined, {
        transform: (source) => stripPromptXMLTags(source),
      })
    } else {
      this.markdown.setText(text)
    }
    return this.markdown.render(width)
  }
}
