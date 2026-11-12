/** Match a partial checkpoint to its durable summary, never to framing prose. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export class CompactionPreviews {
  private readonly summaries = new Map<string, string>()

  observe(event: SessionEvent): void {
    const type = (event as { type: string }).type
    if (type !== 'compaction/summary' && type !== 'compaction/end') return
    const data = event.data as { compactionId?: unknown; summary?: unknown }
    if (typeof data.compactionId !== 'string') return
    if (type === 'compaction/end') {
      this.summaries.delete(data.compactionId)
      return
    }
    if (!Array.isArray(data.summary)) return
    const text = data.summary.flatMap((block: unknown) => {
      if (block === null || typeof block !== 'object') return []
      const item = block as { type?: unknown; text?: unknown }
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    }).join('\n').trim()
    if (text) this.summaries.set(data.compactionId, text)
  }

  take(source: { kind: string }): string | undefined {
    if (source.kind !== 'spine-checkpoint') return undefined
    const id = (source as { compactionId?: unknown }).compactionId
    if (typeof id !== 'string') return undefined
    const text = this.summaries.get(id)
    this.summaries.delete(id)
    return text
  }

  clear(): void {
    this.summaries.clear()
  }
}
