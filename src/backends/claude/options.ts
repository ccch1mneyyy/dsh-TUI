/**
 * The Claude Code Fidelity Profile (docs/agent-backend-design.md §4.3): the
 * `query()` options that make a dsh-tui Claude session behave like `claude`
 * in the same project — the CLI's own system prompt, every settings source
 * (CLAUDE.md, hooks, MCP, plugins load as in the CLI), its tool preset, an
 * explicit start permission mode, streaming partials, subagent text and
 * per-task stop, file checkpoints, and the host's permission callback.
 *
 * `OPTION_POLICY` classifies EVERY SDK option. It is checked with
 * `satisfies Record<keyof Options, …>`: an option the SDK adds or removes
 * fails `tsc` here until someone decides what the profile does with it.
 */
import type { CanUseTool, OnElicitation, OnUserDialog, Options, PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSdkModule } from './sdk.js'

/** How the profile treats an option: `set` here, `side` (only the side
 *  query of `/btw` and `/recap` sets it, `buildSideQueryOptions`), `omit`
 *  (CLI default / settings decide), or `later` (a later phase maps a TUI
 *  feature to it). */
type OptionPolicy = 'set' | 'side' | 'omit' | 'later'

export const OPTION_POLICY = {
  abortController: 'set',
  additionalDirectories: 'later', // `/add-dir` (Phase 5)
  projectConfigRoot: 'omit',
  agent: 'omit',
  agents: 'omit',
  allowedTools: 'omit',
  canUseTool: 'set',
  continue: 'omit',
  cwd: 'set',
  disallowedTools: 'omit',
  toolAliases: 'omit',
  tools: 'set',
  env: 'set',
  executable: 'omit',
  executableArgs: 'omit',
  extraArgs: 'set', // only when the CLI lacks msg_lifecycle_v1 (replay-user-messages)
  fallbackModel: 'omit',
  enableFileCheckpointing: 'set',
  toolConfig: 'omit',
  forkSession: 'side', // the side query forks the conversation
  betas: 'omit',
  hooks: 'omit',
  onElicitation: 'set', // MCP elicitation → the questionnaire (dialogs.ts)
  onUserDialog: 'set', // the refusal-fallback dialog (dialogs.ts)
  supportedDialogKinds: 'set', // exactly the kinds dialogs.ts renders
  perTaskStopAffordance: 'set',
  persistSession: 'side', // the side query writes no transcript
  sessionStore: 'omit',
  sessionStoreFlush: 'omit',
  loadTimeoutMs: 'omit',
  includeHookEvents: 'set',
  includePartialMessages: 'set',
  forwardSubagentText: 'set',
  verbatimPrompts: 'omit',
  thinking: 'omit',
  effort: 'set', // the persisted `/effort` choice (Phase 3)
  maxThinkingTokens: 'omit',
  maxTurns: 'side', // the side query: one turn
  maxBudgetUsd: 'omit',
  taskBudget: 'omit',
  mcpServers: 'omit',
  model: 'set', // the persisted `/model` choice (Phase 3)
  outputFormat: 'omit',
  pathToClaudeCodeExecutable: 'set',
  permissionMode: 'set',
  planModeInstructions: 'omit',
  allowDangerouslySkipPermissions: 'set', // only the explicit `bypassPermissions` start
  permissionPromptToolName: 'omit',
  permissionPrompts: 'omit',
  plugins: 'omit',
  pluginDelivery: 'omit',
  promptSuggestions: 'omit',
  agentProgressSummaries: 'omit',
  resume: 'set', // credential reconnect (Phase 3); /resume is Phase 4
  sessionId: 'set',
  resumeSessionAt: 'later',
  resumeDropsTurn: 'later',
  sandbox: 'omit',
  settings: 'set', // the route pin of an injected subscription token (auth.ts)
  managedSettings: 'omit',
  settingSources: 'set',
  skills: 'omit',
  debug: 'omit',
  debugFile: 'omit',
  stderr: 'set',
  strictMcpConfig: 'omit',
  systemPrompt: 'set',
  title: 'omit',
  spawnClaudeCodeProcess: 'omit',
} as const satisfies Record<keyof Options, OptionPolicy>

