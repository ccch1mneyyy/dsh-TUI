/**
 * Split a shell-style command line into argv, honoring single/double quotes.
 * Shared by the external-editor (`$VISUAL`/`$EDITOR`) and terminal-launch
 * (`$TERMINAL`) paths, so a value like `code --wait`, `"C:\Program Files\
 * nvim.exe" -f`, or `kitty -1` splits the same way.
 */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null
  let hasToken = false
  for (const ch of commandLine) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '' || hasToken) args.push(current)
      current = ''
      hasToken = false
      continue
    }
    current += ch
  }
  if (current !== '' || hasToken) args.push(current)
  return args
}
