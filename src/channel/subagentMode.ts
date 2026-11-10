/** The creation modes a durable `subagent/catalog` fact can carry. `external`
 *  runs in a process this session never owns: no local child session, no
 *  continuation, and no transcript to read back. */
type SubagentCreationMode = 'one-shot' | 'continuable' | 'unknown' | 'external'

/** Whether a row describes an external execution.
 *
 *  `mode` is the durable fact and survives replay; `local: false` is the bus
 *  fact from `subagent/start`, available from the first live frame, before
 *  the catalog arrives. Both mean the same thing: there is no local child
 *  session to continue, interrupt or read. */
export function isExternalExecution(subagent: { readonly mode?: SubagentCreationMode; readonly local?: boolean }): boolean {
  return subagent.mode === 'external' || subagent.local === false
}
