/** #1920: render an installed CLI with an unavailable SDK in the real launchpad.
 * Offline, isolated HOME, real renderer/xterm; no CLI install, login or model.
 * Run: node --import tsx/esm scripts/verify-claude-sdk-status.tsx
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { settled, viewportLines } from './lib/term-test.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
const [
  { render, AlternateScreen, ThemeProvider },
  { Launchpad },
  { buildKernelCatalog, kernelEntriesOf },
  { listBackends },
  { setLang, t },
  { stringWidth },
] = await Promise.all([
  import('../src/ui.js'), import('../src/screens/Launchpad.js'),
  import('../src/components/kernelCatalog.js'), import('../src/dsh-adapter/backend-registry.js'),
  import('../src/i18n.js'), import('../src/ink/stringWidth.js'),
])
const { Terminal } = xterm
class Output extends Writable {
  isTTY = true
  constructor(readonly terminal: InstanceType<typeof Terminal>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void { this.terminal.write(String(chunk), done) }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}
class Errors extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void): void { done() }
}
let cases = 0
for (const lang of ['zh', 'en'] as const) {
  setLang(lang)
  for (const fullscreen of [false, true]) {
    for (const columns of [80, 36]) {
      const kernels = buildKernelCatalog({ current: 'dsh', entries: kernelEntriesOf(listBackends()), canInstallSdk: true,
        statuses: { claude: { installed: false, version: '2.1.311' } } })
      const terminal = new Terminal({ cols: columns, rows: 32, scrollback: 0, allowProposedApi: true })
      const label = `${lang} ${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
      const page = <Launchpad query="" focusIndex={-1} isTerminalFocused={true} whale={false} whaleIdle={false}
        whaleGirl={false} starred={false} firstRun={false} actions={[]} egg={null} fontId="bold" kernels={kernels}
        tuiVersion="0.20.0" onFocusChange={() => {}} onAction={() => {}} onQueryChange={() => {}}
        onSubmit={() => {}} onEscape={() => {}} onBlankClick={() => {}} />
      const app = await render(<ThemeProvider theme="dark">{fullscreen ? <AlternateScreen>{page}</AlternateScreen> : page}</ThemeProvider>, {
        stdin: new Input() as never, stdout: new Output(terminal) as never, stderr: new Errors() as never,
        exitOnCtrlC: false, patchConsole: false,
      })
      try {
        assert.ok(await settled(() => viewportLines(terminal).some(line => line.includes('Claude'))), label)
        const lines = viewportLines(terminal)
        const line = lines.find(text => text.includes('Claude')) ?? ''
        assert.ok(lines.every(text => stringWidth(text) <= columns), `${label}: no overflow`)
        assert.ok(line.includes('Claude'), `${label}: kernel row remains present`)
        if (columns === 80) {
          assert.ok(line.includes('claude-code v2.1.311'), `${label}: installed CLI version`)
          assert.ok(line.includes(t('kernel-not-installed-installable')), `${label}: SDK-specific install action`)
          console.log(`SCREEN ${label}\n${line.trim()}\nEND SCREEN`)
        }
        const option = kernels.find(row => row.id === 'claude')!
        assert.equal(option.selectable, false, `${label}: CLI alone cannot start the SDK backend`)
        assert.equal(option.installable, true, `${label}: install wizard remains available`)
        cases++
        console.log(`PASS ${label}`)
      } finally { app.unmount(); terminal.dispose() }
    }
  }
}
console.log(`Claude SDK status OK (${cases} real render cases)`)
