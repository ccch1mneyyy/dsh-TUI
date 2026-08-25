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
 *   6. buildWin32StartSpawn：Windows `start "" <target>` 组装纯函数。
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
import { buildWin32OpenSpawn, buildWin32StartSpawn } from '../src/utils/openExternal.js'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-clickable-targets: all checks passed')