/** Every settings source, so CLAUDE.md, hooks, MCP and plugins load as in
 *  the CLI (`project` is the one that brings CLAUDE.md, Phase 0 probe P1). */
export const SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local']

/** Modes the start resolution accepts from settings. `bypassPermissions`
 *  is never started from settings — only the env override below opts in. */
const START_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']
const ALL_MODES: readonly PermissionMode[] = [...START_MODES, 'bypassPermissions']
/** Modes the developer override may start in. `bypassPermissions` is the
 *  one explicit bypass entry: the repo owner's own environment, never a
 *  repo-committed settings file (settings-level bypass still downgrades
 *  above, so a cloned repo cannot poison a session into it). Not `auto`
 *  either (it depends on the model's classifier support). */
const OVERRIDE_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']

const isPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (ALL_MODES as readonly string[]).includes(value)

/** What the start-mode resolution decided, and why (for a notice). */
export interface StartPermissionMode {
  readonly mode: PermissionMode
  /** Set when the configured mode was not honoured. */
  readonly downgradedFrom?: PermissionMode
  readonly source: 'env' | 'settings' | 'default'
  /** `DSH_TUI_CLAUDE_PERMISSION_MODE` was set to a value the override refuses. */
  readonly ignoredOverride?: string
  /** Derived (`mode === 'bypassPermissions'`): the session may re-enter
   *  bypass only because it explicitly started in it (fail-closed). */
  readonly bypassAllowed: boolean
}

/**
 * The explicit start permission mode (design §4.3: never omitted — the CLI
 * default may be `auto`). `DSH_TUI_CLAUDE_PERMISSION_MODE` is a developer
 * override for live tests; `bypassPermissions` is the one mode only it can
 * start (README documents it) — the user's explicit choice, never a settings
 * file. Otherwise the user's settings cascade after the CLI's own trust
 * filter for escalating modes from repo-committed files; otherwise `default`.
 */
