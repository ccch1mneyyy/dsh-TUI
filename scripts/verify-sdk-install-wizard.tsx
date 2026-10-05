/**
 * SdkInstallWizard 回归（内核选择器「未安装」行进入的 SDK 安装向导）：
 *   1. 视觉照 ModePicker/MigrateConfirm：Pane + 标题（sdk-install-title）+
 *      正文 + Enter/Esc 提示行（hint 走 HintLine 的 **bold** 语法）；
 *   2. 每个步骤态的正文与提示行：confirm（版本/位置/说明）、checking/running
 *      （LoadingState 动画）、done、failed（退出码 + 手动命令 + pnpm 输出尾部）、
 *      pnpm-missing、cancelled、no-target 两种理由；
 *   3. 手动兜底命令（cd <dir> && pnpm add <specifier>）在 failed 与
 *      pnpm-missing 两态都出现——它是不管哪一步失败的最终出路；
 *   4. 窄终端（34 列）任何一行都不超宽（长 tail 行靠 truncate-end 截断）；
 *   5. en 态标题与提示行跟着换。
 *
 * 运行：node --import tsx/esm scripts/verify-sdk-install-wizard.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import type { SdkInstallPhase } from '../src/components/SdkInstallWizard.js'
import { settled, viewportLines } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [
  { render, AlternateScreen },
  { SdkInstallWizard },
  { t, setLang },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/components/SdkInstallWizard.js'),
  import('../src/i18n.js'),
])

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log('ok   ' + name)
  else {
    failures++
    console.error('FAIL ' + name + (extra === '' ? '' : '\n      ' + extra))
  }
}

class FakeStdout extends Writable {
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const DIR = 'C:\\Users\\test\\.dsh\\profiles\\dsh-tui'
const SPECIFIER = '@anthropic-ai/claude-agent-sdk@0.3.287'
const VERSION = '0.3.287'
const TAIL = ['Progress: resolved 9, reused 77', 'ERR_PNPM_LINKING_FAILED cannot overwrite directory']

/** 挂一份向导（真 render + 假 TTY），返回读屏与收尾。 */
async function mountWizard(phase: SdkInstallPhase, columns = 80, rows = 24) {
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const app = await render(
    <AlternateScreen mouseTracking={false}>
      <SdkInstallWizard phase={phase} />
    </AlternateScreen>,
    {
      stdin: new FakeStdin() as never,
      stdout: new FakeStdout(term) as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => viewportLines(term)
  await settled(() => lines().some(line => line.trim() !== ''))
  return { app, lines, term }
}

async function run(): Promise<void> {
  // 1. confirm：标题、版本、位置、说明与 Enter/Esc 提示。
  {
    const { app, lines } = await mountWizard({ kind: 'confirm', dir: DIR, version: VERSION, specifier: SPECIFIER })
    const screen = lines().join('\n')
    check('1a 标题', screen.includes(t('sdk-install-title')))
    check('1b 版本行', screen.includes(VERSION))
    check('1c 位置行', screen.includes(DIR))
    check('1d 说明（不随全局变化）', screen.includes('不随全局变化'))
    check('1e 提示行 Enter 安装', screen.includes('Enter') && screen.includes('安装'))
    await app.unmount()
  }
  // 2. checking / running：LoadingState 文案（动画帧不影响文字内容）。
  {
    const { app, lines } = await mountWizard({ kind: 'checking' })
    check('2a checking 文案', lines().join('\n').includes(t('sdk-install-checking')))
    await app.unmount()
  }
  {
    const { app, lines } = await mountWizard({ kind: 'running' })
    const screen = lines().join('\n')
    check('2b running 文案', screen.includes(t('sdk-install-running')))
    check('2c running 副标（Esc 取消）', screen.includes(t('sdk-install-running-sub')))
    await app.unmount()
  }
  // 3. done：完成文案与返回提示。
  {
    const { app, lines } = await mountWizard({ kind: 'done' })
    const screen = lines().join('\n')
    check('3a 完成文案', screen.includes(t('sdk-install-done')))
    check('3b 返回内核选择提示', screen.includes('返回内核选择'))
    await app.unmount()
  }
  // 4. failed：退出码、手动命令、tail 尾行与 r 重试提示。
  {
    const { app, lines } = await mountWizard({ kind: 'failed', exitCode: 1, tail: TAIL, dir: DIR, version: VERSION, specifier: SPECIFIER })
    const screen = lines().join('\n')
    check('4a 退出码', screen.includes('1'))
    // 命令约 90 列，80 列面板里必折行，且终端行尾有 pad 空格——
    // 双方压掉全部空白后比对，对任何折行位置免疫。
    const flat = (s: string): string => s.replaceAll(/\s+/gu, '')
    check('4b 手动命令', flat(screen).includes(flat(`cd ${DIR} && pnpm add ${SPECIFIER}`)))
    check('4c tail 尾行', screen.includes('ERR_PNPM_LINKING_FAILED'))
    check('4d r 重试提示', screen.includes('r 重试'))
    await app.unmount()
  }
  // 5. pnpm-missing：预检文案 + 同一条手动命令。
  {
    const { app, lines } = await mountWizard({ kind: 'pnpm-missing', dir: DIR, version: VERSION, specifier: SPECIFIER })
    const screen = lines().join('\n')
    check('5a 未检测到 pnpm', screen.includes('未检测到 pnpm'))
    check('5b 手动命令（与 failed 同款）', screen.replaceAll(/\s+/gu, '').includes(`pnpmadd${SPECIFIER}`))
    await app.unmount()
  }
  // 6. cancelled / no-target 两种理由。
  {
    const { app, lines } = await mountWizard({ kind: 'cancelled' })
    check('6a 已取消', lines().join('\n').includes(t('sdk-install-cancelled')))
    await app.unmount()
  }
  for (const reason of ['standalone', 'no-profile'] as const) {
    const { app, lines } = await mountWizard({ kind: 'no-target', reason })
    check(`6b no-target(${reason}) 理由文案`, lines().join('\n').includes(t(`sdk-install-no-target-${reason}`).slice(0, 8)))
    await app.unmount()
  }
  // 7. 窄终端（34 列）：长 tail 行 truncate-end 截断，任何一行不超宽。
  {
    const { app, lines, term } = await mountWizard(
      { kind: 'failed', exitCode: 1, tail: ['x'.repeat(120)], dir: DIR, version: VERSION, specifier: SPECIFIER },
      34, 24,
    )
    check('7 窄终端不超宽', lines().every(line => line.length <= term.cols), JSON.stringify(lines()))
    await app.unmount()
  }
  // 8. en：标题与提示行跟着换。
  {
    setLang('en')
    try {
      const { app, lines } = await mountWizard({ kind: 'confirm', dir: DIR, version: VERSION, specifier: SPECIFIER })
      const screen = lines().join('\n')
      check('8a en 标题', screen.includes('Install the Claude kernel'))
      check('8b en 位置行', screen.includes(`Install location: ${DIR}`))
      await app.unmount()
    } finally {
      setLang('zh')
    }
  }
}

await run()
if (failures > 0) {
  console.error(`\nverify-sdk-install-wizard: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-sdk-install-wizard: all passed')
