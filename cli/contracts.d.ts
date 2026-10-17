/** Internal adapter contract. No DSH, TUI or rendering types. */
export type OutputFormat = 'text' | 'json' | 'stream-json'
export interface CliRequest {
  kind: 'run' | 'session' | 'models' | 'skills' | 'mcp' | 'auth' | 'capabilities' | 'dsh'
  action?: string
  cwd: string
  profile: string
  patches: string[]
  output: OutputFormat
  timeout: number
  prompt?: string
  sessionId?: string
  continue?: boolean
  dshBin?: string
  args?: string[]
  all?: boolean
  limit?: number
  provider?: string
  model?: string
  permission?: string
  help?: boolean
}
export interface AdapterEvent {
  type: string
  /** A final event is provisional until the iterator finishes successfully. */
  ok?: boolean
  sessionId?: string
  phase?: string
  reason?: { kind: string }
  text?: string
  data?: unknown
  code?: string
  message?: string
}
export interface ExecutionContext { signal: AbortSignal }
/** Selection occurs before execution; no fallback/replay after any side effect. */
export interface CliAdapter {
  readonly id: string
  capabilities(request: CliRequest, context: ExecutionContext): Promise<object>
  execute(request: CliRequest, context: ExecutionContext): AsyncIterable<AdapterEvent>
  continueSession(request: CliRequest, context: ExecutionContext): Promise<string>
  passthrough(request: CliRequest, context: ExecutionContext): Promise<number>
}
export interface CliIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; destroy(error?: Error): void }
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}
