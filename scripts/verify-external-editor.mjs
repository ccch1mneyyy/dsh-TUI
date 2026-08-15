/**
 * 外部编辑器回归（issue #123）：Ctrl+X 的 $VISUAL/$EDITOR 解析与临时文件
 * 往返。覆盖：
 *
 * - splitEditorCommand：空白拆分 + 单双引号（`code --wait`、带空格路径）
 * - resolveEditorCommand：VISUAL 优先于 EDITOR、空白值跳过、POSIX 回退
 *   vi、Windows 无编辑器 → undefined
 * - resolveWindowsShim：PATH/PATHEXT 解析（code → code.cmd 走 cmd.exe，
 *   code.exe 直接 spawn），显式扩展名原样通过
 * - cross-spawn 引用协议：cmdEscapeCommand/cmdEscapeArgument 的
 *   qntm.org/cmd 转义规则、node_modules/.bin shim 双转义、
 *   buildCmdExeSpawn 的 comspec + /d /s /c + windowsVerbatimArguments
 * - editInExternalEditor 端到端（node 假编辑器进程）：
 *   追加写入 → edited；未改动 → unchanged；非零退出（:cq）→ unchanged；
 *   编辑器不存在 → failed；尾部换行边界（草稿自带 \n 不得误判、编辑器
 *   终止换行剥离、Shift+Enter 空行保留）；CRLF 三边界（内部/单个尾部/
 *   多个尾部）无操作保存不得算编辑
 * - 异常安全（never-throws 契约）：EDITOR='""' 同步 spawn 失败 → failed
 *   且不泄漏临时目录；TMPDIR 不可写 → failed；EDITOR=/bin/rm 删稿 →
 *   unchanged；假 Ink 实例下 enter 抛错 → failed 且 exit 仍被调用、
 *   exit 抛错 → outcome 正常返回不被覆盖
 *
 * CI 无 TTY：假 Ink 实例直接注册进 instances map 覆盖移交路径；真编辑器
 * 一律是 node 跑的脚本文件，EDITOR 串里的路径加双引号（Windows 默认
 * Node 安装路径含空格，拆分时不能断）。
 *
 * Run with plain node against the compiled lib: `node scripts/verify-external-editor.mjs`
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCmdExeSpawn,
  editInExternalEditor,
  resolveEditorCommand,
  resolveWindowsShim,
  splitEditorCommand,
} from '../lib/types/utils/externalEditor.js'
import { cmdEscapeArgument, cmdEscapeCommand } from '../lib/types/utils/shellQuote.js'
import instances from '../lib/types/ink/instances.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** tmp 下 dsh-tui-prompt-* 目录计数——泄漏断言用。 */
const promptDirCount = () =>
  readdirSync(tmpdir()).filter(name => name.startsWith('dsh-tui-prompt-')).length

// ── splitEditorCommand ────────────────────────────────────────────────
check('split: 空白拆分带参数', eq(splitEditorCommand('code --wait'), ['code', '--wait']))
check('split: 双引号包住带空格路径', eq(splitEditorCommand('"/opt/my editor/nvim" -f'), ['/opt/my editor/nvim', '-f']))
check('split: 单引号参数', eq(splitEditorCommand("nano '--restricted'"), ['nano', '--restricted']))
check('split: 空串 → 空数组', eq(splitEditorCommand('   '), []))
check('split: 空引号 → 空串参数', eq(splitEditorCommand('""'), ['']))

// ── resolveEditorCommand ─────────────────────────────────────────────
check('resolve: VISUAL 优先', eq(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' }), ['vim']))
check('resolve: VISUAL 空白跳过用 EDITOR', eq(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'nano' }), ['nano']))
check('resolve: 带参数整串解析', eq(resolveEditorCommand({ EDITOR: 'code --wait' }), ['code', '--wait']))
check('resolve: Windows 无编辑器 → undefined', resolveEditorCommand({}, 'win32') === undefined)
if (process.platform !== 'win32') {
  check('resolve: POSIX 兜底 vi', eq(resolveEditorCommand({}), ['vi']))
}

