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
    if (arg === '--resume' || arg === '--host' || arg === '--port') {
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

/** `ctx.cmdlineArgs`: the app argv the host snapshotted, if it provides one. */
export function cmdlineArgsOf(ctx: object): readonly string[] | undefined {
  const cmdline = (ctx as { cmdlineArgs?: { get?: () => readonly string[]; args?: readonly string[] } }).cmdlineArgs
  return cmdline?.get?.() ?? cmdline?.args
}
