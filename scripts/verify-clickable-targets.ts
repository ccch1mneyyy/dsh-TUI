/**
 * verify-clickable-targets — 终端点击目标的纯函数回归（审计后新增）。
 *
 * 覆盖 src/utils/fileTarget.ts 与 src/utils/openExternal.ts：
 *   1. looksLikeFilePath 保守判定：锚定路径/扩展名路径为正，URL/分数/
 *      日期/带空格文本为负；
 *   2. linkifyFilePaths 扫描：span 提取、句尾标点留在链接外、wrap 回调
 *      只收路径；
 *   3. dsh-file: URL 编解码往返（含 CJK/空格/% 等需要 encodeURIComponent
 *      的字符）；
 *   4. resolveTargetPath：相对路径按 base 解析、~ 展开、绝对路径直通；
 *   5. fileUrlToPath：合法 file:// 转路径，非法返回 undefined；
 *   6. buildWin32StartSpawn：Windows `start "" <target>` 组装纯函数；
 *   7. buildWin32OpenSpawn：目录走 Shell.Application COM，其余走 start；
 *   8. Linux Terminal=true：desktop entry 解析/XDG 查找、Exec 字段码、
 *      $TERMINAL / KDE TerminalApplication 选择与最终 argv；非终端 handler
 *      和缺失/失败的回退。
 *
 * 运行：node --import tsx/esm scripts/verify-clickable-targets.ts
 */
