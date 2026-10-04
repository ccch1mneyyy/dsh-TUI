/**
 * verify-handoff-transition — 内核切换过场 MVE 回归（S05「最小可见过场」）。
 *
 * 覆盖（纯函数 + 源接线两层）：
 *   - 结局三分 classifyReplacementOutcome：spawn 失败 / 4 秒窗内死亡＝
 *     failed（boot-failure）；干净退出或纯 signal 关闭＝succeeded；窗后
 *     非零＝crashed——4 秒窗保持诊断口径，不升级为启动成功事实；
 *   - 文案与配色 formatHandoffNotice：starting 两行（目标内核＋原会话
 *     保留）、stage-start 单行、failed 带分类 reason＋safe 提示、crashed
 *     带退出码、succeeded 空文案（新 UI 即成功信号）；color=false 时无
 *     ANSI 码（headless/管道消费干净文本），color=true 时各事件颜色互异
 *     （失败黄、崩溃红、进行中青）；
 *   - flush 契约 writeHandoffStage：resolve 必须发生在 write 回调之后
 *     （不是定时 sleep）；write 抛错也必须 resolve（过场永不阻塞交接）；
 *   - 源接线：plugin.ts 切换分支的 finishExit notice 走 starting 事件、
 *     update.ts 在 spawn 前写 stage-start 且结局走 handoff/ 事件分类
 *     （verify-handoff-stdin 同款源码 tripwire）。
 *
 * 运行：node --import tsx/esm scripts/verify-handoff-transition.ts
 */
import { readFileSync } from 'node:fs'
import { classifyReplacementOutcome, formatHandoffNotice, handoffEventTag, writeHandoffStage } from '../src/handoffEvents.js'
import { t } from '../src/i18n.js'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (extra === '' ? '' : '  (' + extra + ')'))
  if (!ok) failures++
}

function outcomeOf(input: Parameters<typeof classifyReplacementOutcome>[0]) {
  const outcome = classifyReplacementOutcome(input)
  return outcome as { kind: string; reason?: string; code?: number | null }
}

// ── 结局三分 ──────────────────────────────────────────────────────────────
check('spawn 失败 → failed/spawn-error',
  outcomeOf({ spawnError: new Error('x'), closed: false, code: null, signal: null, elapsedMs: 0 }).kind === 'failed')
check('窗内死亡 → failed/boot-failure（4 秒窗是诊断口径）',
  outcomeOf({ closed: true, code: 1, signal: null, elapsedMs: 1200 }).kind === 'failed'
  && outcomeOf({ closed: true, code: 1, signal: null, elapsedMs: 1200 }).reason === 'boot-failure')
check('干净退出 → succeeded（用户用过并正常关闭）',
  outcomeOf({ closed: true, code: 0, signal: null, elapsedMs: 60000 }).kind === 'succeeded')
check('纯 signal 关闭（无 code）→ crashed（信号致死不是干净成功）',
  outcomeOf({ closed: true, code: null, signal: 'SIGTERM', elapsedMs: 60000 }).kind === 'crashed')
check('窗后非零 → crashed（会话级崩溃，不是切换失败）',
  outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 90000 }).kind === 'crashed')

// ── 文案与配色 ────────────────────────────────────────────────────────────
const plainStart = formatHandoffNotice('starting', { name: 'Claude', color: false })
check('starting：两行——目标内核 + 原会话保留',
  plainStart.includes(t('kernel-handoff-starting', { name: 'Claude' })) && plainStart.includes(t('kernel-handoff-session-kept')) && plainStart.split('\n').length === 2,
  plainStart)
check('stage-start：单行目标内核',
  formatHandoffNotice('stage-start', { name: 'DSH', color: false }) === '⟳ ' + t('kernel-handoff-stage-start', { name: 'DSH' }))
const plainFailed = formatHandoffNotice('failed', { name: 'Claude', reason: 'boot-failure', safeHint: true, color: false })
check('failed：分类 reason（不是原始堆栈）+ safe 提示',
  plainFailed.includes(t('kernel-handoff-failed-reason-boot')) && plainFailed.includes(t('kernel-handoff-safe-hint')) && !plainFailed.includes('Error'))
