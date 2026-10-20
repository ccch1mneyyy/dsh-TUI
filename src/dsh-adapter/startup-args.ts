/**
 * Extract the startup prompt from raw app argv, excluding session selectors
 * and Web startup flag values. `--trusted-host` consumes multiple authorities
 * up to the next flag; none of them are prompt text (issue #882). An app-level
 * `--` ends flag parsing; all following tokens are literal prompt text.
 */
export function initialPromptFromCmdlineArgs(args: readonly string[] | undefined): string {
  if (args === undefined) return ''
  const promptArgs: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') {
      promptArgs.push(...args.slice(i + 1))
      break
    }
    if (arg === '--resume' || arg === '--host' || arg === '--port' || arg === '--model' || arg === '--effort') {
      if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i += 1
      continue
    }
    if (arg === '--trusted-host') {
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i += 1
      continue
    }
    if (arg.startsWith('--resume=')) continue
    if (arg.startsWith('-')) continue
    promptArgs.push(arg)
  }
  return promptArgs.join(' ').trim()
}

/** Session-only DSH launch overrides; an app-level `--` ends option parsing. */
export function startupPreferencesFromCmdlineArgs(args: readonly string[] | undefined): {
  model?: { provider: string; model: string }
  effort?: string
} {
  const preferences: { model?: { provider: string; model: string }; effort?: string } = {}
  if (args === undefined) return preferences
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') break
    const flag = arg.split('=', 1)[0]!
    if (flag !== '--model' && flag !== '--effort') continue
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1)
    if (value === undefined || value.trim() === '' || value.startsWith('-')) {
      throw new Error(`dsh-tui: ${flag} requires ${flag === '--model' ? '<provider/model>' : '<level>'}`)
    }
    if (flag === '--model') {
      const slash = value.indexOf('/')
      if (slash <= 0 || slash === value.length - 1 || /\s/u.test(value)) {
        throw new Error('dsh-tui: --model must be <provider/model>')
      }
      preferences.model = { provider: value.slice(0, slash), model: value.slice(slash + 1) }
    } else {
      preferences.effort = value
    }
  }
  return preferences
}

/** `ctx.cmdlineArgs`: the app argv the host snapshotted, if it provides one. */
export function cmdlineArgsOf(ctx: object): readonly string[] | undefined {
  const cmdline = (ctx as { cmdlineArgs?: { get?: () => readonly string[]; args?: readonly string[] } }).cmdlineArgs
  return cmdline?.get?.() ?? cmdline?.args
}