import {
  FILE_LINK_SCHEME,
  fileLinkUrl,
  linkifyFilePaths,
  looksLikeFilePath,
  parseFileLinkUrl,
  resolveTargetPath,
  fileUrlToPath,
} from '../src/utils/fileTarget.js'
import { buildWin32OpenSpawn, buildWin32StartSpawn, openExternal, resolveLinuxFileOpen } from '../src/utils/openExternal.js'
import { expandExec, findDesktopEntry, parseDesktopEntry } from '../src/utils/desktopEntry.js'
import { buildTerminalSpawn, resolveTerminal } from '../src/utils/terminalLaunch.js'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mock } from 'node:test'
import { settled } from './lib/term-test.mjs'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** String-equality assertion for the linkify/encode helpers. */
function checkEq(name: string, actual: string, expected: string): void {
  const ok = actual === expected
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${ok ? '' : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`)
  if (!ok) failures++
}

// ── 1. looksLikeFilePath ────────────────────────────────────────────────
const POSITIVE = [
  'src/foo.ts',
  'src/components/Box.tsx',
  './a/b.txt',
  '../up/x.js',
  '/abs/path.md',
  '~/cfg/x.json',
  'C:\\repo\\src\\a.ts',
  'C:/repo/src/a.ts',
  'a/b/c.log',
  'node_modules/x/index.js',
  'src/foo.ts.',
  'dist/app.js',
]
const NEGATIVE = [
  'and/or',
  '2024/01/15',
  'https://example.com/a/b',
  'http://x.io',
  'www.example.com/x',
  'a/b',
  '1/2',
  'owner/repo#123',
  'hello world/file.ts',
  'a/b.x',
  'x.ts', // no slash
  'github.com/foo/bar',
  'src/foo.ts?query=1', // '?' rejected
  '',
  '  ',
  'a'.repeat(300) + '/b.ts', // over length cap
  'user@host/path',
]
for (const p of POSITIVE) {
  check(`looksLikeFilePath('${p}') true`, looksLikeFilePath(p) === true, String(looksLikeFilePath(p)))
}
for (const p of NEGATIVE) {
  check(`looksLikeFilePath('${p}') false`, looksLikeFilePath(p) === false, String(looksLikeFilePath(p)))
}

// ── 2. linkifyFilePaths ─────────────────────────────────────────────────
const wrap = (path: string, display: string): string => `«${path}»(${display})`
checkEq(
  'linkify single path in prose',
  linkifyFilePaths('check src/foo.ts and done', wrap),
  'check «src/foo.ts»(src/foo.ts) and done',
)
checkEq(
  'linkify trailing punctuation stays outside',
  linkifyFilePaths('see ./a/b.txt.', wrap),
  'see «./a/b.txt»(./a/b.txt).',
)
checkEq(
  'linkify multiple paths',
  linkifyFilePaths('a.ts src/x.ts b.ts src/y.json c.ts', wrap),
  'a.ts «src/x.ts»(src/x.ts) b.ts «src/y.json»(src/y.json) c.ts',
)
checkEq(
  'non-path spans untouched (URL, fraction, issue ref)',
  linkifyFilePaths('go to https://x.com/a or 1/2 or owner/repo#123', wrap),
  'go to https://x.com/a or 1/2 or owner/repo#123',
)
checkEq(
  'URL slash run untouched (file:// too)',
  linkifyFilePaths('see file:///tmp/x.ts and https://a.io/b/c.ts now', wrap),
  'see file:///tmp/x.ts and https://a.io/b/c.ts now',
)
checkEq(
  'anchor path after a colon still links (C: drive)',
  linkifyFilePaths('on C:\\repo\\src\\a.ts here', wrap),
  'on «C:\\repo\\src\\a.ts»(C:\\repo\\src\\a.ts) here',
)
checkEq('empty text unchanged', linkifyFilePaths('', wrap), '')

// Test the scanner, not only the whole-token heuristic: an internal slash
// must not turn a rejected token's suffix into an anchored path.
for (const text of [
  'working/idle/needs-input state,',
  '2024/01/15',
  'github.com/foo/bar',
  '工作/空闲/等待输入',
  'working\\idle\\needs-input',
  'prefix./dir/name',
  'prefix~/dir/name',
  'prefixC:\\dir\\name',
]) {
  checkEq(`non-path token stays intact: ${text}`, linkifyFilePaths(text, wrap), text)
}
for (const path of ['/tmp/project', './dir/name', '../dir/name', '~/dir/name', 'C:\\dir\\name']) {
  for (const prefix of ['', 'see ', '\n', '"', "'", '(', '[', '{', '=']) {
    checkEq(
      `anchored path at a text boundary: ${prefix}${path}`,
      linkifyFilePaths(prefix + path, wrap),
      prefix + wrap(path, path),
    )
  }
}

// ── 3. dsh-file: URL round-trip ─────────────────────────────────────────
const tricky = [
  'src/foo.ts',
  'C:\\Users\\张三\\我的 文件.ts', // CJK + space + backslash
  'a/b/100%.md',
  '~/.config/x.json',
  'src/文件/测试.txt',
]
for (const p of tricky) {
  const url = fileLinkUrl(p)
  check(`round-trip '${p}'`, parseFileLinkUrl(url) === p, url)
}
check('scheme prefix', fileLinkUrl('x.ts').startsWith(FILE_LINK_SCHEME), fileLinkUrl('x.ts'))
check('parse rejects non-scheme', parseFileLinkUrl('https://x.com/a') === undefined, '')
check('parse rejects malformed encoding', parseFileLinkUrl(FILE_LINK_SCHEME + '%E0%A4%A') === undefined, '')

// ── 4. resolveTargetPath ────────────────────────────────────────────────
check(
  'relative resolves against base',
  resolveTargetPath('src/a.ts', 'C:\\repo'),
  'C:\\repo\\src\\a.ts',
)
check(
  'posix relative resolves against base',
  resolveTargetPath('src/a.ts', '/repo'),
  '/repo/src/a.ts',
)
check(
  'windows drive path passes through',
  resolveTargetPath('C:\\abs\\x.ts', '/repo'),
  'C:\\abs\\x.ts',
)
check(
  'absolute posix passes through',
  resolveTargetPath('/abs/x.ts', 'C:\\repo'),
  '/abs/x.ts',
)
check(
  'tilde expands to home (not the base dir)',
  (() => {
    const tilde = resolveTargetPath('~/cfg/x.json', '/repo')
    return !tilde.startsWith('/repo') && tilde.includes('cfg') && tilde.includes('x.json')
  })(),
  true,
)
check(
  'tilde result is stable under re-resolution',
  (() => {
    const once = resolveTargetPath('~/cfg/x.json', '/repo')
    return resolveTargetPath(once, '/repo') === once
  })(),
  true,
)

// ── 5. fileUrlToPath ────────────────────────────────────────────────────
{
  // Absolute file URLs are platform-shaped: Windows needs a drive letter.
  const sample = process.platform === 'win32' ? 'file:///C:/tmp/foo.ts' : 'file:///tmp/foo.ts'
  const p = fileUrlToPath(sample)
  check('file URL to path', p !== undefined && p.endsWith('foo.ts'), String(p))
}
check('invalid file URL rejected', fileUrlToPath('file://%') === undefined, '')

// ── 6. buildWin32StartSpawn (pure assembly) ─────────────────────────────
{
  // cross-spawn protocol: quotes are caret-escaped (`^"`); cmd consumes the
  // carets at parse time, so the executed line is `start "" "C:\repo\a.ts"`.
  const cmd = buildWin32StartSpawn('C:\\repo\\a.ts')
  check('win32 start file is cmd', cmd.file.toLowerCase().endsWith('cmd.exe'), cmd.file)
  const line = cmd.args.join(' ')
  check(
    'win32 start args carry title + quoted target',
    line.includes('start ^"^"') && line.includes('^"C:\\repo\\a.ts^"'),
    line,
  )
  check('win32 start verbatim', cmd.verbatim === true, '')
  check('win32 start stays detached (field-proven channel)', cmd.detach === true, '')
  // A space-carrying target still gets quoted (the caret-escape protocol
  // covers spaces inside the quotes).
  const spaced = buildWin32StartSpawn('C:\\My Folder\\a.ts')
  const spacedLine = spaced.args.join(' ')
  check(
    'win32 start quotes space-carrying targets',
    spacedLine.includes('start ^"^"') && spacedLine.includes('^"C:\\My') && spacedLine.includes('Folder\\a.ts^"'),
    spacedLine,
  )
}

// ── 7. buildWin32OpenSpawn (channel selection: dir → COM, else start) ──
{
  const fileSpawn = buildWin32OpenSpawn('C:\\repo\\a.ts')
  check(
    'open spawn for a file stays on start',
    fileSpawn.file.toLowerCase().endsWith('cmd.exe') && fileSpawn.args.join(' ').includes('start ^"^"'),
    fileSpawn.file + ' ' + fileSpawn.args.join(' '),
  )
  const urlSpawn = buildWin32OpenSpawn('https://example.com/a')
  check(
    'open spawn for a URL stays on start',
    urlSpawn.file.toLowerCase().endsWith('cmd.exe'),
    urlSpawn.file,
  )
  // Missing paths are not directories → start (openExternal then surfaces
  // the failure to the opener, never an error dialog from us).
  const missingSpawn = buildWin32OpenSpawn('C:\\no\\such\\dir')
  check(
    'open spawn for a missing path stays on start',
    missingSpawn.file.toLowerCase().endsWith('cmd.exe'),
    missingSpawn.file,
  )
  if (process.platform === 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-open-'))
    try {
      const dirSpawn = buildWin32OpenSpawn(dir)
      check(
        'open spawn for a directory uses Shell.Application COM',
        dirSpawn.file.toLowerCase().endsWith('powershell.exe')
          && dirSpawn.args.join(' ').includes("Shell.Application).Open('"),
        dirSpawn.file + ' ' + dirSpawn.args.join(' '),
      )
      // Regression (2026-08-24 无响应 bug): the COM powershell child must
      // NOT be spawned detached — DETACHED_PROCESS (console-less
      // PowerShell) silently drops the Shell.Application Open call, while
      // windowsHide alone keeps it invisible AND functional.
      check('COM channel is not detached (console-less PS drops the call)', dirSpawn.detach === false, '')
      check(
        'start channels stay detached',
        buildWin32OpenSpawn('C:\\repo\\a.ts').detach === true,
        '',
      )
      // Single quotes in the path must be doubled for the PS literal.
      const squoteDir = dir + "'s dir"
      mkdirSync(squoteDir)
      const sqSpawn = buildWin32OpenSpawn(squoteDir)
      check(
        'open spawn doubles single quotes in the path',
        sqSpawn.args.join(' ').includes("Open('" + squoteDir.replace(/'/g, "''") + "')"),
        sqSpawn.args.join(' '),
      )
      rmSync(squoteDir, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// Linux desktop fixtures use POSIX executable bits, shell scripts and file URLs.
if (process.platform === 'linux') {
  // ── 8. desktop-entry parsing / Exec expansion ──────────────────────────
  const desktopText = [
    '# generated by the vim package',
    '[Desktop Entry]',
    'Name=Vim',
    'Exec=vim %F',
    'Terminal=true',
    'TryExec=vim',
    '',
    '[Desktop Action new]',
    'Name=New',
    'Exec=vim %f',
  ].join('\n')
  const vimEntry = parseDesktopEntry(desktopText, 'vim.desktop', '/usr/share/applications/vim.desktop')
  check(
    'desktop: Exec/Terminal/TryExec parsed',
    vimEntry?.exec === 'vim %F' && vimEntry.terminal === true && vimEntry.tryExec === 'vim' && vimEntry.hidden === false,
    JSON.stringify(vimEntry),
  )
  check('desktop: Desktop Action groups ignored', vimEntry?.exec === 'vim %F')
  check('desktop: missing Exec rejected', parseDesktopEntry('[Desktop Entry]\nName=x\n', 'x.desktop', '/x') === undefined)
  check('desktop: Hidden is parsed', parseDesktopEntry('[Desktop Entry]\nExec=x %f\nHidden=true\n', 'x.desktop', '/x')?.hidden === true)
  const localizedEntry = parseDesktopEntry(
    '[Desktop Entry]\nName=Vim\nName[zh_CN]=Vim 中文\nExec=vim %F\nTerminal=true\n',
    'vim.desktop',
    '/x',
    'zh_CN.UTF-8',
  )
  check('desktop: localized Name[locale] wins', localizedEntry?.name === 'Vim 中文', JSON.stringify(localizedEntry))
  check(
    'desktop: Name falls back when the locale is absent',
    parseDesktopEntry('[Desktop Entry]\nName=Vim\nExec=vim %F\n', 'vim.desktop', '/x', 'fr_FR.UTF-8')?.name === 'Vim',
  )

  checkEq('exec: %F expands to the target', expandExec('vim %F', '/a/b.txt', vimEntry!)!.join('|'), 'vim|/a/b.txt')
  checkEq(
    'exec: quoted args + embedded %f',
    expandExec('"my editor" --file=%f "x y"', '/a/b.txt', vimEntry!)!.join('|'),
    'my editor|--file=/a/b.txt|x y',
  )
  checkEq('exec: %u expands to a file URL', expandExec('app %u', '/a/b.txt', vimEntry!)!.join('|'), 'app|file:///a/b.txt')
  checkEq(
    'exec: %% stays literal and (like xdg-open) still appends the target',
    expandExec('app 100%%', '/a/b.txt', vimEntry!)!.join('|'),
    'app|100%|/a/b.txt',
  )
  checkEq('exec: %c expands to the entry name', expandExec('app %c', '/a/b.txt', vimEntry!)!.join('|'), 'app|Vim')
  checkEq('exec: %i is dropped without appending the target', expandExec('app %i', '/a/b.txt', vimEntry!)!.join('|'), 'app')
  checkEq('exec: no field code appends the target', expandExec('app', '/a/b.txt', vimEntry!)!.join('|'), 'app|/a/b.txt')
  check('exec: unterminated quote falls back', expandExec('app "oops', '/a/b.txt', vimEntry!) === undefined)
  checkEq(
    'exec: an explicit empty argument does not shift the target into -c',
    JSON.stringify(expandExec('vim -c "" %f', '/a/b c.txt', vimEntry!)),
    JSON.stringify(['vim', '-c', '', '/a/b c.txt']),
  )
  checkEq(
    'exec: explicit empty args survive while empty field codes disappear',
    JSON.stringify(expandExec('app "" %i %d %f ""', '/a/b.txt', vimEntry!)),
    JSON.stringify(['app', '', '/a/b.txt', '']),
  )
  check(
    'desktop: Path is kept separate from the desktop-file location',
    parseDesktopEntry('[Desktop Entry]\nExec=vim %f\nPath=/opt/editor\\sconfig\n', 'vim.desktop', '/x')?.workingDirectory === '/opt/editor config',
  )

  // ── 9. XDG desktop-entry lookup ────────────────────────────────────────
  const xdgRoot = mkdtempSync(join(tmpdir(), 'dsh-xdg-'))
  try {
    const apps = join(xdgRoot, 'data', 'applications')
    mkdirSync(join(apps, 'vendor'), { recursive: true })
    writeFileSync(join(apps, 'vim.desktop'), desktopText)
    writeFileSync(join(apps, 'vendor', 'app.desktop'), '[Desktop Entry]\nExec=app %F\n')
    const env = { ...process.env, XDG_DATA_HOME: join(xdgRoot, 'data'), XDG_DATA_DIRS: join(xdgRoot, 'none') }
    check('desktop: direct id found', findDesktopEntry('vim.desktop', env) === join(apps, 'vim.desktop'))
    check(
      'desktop: legacy vendor-app maps to vendor/app',
      findDesktopEntry('vendor-app.desktop', env) === join(apps, 'vendor', 'app.desktop'),
    )
    const hyphenated = join(apps, 'vendor', 'my-editor.desktop')
    writeFileSync(hyphenated, '[Desktop Entry]\nExec=vim %F\nTerminal=true\n')
    check('desktop: legacy ID preserves filename hyphens', findDesktopEntry('vendor-my-editor.desktop', env) === hyphenated)
    mkdirSync(join(apps, 'vendor', 'my'))
    writeFileSync(join(apps, 'vendor', 'my', 'editor.desktop'), '[Desktop Entry]\nExec=other %F\nTerminal=true\n')
    check('desktop: single legacy separator wins over all-hyphen expansion', findDesktopEntry('vendor-my-editor.desktop', env) === hyphenated)
    writeFileSync(join(apps, 'vendor-my-editor.desktop'), desktopText)
    check('desktop: literal ID still wins over legacy candidates', findDesktopEntry('vendor-my-editor.desktop', env) === join(apps, 'vendor-my-editor.desktop'))
    check('desktop: path traversal rejected', findDesktopEntry('../vim.desktop', env) === undefined)
  } finally {
    rmSync(xdgRoot, { recursive: true, force: true })
  }

  // ── 10. terminal selection ──────────────────────────────────────────────
  const kittyRoot = mkdtempSync(join(tmpdir(), 'dsh-kitty-'))
  try {
    const kitty = join(kittyRoot, 'kitty')
    writeFileSync(kitty, '#!/bin/sh\n')
    chmodSync(kitty, 0o755)
    const kittyTerm = resolveTerminal({
      ...process.env,
      TERMINAL: 'kitty -1',
      XDG_CONFIG_HOME: '/nonexistent',
      PATH: kittyRoot,
    })
    check(
      'terminal: $TERMINAL wins with its args',
      kittyTerm?.file === 'kitty' && kittyTerm.args.join(' ') === '-1' && kittyTerm.separator.length === 0,
      JSON.stringify(kittyTerm),
    )
    checkEq(
      'terminal: kitty takes the program directly',
      kittyTerm === undefined ? '<missing>' : buildTerminalSpawn(kittyTerm, ['vim', '/a']).args.join('|'),
      '-1|vim|/a',
    )
  } finally {
    rmSync(kittyRoot, { recursive: true, force: true })
  }
  check(
    'terminal: no candidates -> undefined',
    resolveTerminal({ ...process.env, TERMINAL: '', XDG_CONFIG_HOME: '/nonexistent', PATH: '' }) === undefined,
  )

  const ghosttyRoot = mkdtempSync(join(tmpdir(), 'dsh-term-'))
  try {
    const ghostty = join(ghosttyRoot, 'ghostty')
    writeFileSync(ghostty, '#!/bin/sh\n')
    chmodSync(ghostty, 0o755)
    for (const [file, separator] of [
      ['xfce4-terminal', '-x'],
      ['mate-terminal', '-x'],
      ['terminator', '-x'],
      ['x-terminal-emulator', '-e'],
    ] as const) {
      const terminal = join(ghosttyRoot, file)
      writeFileSync(terminal, '#!/bin/sh\n')
      chmodSync(terminal, 0o755)
      const spec = resolveTerminal({ TERMINAL: `${file} --title "My Files"`, XDG_CONFIG_HOME: '/nonexistent', PATH: ghosttyRoot })
      checkEq(
        `terminal: ${file} uses ${separator} to preserve the remaining argv`,
        JSON.stringify(spec === undefined ? undefined : buildTerminalSpawn(spec, ['vim', '/a/b c.txt'])),
        JSON.stringify({ file, args: ['--title', 'My Files', separator, 'vim', '/a/b c.txt'] }),
      )
    }
    const spec = resolveTerminal({ ...process.env, TERMINAL: '', XDG_CONFIG_HOME: '/nonexistent', PATH: ghosttyRoot })
    check(
      'terminal: ghostty fallback uses -e',
      spec?.file === 'ghostty' && spec.separator.join('|') === '-e',
      JSON.stringify(spec),
    )
  } finally {
    rmSync(ghosttyRoot, { recursive: true, force: true })
  }

  const kdeRoot = mkdtempSync(join(tmpdir(), 'dsh-kde-'))
  try {
    const bin = join(kdeRoot, 'bin')
    const fallbackBin = join(kdeRoot, 'fallback-bin')
    mkdirSync(bin)
    mkdirSync(fallbackBin)
    const kitty = join(bin, 'kitty')
    writeFileSync(kitty, '#!/bin/sh\n')
    chmodSync(kitty, 0o755)
    const xterm = join(fallbackBin, 'xterm')
    writeFileSync(xterm, '#!/bin/sh\n')
    chmodSync(xterm, 0o755)
    writeFileSync(join(kdeRoot, 'kdeglobals'), '[General]\nTerminalApplication=kitty -1\n')
    const kde = resolveTerminal({ ...process.env, TERMINAL: '', XDG_CONFIG_HOME: kdeRoot, PATH: bin })
    check(
      'terminal: KDE TerminalApplication used when $TERMINAL is unset',
      kde?.file === 'kitty' && kde.args.join(' ') === '-1',
      JSON.stringify(kde),
    )
    writeFileSync(join(kdeRoot, 'kdeglobals'), '[General]\nTerminalApplication=missing-terminal\n')
    const fallback = resolveTerminal({ ...process.env, TERMINAL: '', XDG_CONFIG_HOME: kdeRoot, PATH: fallbackBin })
    check(
      'terminal: unavailable KDE TerminalApplication falls through',
      fallback?.file === 'xterm' && fallback.separator.join('|') === '-e',
      JSON.stringify(fallback),
    )
  } finally {
    rmSync(kdeRoot, { recursive: true, force: true })
  }

  // ── 11. resolveLinuxFileOpen end-to-end (fake xdg-mime) ────────────────
  const linuxRoot = mkdtempSync(join(tmpdir(), 'dsh-linux-open-'))
  const envKeys = ['PATH', 'FAKE_DEFAULT', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_HOME', 'TERMINAL']
  const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]))
  try {
    const bin = join(linuxRoot, 'bin')
    const data = join(linuxRoot, 'data')
    const config = join(linuxRoot, 'config')
    mkdirSync(bin)
    mkdirSync(join(data, 'applications'), { recursive: true })
    mkdirSync(config)
    writeFileSync(join(data, 'applications', 'vim.desktop'), '[Desktop Entry]\nExec=vim %F\nTerminal=true\nTryExec=sh\n')
    writeFileSync(join(data, 'applications', 'image.desktop'), '[Desktop Entry]\nExec=eog %F\nTerminal=false\n')
    writeFileSync(join(data, 'applications', 'cwd.desktop'), '[Desktop Entry]\nExec=vim -u ./vimrc %f\nTerminal=true\nPath=/opt/editor\n')
    writeFileSync(join(data, 'applications', 'empty-path.desktop'), '[Desktop Entry]\nExec=vim %f\nTerminal=true\nPath=\n')
    writeFileSync(join(config, 'kdeglobals'), '[General]\nTerminalApplication=kitty -1\n')
    // KDE names kitty; keep the resolution machine-independent.
    const fakeKitty = join(bin, 'kitty')
    writeFileSync(fakeKitty, '#!/bin/sh\n')
    chmodSync(fakeKitty, 0o755)
    const fakeXdgMime = join(bin, 'xdg-mime')
    writeFileSync(
      fakeXdgMime,
      '#!/bin/sh\ncase "$2" in\n  filetype) echo text/plain ;;\n  default) echo "${FAKE_DEFAULT:-vim.desktop}" ;;\n  *) exit 1 ;;\nesac\n',
    )
    chmodSync(fakeXdgMime, 0o755)
    const file = join(linuxRoot, 'note.txt')
    writeFileSync(file, 'hi\n')
    const env = {
      ...process.env,
      XDG_DATA_HOME: data,
      XDG_DATA_DIRS: join(linuxRoot, 'none'),
      XDG_CONFIG_HOME: config,
      TERMINAL: '',
      PATH: `${bin}:/usr/bin:/bin`,
    }
    process.env.PATH = `${bin}:/usr/bin:/bin`
    process.env.FAKE_DEFAULT = ''
    const spec = await resolveLinuxFileOpen(file, env)
    check(
      'linux open: Terminal=true spawns kitty + expanded Exec',
      spec?.file === 'kitty' && spec.args.join('|') === `-1|vim|${file}`,
      JSON.stringify(spec),
    )
    process.env.FAKE_DEFAULT = 'image.desktop'
    const fallback = await resolveLinuxFileOpen(file, env)
    check('linux open: Terminal=false falls back to xdg-open', fallback === undefined)
    const url = await resolveLinuxFileOpen('https://example.com', env)
    check('linux open: URL skips the desktop lookup', url === undefined)
    process.env.FAKE_DEFAULT = 'cwd.desktop'
    check('linux open: unsupported Path keeps the existing system-opener behavior', await resolveLinuxFileOpen(file, env) === undefined)
    process.env.FAKE_DEFAULT = 'empty-path.desktop'
    check('linux open: an empty Path does not disable terminal wrapping', (await resolveLinuxFileOpen(file, env))?.file === 'kitty')

    // Exercise the real open entrypoint. Only process creation is mocked: the
    // resolver still reads the desktop files and terminal configuration above.
    for (const key of envKeys) {
      if (key === 'FAKE_DEFAULT') continue
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    process.env.FAKE_DEFAULT = 'vim.desktop'
    const launches: Array<{ command: string; args: readonly string[] }> = []
    const diagnostics: string[] = []
    let mode: 'success' | 'error' | 'throw' = 'success'
    mock.method(process.stderr, 'write', (chunk: unknown) => { diagnostics.push(String(chunk)); return true })
    mock.method(childProcess, 'spawn', (command: string, args: readonly string[] = []) => {
      launches.push({ command, args })
      if (command === 'kitty' && mode === 'throw') throw new Error('fixture: terminal spawn threw')
      const child = Object.assign(new EventEmitter(), { unref() {} })
      if (command === 'xdg-mime') {
        const stdout = new PassThrough()
        queueMicrotask(() => {
          stdout.emit('data', Buffer.from(args[1] === 'filetype' ? 'text/plain\n' : `${process.env.FAKE_DEFAULT}\n`))
          child.emit('close', 0)
        })
        return Object.assign(child, { stdout })
      }
      if (command === 'kitty') queueMicrotask(() => {
        if (mode === 'error') child.emit('error', new Error('fixture: terminal startup error'))
        else child.emit('close', 0)
      })
      return child
    })
    syncBuiltinESMExports()
    for (const outcome of ['success', 'error', 'throw'] as const) {
      mode = outcome
      launches.length = 0
      openExternal(file)
      const lastCommand = outcome === 'success' ? 'kitty' : 'xdg-open'
      const completed = await settled(() => launches.at(-1)?.command === lastCommand, { timeoutMs: 1500 })
      check(`linux open: terminal ${outcome} completes through ${lastCommand}`, completed)
      checkEq(
        `linux open: terminal ${outcome} launches exactly the intended target`,
        JSON.stringify(launches.filter(launch => launch.command !== 'xdg-mime')),
        JSON.stringify(outcome === 'success'
          ? [{ command: 'kitty', args: ['-1', 'vim', file] }]
          : [{ command: 'kitty', args: ['-1', 'vim', file] }, { command: 'xdg-open', args: [file] }]),
      )
    }
    check('linux open: both startup failures are diagnosed', diagnostics.length === 2, diagnostics.join(''))
    process.env.FAKE_DEFAULT = 'cwd.desktop'
    launches.length = 0
    diagnostics.length = 0
    openExternal(file)
    check('linux open: known unsupported Path delegates to the system opener', await settled(() => launches.at(-1)?.command === 'xdg-open', { timeoutMs: 1500 }))
    check('linux open: unsupported Path delegation is quiet', diagnostics.length === 0, diagnostics.join(''))
    checkEq(
      'linux open: Path fallback keeps the original target',
      JSON.stringify(launches.filter(launch => launch.command !== 'xdg-mime')),
      JSON.stringify([{ command: 'xdg-open', args: [file] }]),
    )
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(linuxRoot, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-clickable-targets: all checks passed')
