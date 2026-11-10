import type { SubagentState } from '../adapter/ports/channel-view.js'

/** Whether a row describes an external execution.
 *
 *  `mode: 'external'` is the durable catalog fact and survives replay;
 *  `local: false` is the bus fact from `subagent/start`, available from the
 *  first live frame, before the catalog arrives. Both mean the same thing:
 *  the row has no local child session to continue or read. It can still be
 *  interrupted — the upstream `interrupt()` aborts and disposes the external
 *  run itself. */
export function isExternalExecution(subagent: Pick<SubagentState, 'mode' | 'local'>): boolean {
  return subagent.mode === 'external' || subagent.local === false
}
