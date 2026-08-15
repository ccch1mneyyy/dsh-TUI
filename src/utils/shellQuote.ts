/** cmd.exe joins spawn arguments with spaces; quote anything that could split. */
export function shellQuote(args: readonly string[]): string[] {
  return args.map(arg => (/[ \t"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg))
}

/**
 * cmd.exe metacharacter escaping, vendored from cross-spawn@7
 * (lib/util/escape.js, MIT © André Cruz et al.) — the ecosystem-standard
 * answer to "run a .cmd/.bat through cmd.exe without the shell mangling
 * paths that contain spaces, quotes, or metacharacters". See
 * http://www.robvanderwoude.com/escapechars.php and https://qntm.org/cmd.
 *
 * The backslash/quote patterns use cross-spawn's post-CVE-2024-21538 forms
 * (lookahead + backreference instead of a greedy star) so a pathological
 * run of backslashes cannot hang the regex engine.
 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g

/** Escape a command path for a cmd.exe line: caret-escape metacharacters. */
export function cmdEscapeCommand(command: string): string {
  return command.replace(CMD_META_CHARS, '^$1')
}

/**
 * Escape one argument for a cmd.exe line. Backslashes before a quote (or at
 * the end, where our own closing quote will land) are doubled and the quote
 * backslash-escaped so the target's argv parse keeps them literal; the whole
 * argument is then quoted and every cmd metacharacter caret-escaped — twice
 * when the command is a node_modules/.bin shim (those re-invoke node and
 * parse the line a second time).
 */
export function cmdEscapeArgument(arg: string, doubleEscapeMetaChars = false): string {
  let out = `${arg}`
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1')
  out = `"${out}"`
  out = out.replace(CMD_META_CHARS, '^$1')
  if (doubleEscapeMetaChars) {
    out = out.replace(CMD_META_CHARS, '^$1')
  }
  return out
}
