/**
 * 外部编辑器回归（issue #123）：Ctrl+X 的 $VISUAL/$EDITOR 解析与临时文件
 * 往返。覆盖：
 *
 * - splitEditorCommand：空白拆分 + 单双引号（`code --wait`、带空格路径）
 * - resolveEditorCommand：VISUAL 优先于 EDITOR、空白值跳过、POSIX 回退 vi
 * - editInExternalEditor 端到端（node 假编辑器进程）：
 *   追加写入 → edited 且尾部换行被剥离；未改动 → unchanged；
 *   非零退出（`:cq` 语义）→ unchanged 保留原稿；编辑器不存在 → failed
 *
 * CI 无 TTY：instances.get 拿不到 Ink 实例，util 跳过 alt-screen 移交直接
 * inherit stdio，编辑器往返路径照常受测。
 *
 * Run with plain node against the compiled lib: `node scripts/verify-external-editor.mjs`
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  editInExternalEditor,
  resolveEditorCommand,
  splitEditorCommand,
} from '../lib/types/utils/externalEditor.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── splitEditorCommand ────────────────────────────────────────────────
check('split: 空白拆分带参数', eq(splitEditorCommand('code --wait'), ['code', '--wait']))
check('split: 双引号包住带空格路径', eq(splitEditorCommand('"/opt/my editor/nvim" -f'), ['/opt/my editor/nvim', '-f']))
check('split: 单引号参数', eq(splitEditorCommand("nano '--restricted'"), ['nano', '--restricted']))
check('split: 空串 → 空数组', eq(splitEditorCommand('   '), []))

// ── resolveEditorCommand ─────────────────────────────────────────────
check('resolve: VISUAL 优先', eq(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' }), ['vim']))
check('resolve: VISUAL 空白跳过用 EDITOR', eq(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'nano' }), ['nano']))
check('resolve: 带参数整串解析', eq(resolveEditorCommand({ EDITOR: 'code --wait' }), ['code', '--wait']))
if (process.platform !== 'win32') {
  check('resolve: POSIX 兜底 vi', eq(resolveEditorCommand({}), ['vi']))
}

// ── editInExternalEditor 端到端（假编辑器）─────────────────────────────
// 假编辑器：node 跑一段内联脚本，按 mode 对目标文件追加/不动/非零退出。
// 用文件而非 -e 内联脚本，避免引号嵌套干扰 splitEditorCommand 的测试面。
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-editor-'))
const helper = join(scratch, 'fake-editor.cjs')
writeFileSync(helper, `
const fs = require('node:fs')
const [mode, file] = process.argv.slice(2)
if (mode === 'append') fs.appendFileSync(file, '\\nedited\\n')
if (mode === 'replace') fs.writeFileSync(file, 'replaced content\\n')
if (mode === 'fail') process.exit(3)
`)

const savedEnv = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR }
function useEditor(spec) {
  delete process.env.VISUAL
  process.env.EDITOR = spec
}
function restoreEnv() {
  if (savedEnv.VISUAL === undefined) delete process.env.VISUAL
  else process.env.VISUAL = savedEnv.VISUAL
  if (savedEnv.EDITOR === undefined) delete process.env.EDITOR
  else process.env.EDITOR = savedEnv.EDITOR
}

const base = `${process.execPath} ${helper}`

useEditor(`${base} append`)
const appended = await editInExternalEditor('hello')
check(
  '往返: 追加写入 → edited，尾部换行剥离',
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

restoreEnv()
rmSync(scratch, { recursive: true, force: true })

console.log(failed === 0 ? 'OK' : `FAILED: ${failed} check(s)`)
process.exit(failed === 0 ? 0 : 1)
