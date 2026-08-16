// Vendored from cross-spawn@7 (lib/util/escape.js, MIT). This helper must run
// before the first build, so it cannot import dsh-tui's generated lib/types.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g

function cmdEscapeCommand(command) {
  return command.replace(CMD_META_CHARS, '^$1')
}

function cmdEscapeArgument(arg, doubleEscapeMetaChars = false) {
  let out = `${arg}`
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1')
  out = `"${out}"`
  out = out.replace(CMD_META_CHARS, '^$1')
  if (doubleEscapeMetaChars) out = out.replace(CMD_META_CHARS, '^$1')
  return out
}

/** Build a spawn invocation without Node's deprecated shell + args form. */
export function commandInvocation(name, args, platform = process.platform) {
  if (platform !== 'win32') return [name, args]
  return [[
    cmdEscapeCommand(`${name}.cmd`),
    ...args.map(arg => cmdEscapeArgument(arg, true)),
  ].join(' '), []]
}