// ── cross-spawn 引用协议（纯函数）──────────────────────────────────────
check(
  'cmd-escape: 带空格命令路径 → 插入符转义',
  cmdEscapeCommand('C:\\VS Code\\bin\\code.cmd') === 'C:\\VS^ Code\\bin\\code.cmd',
  cmdEscapeCommand('C:\\VS Code\\bin\\code.cmd'),
)
check('cmd-escape: 无元字符参数 → 引用+插入符', cmdEscapeArgument('--wait') === '^"--wait^"', cmdEscapeArgument('--wait'))
check(
  'cmd-escape: 内嵌引号 → 反斜杠转义再整体引用',
  cmdEscapeArgument('say "hi"') === '^"say^ \\^"hi\\^"^"',
  cmdEscapeArgument('say "hi"'),
)
check(
  'cmd-escape: 尾部反斜杠翻倍',
  cmdEscapeArgument('C:\\') === '^"C:\\\\^"',
  cmdEscapeArgument('C:\\'),
)
check(
  'cmd-escape: node_modules/.bin shim 双转义',
  cmdEscapeArgument('--wait', true) === '^^^"--wait^^^"',
  cmdEscapeArgument('--wait', true),
)
{
  const spawnDesc = buildCmdExeSpawn('C:\\VS Code\\bin\\code.cmd', ['--wait', 'C:\\T m p\\f.md'], {})
  check(
    'cmd-spawn: comspec 默认 + /d /s /c + 单对外层引用 + verbatim',
    spawnDesc.file === 'cmd.exe' &&
      eq(spawnDesc.args, ['/d', '/s', '/c', '"C:\\VS^ Code\\bin\\code.cmd ^"--wait^" ^"C:\\T^ m^ p\\f.md^""']) &&
      spawnDesc.verbatim === true,
    JSON.stringify(spawnDesc),
  )
}
{
  const shimDesc = buildCmdExeSpawn('proj\\node_modules\\.bin\\tsc.cmd', ['--watch'], { comspec: 'C:\\Windows\\System32\\cmd.exe' })
  check(
    'cmd-spawn: .bin shim 参数双转义 + 尊重 comspec',
    shimDesc.file === 'C:\\Windows\\System32\\cmd.exe' &&
      eq(shimDesc.args, ['/d', '/s', '/c', '"proj\\node_modules\\.bin\\tsc.cmd ^^^"--watch^^^""']),
    JSON.stringify(shimDesc),
  )
}
{
  // cross-spawn 的 path.normalize 步骤：显式正斜杠 Windows 路径必须先
  // 规范化再转义，否则 cmd 侧可能 ENOENT。
  const fwd = buildCmdExeSpawn('C:/Program Files/Microsoft VS Code/bin/code.cmd', ['--wait'], {})
  check(
    'cmd-spawn: 正斜杠路径先 win32.normalize 再转义',
    eq(fwd.args, ['/d', '/s', '/c', '"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.cmd ^"--wait^""']),
    JSON.stringify(fwd),
  )
}
{
  // 空字符串 ComSpec 也要回退 cmd.exe（cross-spawn 用 || 而非 ??）。
  const emptyComspec = buildCmdExeSpawn('x.cmd', [], { comspec: '' })
  check(
    'cmd-spawn: 空 ComSpec 回退 cmd.exe',
    emptyComspec.file === 'cmd.exe' && eq(emptyComspec.args, ['/d', '/s', '/c', '"x.cmd"']),
    JSON.stringify(emptyComspec),
  )
}

// ── resolveWindowsShim（PATH 里有 code.cmd / code.exe 的模拟目录）─────
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-editor-'))
const shimDir = join(scratch, 'shim-bin')
mkdirSync(shimDir)
writeFileSync(join(shimDir, 'code.cmd'), '@echo off\r\n')
writeFileSync(join(shimDir, 'gvim.exe'), 'MZ')
const shimEnv = { PATH: shimDir, PATHEXT: '.EXE;.CMD' }
{
  const cmd = resolveWindowsShim('code', shimEnv)
  check('shim: code → code.cmd 走 cmd.exe', cmd.viaCmd && /code\.cmd$/i.test(cmd.command), JSON.stringify(cmd))
}
{
  const exe = resolveWindowsShim('gvim', shimEnv)
  check('shim: gvim → gvim.exe 直接 spawn', !exe.viaCmd && /gvim\.exe$/i.test(exe.command), JSON.stringify(exe))
}
{
  const explicit = resolveWindowsShim('nvim.cmd', shimEnv)
  check('shim: 显式 .cmd 扩展名原样通过', explicit.viaCmd && explicit.command === 'nvim.cmd')
}
{
  const missing = resolveWindowsShim('not-on-path', shimEnv)
  check('shim: 解析不到回退裸命令', !missing.viaCmd && missing.command === 'not-on-path')
}