const plainCrashed = formatHandoffNotice('crashed', { name: 'Claude', code: 7, safeHint: true, color: false })
check('crashed：退出码 + safe 提示', plainCrashed.includes('7') && plainCrashed.includes(t('kernel-handoff-safe-hint')))
check('succeeded：空文案（新 UI 即成功信号，不打扰）', formatHandoffNotice('succeeded', { name: 'X' }) === '')
const kinds = ['starting', 'stage-start', 'failed', 'crashed'] as const
for (const kind of kinds) {
  const plain = formatHandoffNotice(kind, { name: 'Claude', reason: 'boot-failure', code: 1, color: false })
  check(kind + '：无色模式不含 ANSI 码（headless/管道干净）', !/\u001b\[/.test(plain))
}
function ansiCode(text: string): string {
  const match = text.match(/\u001b\[([0-9;]+)m/)
  return match === null ? '' : match[1]
}
const coloredStarting = formatHandoffNotice('starting', { name: 'Claude', color: true })
const coloredFailed = formatHandoffNotice('failed', { name: 'Claude', reason: 'boot-failure', color: true })
const coloredCrashed = formatHandoffNotice('crashed', { name: 'Claude', code: 1, color: true })
check('彩色模式包含 ANSI 码', /\u001b\[/.test(coloredStarting) && /\u001b\[/.test(coloredFailed) && /\u001b\[/.test(coloredCrashed))
check('配色互异：进行中青（36）、失败黄（33）、崩溃红（31）',
  ansiCode(coloredStarting) === '36' && ansiCode(coloredFailed) === '33' && ansiCode(coloredCrashed) === '31',
  ansiCode(coloredStarting) + '/' + ansiCode(coloredFailed) + '/' + ansiCode(coloredCrashed))
check('事件 tag 采用共享 attemptId 词汇表', handoffEventTag('starting') === 'handoff/starting' && handoffEventTag('stage-start') === 'handoff/stage-start')

// ── flush 契约 ────────────────────────────────────────────────────────────
{
  let callbackFired = false
  const stream = {
    write(_text: string, onFlush: () => void): boolean {
      setImmediate(() => {
        callbackFired = true
        onFlush()
      })
      return true
    },
  }
  await writeHandoffStage(stream as unknown as NodeJS.WriteStream, 'stage')
  check('writeHandoffStage：resolve 晚于 flush 回调（不是 sleep）', callbackFired)
  const throwing = {
    write(): boolean {
      throw new Error('sink gone')
    },
  }
  let resolved = false
  await Promise.race([
    writeHandoffStage(throwing as unknown as NodeJS.WriteStream, 'x').then(() => { resolved = true }),
    new Promise(resolve => setTimeout(resolve, 200)),
  ])
  check('writeHandoffStage：sink 抛错也 resolve（过场不阻塞交接）', resolved)
}

// ── 源接线 tripwire（verify-handoff-stdin 同款）──────────────────────────
const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
check('plugin.ts 切换分支：finishExit notice 走 starting 事件', /backendSwitchRequested !== undefined[\s\S]{0,900}formatHandoffNotice\('starting'/.test(pluginSource))
const updateSource = readFileSync(new URL('../src/update.ts', import.meta.url), 'utf8')
check('update.ts：replacement spawn 前写已 flush 的 stage-start 行', /await writeHandoffStage\(\s*process\.stdout,\s*formatHandoffNotice\('stage-start'/.test(updateSource))
check('update.ts：结局走 classifyReplacementOutcome 三分', updateSource.includes('classifyReplacementOutcome(') && updateSource.includes('handoffEventTag(outcome.kind)'))
check('update.ts：/restart 与 /update 的旧文案保持不动（MVE 只动切换轨）',
  updateSource.includes('dsh-tui: restart child exited during the handoff') && updateSource.includes('the restarted session exited with code'))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