export async function resolveStartPermissionMode(
  sdk: Pick<ClaudeSdkModule, 'resolveSettings' | 'filterEscalatingDefaultMode'>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartPermissionMode> {
  const override = env.DSH_TUI_CLAUDE_PERMISSION_MODE
  if (override !== undefined && override !== '' && (OVERRIDE_MODES as readonly string[]).includes(override)) {
    return { mode: override as PermissionMode, source: 'env', bypassAllowed: override === 'bypassPermissions' }
  }
  const ignoredOverride = override === undefined || override === '' ? undefined : override
  let configured: unknown
  try {
    const resolved = await sdk.resolveSettings({ cwd, settingSources: SETTING_SOURCES })
    const effective: unknown = sdk.filterEscalatingDefaultMode(resolved)
    const permissions = typeof effective === 'object' && effective !== null ? (effective as { permissions?: unknown }).permissions : undefined
    configured = typeof permissions === 'object' && permissions !== null ? (permissions as { defaultMode?: unknown }).defaultMode : undefined
  } catch {
    configured = undefined
  }
  const ignored = ignoredOverride === undefined ? {} : { ignoredOverride }
  if (!isPermissionMode(configured)) return { mode: 'default', source: 'default', bypassAllowed: false, ...ignored }
  if (!(START_MODES as readonly string[]).includes(configured)) return { mode: 'default', downgradedFrom: configured, source: 'settings', bypassAllowed: false, ...ignored }
  return { mode: configured, source: 'settings', bypassAllowed: configured === 'bypassPermissions', ...ignored }
}

export type ProfileInput = {
  readonly cwd: string
  readonly permissionMode: PermissionMode
  readonly executable: string | undefined
  readonly env: Record<string, string>
  readonly canUseTool: CanUseTool
  /** MCP elicitation and the CLI's user dialogs (dialogs.ts); absent = the
   *  SDK defaults (elicitation declined, no dialog kinds declared). */
  readonly onElicitation?: OnElicitation
  readonly onUserDialog?: OnUserDialog
  readonly supportedDialogKinds?: readonly string[]
  readonly stderr: (data: string) => void
  readonly abortController: AbortController
  /** Fall back to echoed user messages when the CLI has no lifecycle frames. */
  readonly replayUserMessages: boolean
  /** Start model / effort (the user's persisted choice); absent = the CLI's. */
  readonly model?: string
  readonly effort?: string
  /** Flag-layer settings: the route pin of an injected subscription token
   *  (auth.ts); absent = none. */
  readonly settings?: { readonly env: Readonly<Record<string, string>> }
} & (
  /** A new session under this id … */
  | { readonly sessionId: string; readonly resume?: undefined }
  /** … or the same session resumed (the SDK refuses both together). */
  | { readonly resume: string; readonly sessionId?: undefined }
)

/** What a side query (`/btw`, `/recap`; side-query.ts) runs with. */
export interface SideQueryInput {
  readonly cwd: string
  /** The session it forks (persisted). */
  readonly resume: string
  readonly env: Record<string, string>
  readonly settings?: { readonly env: Readonly<Record<string, string>> }
  readonly executable: string | undefined
  readonly abortController: AbortController
  readonly stderr: (data: string) => void
  readonly model?: string
}

/**
 * The side query's options (design §5.3): a throwaway fork of the
 * conversation (`resume` + `forkSession`, `persistSession:false` — no
 * transcript written), no tools, one turn, the session's model, and the
 * session's own system prompt, settings sources, environment, credential
 * and route pin. Nothing can ask for permission (no tools; any request is
 * refused).
 */
export function buildSideQueryOptions(input: SideQueryInput): Options {
  return {
    abortController: input.abortController,
    cwd: input.cwd,
    resume: input.resume,
    forkSession: true,
    persistSession: false,
    tools: [],
    maxTurns: 1,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: SETTING_SOURCES,
    includePartialMessages: true,
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'No tools are available to a side question' }),
    env: input.env,
    stderr: input.stderr,
    ...(input.executable === undefined ? {} : { pathToClaudeCodeExecutable: input.executable }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.settings === undefined ? {} : { settings: { env: { ...input.settings.env } } }),
  }
}

/** Assemble the `query()` options of one session. */
export function buildQueryOptions(input: ProfileInput): Options {
  return {
    abortController: input.abortController,
    cwd: input.cwd,
    ...(input.resume === undefined ? { sessionId: input.sessionId } : { resume: input.resume }),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: SETTING_SOURCES,
    tools: { type: 'preset', preset: 'claude_code' },
    permissionMode: input.permissionMode,
    // The SDK refuses `bypassPermissions` without this flag (sdk.d.ts);
    // no other mode ever carries it.
    ...(input.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    canUseTool: input.canUseTool,
    ...(input.onElicitation === undefined ? {} : { onElicitation: input.onElicitation }),
    // The SDK refuses declared kinds without the callback.
    ...(input.onUserDialog === undefined ? {} : { onUserDialog: input.onUserDialog, supportedDialogKinds: [...(input.supportedDialogKinds ?? [])] }),
    includePartialMessages: true,
    forwardSubagentText: true,
    perTaskStopAffordance: true,
    enableFileCheckpointing: true,
    includeHookEvents: false,
    env: input.env,
    stderr: input.stderr,
    ...(input.executable === undefined ? {} : { pathToClaudeCodeExecutable: input.executable }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort as NonNullable<Options['effort']> }),
    ...(input.settings === undefined ? {} : { settings: { env: { ...input.settings.env } } }),
    ...(input.replayUserMessages ? { extraArgs: { 'replay-user-messages': null } } : {}),
  }
}