// ── editInExternalEditor 端到端（假编辑器）─────────────────────────────
// 假编辑器：node 跑一段脚本文件，按 mode 对目标文件追加/不动/补终止换行/
// 非零退出。用文件而非 -e 内联脚本，避免引号嵌套干扰 splitEditorCommand。
const helper = join(scratch, 'fake-editor.cjs')
writeFileSync(helper, `
const fs = require('node:fs')
const [mode, file] = process.argv.slice(2)
if (mode === 'append') fs.appendFileSync(file, '\\nedited\\n')
if (mode === 'replace') fs.writeFileSync(file, 'replaced content\\n')
if (mode === 'ensure-newline') {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.endsWith('\\n')) fs.appendFileSync(file, '\\n')
}
if (mode === 'fail') process.exit(3)
`)

const savedEnv = {
  VISUAL: process.env.VISUAL,
  EDITOR: process.env.EDITOR,
  TMPDIR: process.env.TMPDIR,
}
function useEditor(spec) {
  delete process.env.VISUAL
  process.env.EDITOR = spec
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// 路径一律加引号：含空格的安装路径（Windows 默认 Node 目录）不得被拆断。
const base = `"${process.execPath}" "${helper}"`

useEditor(`${base} append`)
const appended = await editInExternalEditor('hello')
check(
  '往返: 追加写入 → edited，编辑器补的终止换行剥离',
  appended.kind === 'edited' && appended.text === 'hello\nedited',
  JSON.stringify(appended),
)

useEditor(`${base} replace`)
const replaced = await editInExternalEditor('')
check(
  '往返: 空草稿被整体替换 → edited',
  replaced.kind === 'edited' && replaced.text === 'replaced content',
  JSON.stringify(replaced),
)

useEditor(`${base} noop`)
const untouched = await editInExternalEditor('keep me')
check('往返: 未改动 → unchanged', untouched.kind === 'unchanged', JSON.stringify(untouched))

useEditor(`${base} noop`)
const trailingKept = await editInExternalEditor('keep\n')
check(
  '往返: 草稿自带尾部换行 + 无操作保存 → unchanged（不得误判 edited 丢换行）',
  trailingKept.kind === 'unchanged',
  JSON.stringify(trailingKept),
)

useEditor(`${base} ensure-newline`)
const ensuredNewline = await editInExternalEditor('hello')
check(
  '往返: 编辑器仅补终止换行 → unchanged（不算编辑）',
  ensuredNewline.kind === 'unchanged',
  JSON.stringify(ensuredNewline),
)

useEditor(`${base} append`)
const multilineTail = await editInExternalEditor('tail\n\n')
check(
  '往返: 草稿自带尾部空行（Shift+Enter）在编辑后保留',
  multilineTail.kind === 'edited' && multilineTail.text.startsWith('tail\n\n'),
  JSON.stringify(multilineTail),
)

// CRLF 边界：换行约定差异永远不算编辑（两侧都规范化比较）。
useEditor(`${base} noop`)
const crlfInner = await editInExternalEditor('a\r\nb')
check('CRLF: 内部 \\r\\n 无操作保存 → unchanged', crlfInner.kind === 'unchanged', JSON.stringify(crlfInner))

useEditor(`${base} noop`)
const crlfTail = await editInExternalEditor('keep\r\n')
check('CRLF: 单个尾部 \\r\\n 无操作保存 → unchanged', crlfTail.kind === 'unchanged', JSON.stringify(crlfTail))

useEditor(`${base} noop`)
const crlfMulti = await editInExternalEditor('x\r\n\r\n')
check('CRLF: 多个尾部 \\r\\n 无操作保存 → unchanged', crlfMulti.kind === 'unchanged', JSON.stringify(crlfMulti))

useEditor(`${base} append`)
const crlfEdited = await editInExternalEditor('keep\r\n')
check(
  'CRLF: 草稿带 \\r\\n 且确有编辑 → edited（结果规范化为 LF）',
  crlfEdited.kind === 'edited' && crlfEdited.text === 'keep\n\nedited\n',
  JSON.stringify(crlfEdited),
)

useEditor(`${base} fail`)
const aborted = await editInExternalEditor('keep me')
check('往返: 非零退出（:cq）→ unchanged 保留原稿', aborted.kind === 'unchanged', JSON.stringify(aborted))

useEditor('/nonexistent-editor-dsh-tui-xyz')
const broken = await editInExternalEditor('draft')
check(
  '往返: 编辑器不存在 → failed 并报出命令名',
  broken.kind === 'failed' && broken.message.includes('nonexistent-editor-dsh-tui-xyz'),
  JSON.stringify(broken),
)

// 审阅复现：EDITOR='""' → 空命令 spawn 同步失败 → failed，且临时目录
// 不泄漏（dir 句柄已提升 + finally 兜底清理）。
useEditor('""')
const dirsBeforeEmpty = promptDirCount()
const emptyCmd = await editInExternalEditor('draft')
check('异常: EDITOR=空引号 → failed 不抛出', emptyCmd.kind === 'failed', JSON.stringify(emptyCmd))
check(
  '异常: 空命令失败后无临时目录泄漏',
  promptDirCount() === dirsBeforeEmpty,
  `before=${dirsBeforeEmpty} after=${promptDirCount()}`,
)

if (process.platform !== 'win32') {
  // 审阅复现：EDITOR=/bin/rm 删掉草稿文件并成功退出，readFile 的
  // ENOENT 曾以未处理拒绝终结进程；现在必须映射为 unchanged。
  useEditor('/bin/rm')
  const removed = await editInExternalEditor('draft')
  check(
    '异常: EDITOR=/bin/rm（文件被删）→ unchanged 不抛出',
    removed.kind === 'unchanged',
    JSON.stringify(removed),
  )

  // mkdtemp 失败必须映射为 failed 结果而不是未处理拒绝。
  process.env.TMPDIR = '/nonexistent-tmpdir-dsh-tui-xyz'
  useEditor(`${base} noop`)
  const fsFailed = await editInExternalEditor('draft')
  check(
    '异常: 临时目录不可写 → failed（不抛出、不杀进程）',
    fsFailed.kind === 'failed' && fsFailed.message.includes('nonexistent-tmpdir'),
    JSON.stringify(fsFailed),
  )
  process.env.TMPDIR = savedEnv.TMPDIR ?? tmpdir()
  if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR
}

// ── 终端移交契约（假 Ink 实例）─────────────────────────────────────────
// enter 抛错：outcome=failed、exit 仍被尝试（部分失败的 enter 可能已挂起
// stdin）、临时目录清理。exit 抛错：outcome 不被覆盖、Promise 不拒绝。
{
  const calls = []
  instances.set(process.stdout, {
    enterAlternateScreen() { calls.push('enter'); throw new Error('enter exploded') },
    exitAlternateScreen() { calls.push('exit') },
  })
  const dirsBefore = promptDirCount()
  let outcome
  try {
    useEditor(`${base} noop`)
    outcome = await editInExternalEditor('draft')
  } catch (error) {
    outcome = { kind: 'rejected', message: String(error) }
  } finally {
    instances.delete(process.stdout)
  }
  check(
    '终端: enter 抛错 → failed 且 exit 仍被调用',
    outcome.kind === 'failed' && eq(calls, ['enter', 'exit']),
    JSON.stringify({ outcome, calls }),
  )
  check('终端: enter 抛错后无临时目录泄漏', promptDirCount() === dirsBefore)
}
{
  const calls = []
  instances.set(process.stdout, {
    enterAlternateScreen() { calls.push('enter') },
    exitAlternateScreen() { calls.push('exit'); throw new Error('restore failed') },
  })
  const dirsBefore = promptDirCount()
  let outcome
  try {
    useEditor(`${base} noop`)
    outcome = await editInExternalEditor('draft')
  } catch (error) {
    outcome = { kind: 'rejected', message: String(error) }
  } finally {
    instances.delete(process.stdout)
  }
  check(
    '终端: exit 抛错 → outcome 不被覆盖、不拒绝',
    outcome.kind === 'unchanged' && eq(calls, ['enter', 'exit']),
    JSON.stringify({ outcome, calls }),
  )
  check('终端: exit 抛错后无临时目录泄漏', promptDirCount() === dirsBefore)
}

restoreEnv()
rmSync(scratch, { recursive: true, force: true })

console.log(failed === 0 ? 'OK' : `FAILED: ${failed} check(s)`)
process.exit(failed === 0 ? 0 : 1)
