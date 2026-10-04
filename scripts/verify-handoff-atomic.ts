/**
 * verify-handoff-atomic.ts — S05 完整版回归：supervisor 单 owner 终端交接
 * （deploy-transition 设计 §S05「完整版」的 M1 落点）。
 *
 * 覆盖：
 *   - ACK 协议解析 parseHandoffAckLine（合法 adopted/ready、垃圾行、错前缀）；
 *   - 结局分类的第一帧事实（classifyReplacementOutcome.firstFrameAcked）：
 *     首帧已 flush → 任何死亡都是 post-boot（早期非零也是 crashed）；
 *     首帧未 flush → 无论多久都是 boot-failure（4 秒计时只是它的代理）；
 *     undefined → M0 计时语义逐字保留（/restart、/update、旧版 replacement）；
 *   - 子进程状态机（真 fd 写入）：armed→adopted→ready；ready 前不拥有
 *     1049 退出权；管道亡＝自持兜底；beginHandoffAck 一次性消费 env；
 *     armFirstFrameAck 对 adoption 前的写入直通、adoption 后首次写入的
 *     flush 回调触发 ready、补丁自恢复；
 *   - 真进程 e2e（父子角色同文件切换，argv/env 复刻真实 spawn 链）：
 *     · ready 场景：replacement 发 adopted→首帧→ready 后退出 0——旧父
 *       进程 stdout **不含 1049l**（括号已移交，不双重退出）；
 *     · ready 前死亡：exit 7——旧父 stdout 含 1049l（收口），结局
 *       failed/boot-failure（不看计时）；
 *     · 旧版 replacement（不说话协议）：同收口 + boot-failure 分类；
 *   - 源接线 tripwire：AlternateScreen 的 adoption 门、plugin.ts 的
 *     beginHandoffAck/armFirstFrameAck/keepAltScreen、update.ts 的 ACK
 *     管道 spawn 与失败收口、restartChildEnv 的陈旧标记清除。
 *
 * 运行：node --import tsx/esm scripts/verify-handoff-atomic.ts
 * （e2e 子进程以隔离 USERPROFILE/HOME 运行，不碰真实 restart.log）。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readFileSync as readFileText, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyReplacementOutcome, formatHandoffNotice, handoffEventTag } from '../src/handoffEvents.js'
import {
  HANDOFF_ACK_FD_ENV,
  HANDOFF_ATTEMPT_ENV,
  HANDOFF_SCREEN_ENV,
  __setHandoffAckStateForTest,
  armFirstFrameAck,
  beginHandoffAck,
  handoffAckArmed,
  noteScreenAdopted,
  ownsAltScreenExit,
  parseHandoffAckLine,
} from '../src/handoffAck.js'
import { restartChildEnv } from '../src/update.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (detail === '' ? '' : '  (' + detail + ')'))
  if (!ok) failures++
}
function outcomeOf(input: Parameters<typeof classifyReplacementOutcome>[0]) {
  return classifyReplacementOutcome(input) as { kind: string; reason?: string }
}


// ── 角色分派（必须先于一切单测：被 spawn 的驱动/替身进程保持输出干净）──
const selfPath = fileURLToPath(import.meta.url)
const isReplacement = process.env[HANDOFF_ACK_FD_ENV] !== undefined
const isParentDriver = process.argv.includes('--e2e-parent')
if (isReplacement) {
  // 子角色：由 restartTui 的真实 spawn 拉起（argv/env 就是生产链路）。
  const scenario = process.env.E2E_HANDOFF_SCENARIO ?? 'ready'
  const { writeSync } = await import('node:fs')
  const attempt = process.env[HANDOFF_ATTEMPT_ENV] ?? ''
  const ack = (kind: string) => writeSync(Number(process.env[HANDOFF_ACK_FD_ENV]), 'dsh-tui-handoff ' + kind + ' ' + attempt + '\n')
  if (process.env[HANDOFF_SCREEN_ENV] !== 'alt' || attempt === '') {
    process.stderr.write('replacement env contract broken\n')
    process.exit(64)
  }
  if (scenario === 'old-build') {
    setTimeout(() => process.exit(1), 50)
  } else if (scenario === 'die-pre-ready') {
    ack('adopted')
    setTimeout(() => process.exit(7), 150)
  } else if (scenario === 'interrupt-pre-ready') {
    // Ctrl+C during boot: the terminal delivers SIGINT to the whole process
    // group, the old parent included. Signal only the parent here, then die
    // the way an unhandled SIGINT would end the replacement.
    ack('adopted')
    process.kill(process.ppid, 'SIGINT')
    setTimeout(() => process.exit(130), 200)
  } else {
    ack('adopted')
    process.stdout.write('CHILD-FIRST-FRAME\n', () => ack('ready'))
    // 兜底：帧 write 的回调若被文件重定向吃掉，也要发 ready 并退出——
    // e2e 断言的是进程管道链路，flush 链契约由上面的单测证明。
    setTimeout(() => {
      ack('ready')
      process.exit(0)
    }, 120)
  }
  // 子角色到此为止：挂起等待退出定时器，绝不落入主角色的单测/e2e 代码。
  await new Promise<void>(() => {})
} else if (isParentDriver) {
  const scenario = process.argv[process.argv.indexOf('--e2e-parent') + 1] ?? 'ready'
  const { restartTui } = await import('../src/update.js')
  const code = await restartTui('sess-e2e', {
    backend: 'claude',
    handoffScreen: 'alt',
    env: { E2E_HANDOFF_SCENARIO: scenario },
  })
  process.stderr.write('E2E-RESULT ' + JSON.stringify({ scenario, code }) + '\n')
  process.exit(code)
}

// ── ACK 行解析 ────────────────────────────────────────────────────────────
check('parse: adopted line', parseHandoffAckLine('dsh-tui-handoff adopted hs-1')?.kind === 'adopted')
check('parse: ready line carries the attempt id', parseHandoffAckLine('dsh-tui-handoff ready hs-2')?.attemptId === 'hs-2')
check('parse: garbage is null (never misparsed)', parseHandoffAckLine('random terminal noise') === null)
check('parse: wrong prefix is null', parseHandoffAckLine('x-handoff ready hs-1') === null)
check('parse: unknown kind is null', parseHandoffAckLine('dsh-tui-handoff rolled-back hs-1') === null)

// ── 第一帧事实的结局分类 ──────────────────────────────────────────────────
check('frame flushed + clean exit → succeeded',
  outcomeOf({ closed: true, code: 0, signal: null, elapsedMs: 60000, firstFrameAcked: true }).kind === 'succeeded')
check('frame flushed + EARLY nonzero → crashed (post-boot, not boot-failure)',
  outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 900, firstFrameAcked: true }).kind === 'crashed')
check('frame flushed + late signal → crashed',
  outcomeOf({ closed: true, code: null, signal: 'SIGKILL', elapsedMs: 90000, firstFrameAcked: true }).kind === 'crashed')
check('no frame + LATE nonzero → failed/boot-failure (the 4s timer was only a proxy)',
  outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 90000, firstFrameAcked: false }).kind === 'failed'
  && outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 90000, firstFrameAcked: false }).reason === 'boot-failure')
check('no frame + clean exit → failed/boot-failure (nothing the user saw means the switch did not complete)',
  outcomeOf({ closed: true, code: 0, signal: null, elapsedMs: 60000, firstFrameAcked: false }).kind === 'failed')
check('undefined keeps the M0 window semantics (early nonzero → boot-failure)',
  outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 1200 }).kind === 'failed'
  && outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 1200 }).reason === 'boot-failure')
check('undefined keeps the M0 window semantics (late nonzero → crashed)',
  outcomeOf({ closed: true, code: 3, signal: null, elapsedMs: 9000 }).kind === 'crashed')
check('first-frame formats terminal-quiet (the flushed frame replaces the transition)',
  formatHandoffNotice('first-frame', { name: 'Claude' }) === '')
check('first-frame event tag joins the shared vocabulary', handoffEventTag('first-frame') === 'handoff/first-frame')

// ── 子进程状态机（真 fd）─────────────────────────────────────────────────
const stateTmp = mkdtempSync(join(tmpdir(), 'verify-handoff-atomic-'))
{
  const ackFile = join(stateTmp, 'acks.log')
  const fd = openSync(ackFile, 'w')
  __setHandoffAckStateForTest({ attemptId: 'att-1', fd, adoption: 'armed', dead: false })
  check('state: armed process does not own the 1049 exit', ownsAltScreenExit() === false)
  check('state: handoffAckArmed reflects the armed state', handoffAckArmed() === true)

  // stdout 观察：adoption 前的写入直通；adoption 后首次写入的 flush 回调触发 ready。
  const writes: string[] = []
  const stdoutLike = {
    write(chunk: unknown, ...rest: unknown[]): boolean {
      writes.push(String(chunk))
      const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined
      if (cb !== undefined) setImmediate(cb)
      return true
    },
  } as unknown as NodeJS.WriteStream
  armFirstFrameAck(stdoutLike)
  stdoutLike.write('probe-bytes')
  check('first-frame watch: pre-adoption writes pass through (probe ≠ frame)',
    !readFileText(ackFile, 'utf8').includes('ready'))
  noteScreenAdopted()
  check('ack: adopted line written to the pipe fd', readFileText(ackFile, 'utf8').includes('dsh-tui-handoff adopted att-1'))
  check('state: adopted (pre-ready) still does not own the 1049 exit', ownsAltScreenExit() === false)
  await new Promise<void>(resolve => { stdoutLike.write('FIRST-FRAME', () => resolve()) })
  const logged = readFileText(ackFile, 'utf8')
  check('ack: ready line written AFTER adopted (ownership transfer ordering)', logged.indexOf('ready') > logged.indexOf('adopted'))
  check('state: ready owns the 1049 exit', ownsAltScreenExit() === true)
  stdoutLike.write('later-frame')
  check('first-frame watch: patch self-restored (later writes unobserved)', writes.includes('later-frame'))
  closeSync(fd)
}
{
  // 管道先亡：ACK 不可写＝不误判移交，但退出权自持（兜底收口）。
  const goneFile = join(stateTmp, 'gone.log')
  const goneFd = openSync(goneFile, 'w')
  closeSync(goneFd)
  __setHandoffAckStateForTest({ attemptId: 'att-2', fd: goneFd, adoption: 'armed', dead: false })
  noteScreenAdopted()
  check('dead pipe: failed ACK keeps ownership local (self-close fallback)', ownsAltScreenExit() === true)
  __setHandoffAckStateForTest(undefined)
}
{
  // beginHandoffAck：一次性消费 env；非法 fd＝未武装。
  const env: Record<string, string | undefined> = {
    [HANDOFF_ACK_FD_ENV]: '3',
    [HANDOFF_ATTEMPT_ENV]: 'att-3',
    [HANDOFF_SCREEN_ENV]: 'alt',
  }
  __setHandoffAckStateForTest(undefined)
  const armed = beginHandoffAck(env as NodeJS.ProcessEnv)
  check('begin: env arms the protocol with the attempt id', armed?.attemptId === 'att-3' && armed.adoption === 'armed')
  check('begin: markers are consumed (one-shot, no leak to children)', env[HANDOFF_ACK_FD_ENV] === undefined && env[HANDOFF_SCREEN_ENV] === undefined && env[HANDOFF_ATTEMPT_ENV] === undefined)
  __setHandoffAckStateForTest(undefined)
  const invalid = beginHandoffAck({ [HANDOFF_ACK_FD_ENV]: 'not-a-fd' } as unknown as NodeJS.ProcessEnv)
  check('begin: invalid fd is not armed', invalid === undefined)
  check('begin: absent env is not armed', beginHandoffAck({} as NodeJS.ProcessEnv) === undefined)
  __setHandoffAckStateForTest(undefined)
}

// ── restartChildEnv：陈旧 handoff 标记不外泄 ─────────────────────────────
{
  const env = restartChildEnv({
    [HANDOFF_SCREEN_ENV]: 'alt', [HANDOFF_ACK_FD_ENV]: '3', [HANDOFF_ATTEMPT_ENV]: 'stale',
    KERNEL_SWITCH_HANDOFF_ENV_: 'x',
  } as unknown as NodeJS.ProcessEnv, 'sess-1', 'restart', {})
  check('restartChildEnv: stale handoff markers never leak into a plain replacement',
    env[HANDOFF_SCREEN_ENV] === undefined && env[HANDOFF_ACK_FD_ENV] === undefined && env[HANDOFF_ATTEMPT_ENV] === undefined)
}

// ── e2e：真进程父/子角色（argv/env 复刻生产 spawn 链）────────────────────
{
  const home = join(stateTmp, 'home')
  const runParent = (scenario: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home }
    delete env[HANDOFF_ACK_FD_ENV]; delete env[HANDOFF_SCREEN_ENV]; delete env[HANDOFF_ATTEMPT_ENV]
    return spawnSync(process.execPath, ['--import', 'tsx/esm', selfPath, '--e2e-parent', scenario], {
      encoding: 'utf8', timeout: 60000, env,
    })
  }
  {
    const run = runParent('ready')
    const text = run.stdout ?? ''
    const stderr = run.stderr ?? ''
    const result = /E2E-RESULT (.*)/.exec(stderr)?.[1]
    check('e2e ready: stage-start notice flushed before spawn', text.includes('⟳') || text.includes('Switching') || text.includes('正在'))
    check('e2e ready: the child frame reached the shared console', text.includes('CHILD-FIRST-FRAME'))
    check('e2e ready: the parent NEVER writes 1049l after the ready ACK (bracket transferred)',
      !text.includes('\u001b[?1049l'), JSON.stringify(text.slice(0, 120)))
    check('e2e ready: restartTui resolves the child code', result !== undefined && JSON.parse(result).code === 0, stderr.slice(-200))
    check('e2e ready: driver exits 0', run.status === 0)
  }
  {
    const run = runParent('die-pre-ready')
    const text = run.stdout ?? ''
    const stderr = run.stderr ?? ''
    const result = /E2E-RESULT (.*)/.exec(stderr)?.[1]
    check('e2e die-pre-ready: the parent restores the bracket exactly once (persistent main screen)',
      (text.match(/\u001b\[\?1049l/g) ?? []).length === 1, JSON.stringify(text.slice(0, 160)))
    check('e2e die-pre-ready: restartTui resolves the child code (7) with the failed/boot-failure path',
      result !== undefined && JSON.parse(result).code === 7, stderr.slice(-200))
  }
  {
    const run = runParent('interrupt-pre-ready')
    const text = run.stdout ?? ''
    const stderr = run.stderr ?? ''
    const result = /E2E-RESULT (.*)/.exec(stderr)?.[1]
    check('e2e interrupt-pre-ready: the old parent survives Ctrl+C and still restores the bracket once',
      run.signal === null && (text.match(/\u001b\[\?1049l/g) ?? []).length === 1, 'signal=' + String(run.signal) + ' ' + JSON.stringify(text.slice(0, 160)))
    check('e2e interrupt-pre-ready: restartTui resolves the child code (130)',
      result !== undefined && JSON.parse(result).code === 130, stderr.slice(-200))
  }
  {
    const run = runParent('old-build')
    const text = run.stdout ?? ''
    check('e2e old-build: protocol-silent replacement still gets the screen restored',
      (text.match(/\u001b\[\?1049l/g) ?? []).length === 1)
    check('e2e old-build: driver exits with the child code', run.status === 1)
  }
  rmSync(stateTmp, { recursive: true, force: true })
}

// ── 源接线 tripwire ───────────────────────────────────────────────────────
{
  const here = dirname(fileURLToPath(import.meta.url))
  const alt = readFileSync(join(here, '../src/ink/components/AlternateScreen.tsx'), 'utf8')
  check('AlternateScreen: adoption gates ENTER (no second 1049h)', /adopting \? '' : ENTER_ALT_SCREEN/.test(alt))
  check('AlternateScreen: pre-ready exit skips the 1049l (bracket owned by the old parent)', /ownsAltScreenExit\(\)\)/.test(alt) && alt.includes('noteScreenAdopted()'))
  const plugin = readFileSync(join(here, '../src/dsh-adapter/plugin.ts'), 'utf8')
  check('plugin.ts: boot consumes the handoff env (beginHandoffAck)', /beginHandoffAck()/.test(plugin))
  check('plugin.ts: first-frame watch armed before render', plugin.indexOf('armFirstFrameAck(process.stdout)') < plugin.indexOf('instance = await render(tree'))
  check('plugin.ts: switch branch passes handoffScreen + keepAltScreen (fullscreen only)',
    /const keepAlt = bootedFullscreen/.test(plugin) && /handoffScreen: 'alt'/.test(plugin) && /keepAltScreen: keepAlt/.test(plugin))
  check('plugin.ts: finishExit gates 1049l on ownsAltScreenExit', /ownsAltScreenExit\(\) \? EXIT_ALT_SCREEN : ''/.test(plugin))
  const update = readFileSync(join(here, '../src/update.ts'), 'utf8')
  check('update.ts: handoff spawn opens the ACK pipe (stdio[3])', /\['inherit', 'inherit', 'pipe', 'pipe'\]/.test(update))
  check('update.ts: close-without-ready restores the bracket', /if \(handoff && ackReadyAt === undefined\) restoreHandoffScreen\(\)/.test(update))
  check('update.ts: first-frame fact feeds the classification', /firstFrameAcked: ackReadyAt !== undefined/.test(update))
}

if (!isReplacement && !process.argv.includes('--e2e-parent')) {
  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
  process.exit(failures === 0 ? 0 : 1)
}
