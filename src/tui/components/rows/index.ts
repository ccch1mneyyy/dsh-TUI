/**
 * Row-renderer factory for the transcript (plan §1.3, WP-03).
 *
 * Maps `ChatRow.kind` to its imperative row component. Row components are
 * NOT pi-tui components — `TranscriptView` is; rows are its cached render
 * workers (see `./shared.ts`).
 */
import type { ChatRow } from '../../../dsh-adapter/channel.js'
import type { RowComponent, RowContext } from './shared.js'
import { UserRow } from './user.js'
import { AssistantRow } from './assistant.js'
import { ReasoningRow } from './reasoning.js'
import { ToolCardRow } from './tool.js'
import { CompactRow, InterruptRow, LocalOutputRow, LocalRow, NoticeRow } from './misc.js'
import { SubagentCardRow } from './subagent.js'

export type { RowComponent, RowContext } from './shared.js'
export { rowFingerprint } from './shared.js'

export function createRowComponent(row: ChatRow, ctx: RowContext): RowComponent {
  switch (row.kind) {
    case 'user':
      return new UserRow(row, ctx)
    case 'assistant':
      return new AssistantRow(row, ctx)
    case 'reasoning':
      return new ReasoningRow(row, ctx)
    case 'tool':
      return new ToolCardRow(row, ctx)
    case 'notice':
      return new NoticeRow(row, ctx)
    case 'interrupt':
      return new InterruptRow(row, ctx)
    case 'local':
      return new LocalRow(row, ctx)
    case 'local-output':
      return new LocalOutputRow(row, ctx)
    case 'compact':
      return new CompactRow(row, ctx)
    case 'subagent':
      return new SubagentCardRow(row, ctx)
  }
}
