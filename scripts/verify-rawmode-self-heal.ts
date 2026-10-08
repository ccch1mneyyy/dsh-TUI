/**
 * verify-rawmode-self-heal — >5s idle-gap 自愈必须连 raw mode 一起重申。
 *
 * 现象：共享 pty 的 termios 被外部写回 cooked/ECHO 后，存活进程的 raw 模式
 * 被踩掉，行规程把鼠标上报回显成 `^[[<…M`、键入要等换行才送达。
 * `reassertTerminalModes` 是 idle-gap 自愈路径上唯一的收敛点，必须把 raw
 * mode 一并重申 —— SIGCONT 路径（`handleResume`）早已如此，两条路径修的是
 * 同一个"终端被别人接管过"的洞。
 *
 * 机制与取舍见 src/ink/ink.tsx 的 reassertTerminalModes 与
 * src/ink/components/App.tsx 的 reassertRawMode。
 *
 * 用法:node --import tsx/esm scripts/verify-rawmode-self-heal.ts
 */
import { readFileSync } from 'node:fs'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

const ink = readFileSync(new URL('../src/ink/ink.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/ink/components/App.tsx', import.meta.url), 'utf8')

// 自愈入口:reassertTerminalModes 从方法定义到 `!altScreenActive` 提前返回
// 之间那段。重申写在这一段里，inline 与 fullscreen 两条分支才都覆盖得到。
const methodStart = ink.indexOf('reassertTerminalModes = (')
const altBranch = ink.indexOf('if (!this.altScreenActive)', methodStart)
const head = methodStart === -1 || altBranch === -1 ? '' : ink.slice(methodStart, altBranch)

check('定位到 reassertTerminalModes 的自愈入口', head !== '')
check('idle-gap 自愈重申 raw mode', /this\.app\?\.reassertRawMode\(\)/.test(head))

const pausedGuard = head.indexOf('if (this.isPaused) return;')
const rawReassert = head.indexOf('this.app?.reassertRawMode()')
check(
  '重申位于 isPaused 守卫之后（编辑器交接中不动终端）',
  pausedGuard !== -1 && rawReassert !== -1 && pausedGuard < rawReassert,
)
check(
  '重申位于 !altScreenActive 提前返回之前（inline/fullscreen 都覆盖）',
  /this\.app\?\.reassertRawMode\(\)/.test(head),
)

// 幂等前提:App.reassertRawMode 没有 raw 需求时必须直接返回，否则这条重申
// 会在不该开 raw 的时刻强开。
const appStart = app.indexOf('reassertRawMode = (')
const appGuard = appStart === -1 ? '' : app.slice(appStart, appStart + 240)
check('reassertRawMode 保留 rawModeEnabledCount 守卫', /rawModeEnabledCount === 0/.test(appGuard))
check('reassertRawMode 保留 isRawModeSupported 守卫', /isRawModeSupported\(\)/.test(appGuard))

// SIGCONT 路径的同类重申不得被这次改动顺手删掉。
check('SIGCONT 路径的 raw 重申仍在', /this\.app\?\.reassertRawMode\(\)/.test(ink.slice(0, methodStart)))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
