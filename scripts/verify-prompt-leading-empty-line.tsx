/** Up into an empty first line, including the tail of an atomic paste (#1743).
 * Real PromptInput/stdin and headless terminal; asserts the resulting edit.
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import type { PromptController } from '../src/components/PromptInput.js'

process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [React, { PassThrough, Writable }, { Terminal }, { render, AlternateScreen }, { PromptInput }, { settled, viewportLines }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/PromptInput.js'), import('./lib/term-test.mjs'),
])
let failures = 0
let checks = 0
for (const [fullscreen, columns] of [[false, 80], [true, 24]] as const) {
  const term = new Terminal({ cols: columns, rows: 24, allowProposedApi: true })
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { term.write(String(chunk), done) } }), { isTTY: true, columns, rows: 24 })
  const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
  class Stdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new Stdin()
  const controller = { current: null as PromptController | null }
  const channel = {
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    commandList: [], commandCompletions: () => [], notifications: [], pending: [],
    working: false, notify() {}, submit() {}, steer() {}, interruptAndDeliver() { return 0 },
    removePending() { return false }, stageImage() {}, listFiles: async () => [], sessionColor: '',
  }
  const prompt = <PromptInput channel={channel as never} controllerRef={controller} helpOpen={false}
    onToggleHelp={() => {}} onRunCommand={() => false} selectionActive={false} />
  const app = await render(fullscreen ? <AlternateScreen>{prompt}</AlternateScreen> : prompt,
    { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, exitOnCtrlC: false, patchConsole: false })
  const screen = () => viewportLines(term).join('\n')
  try {
    assert.ok(await settled(() => controller.current !== null), 'controller ready')
    for (const folded of [false, true]) {
      for (const scenario of ['empty-home', 'empty-end', 'two-empty', 'clamp-column'] as const) {
        controller.current!.clear()
        const tag = `case${checks}`
        const prefix = folded ? Array.from({ length: 12 }, (_, i) => `${tag}-fold-${i}`).join('\n') : ''
        if (folded) {
          stdin.write(`\x1b[200~${prefix}\x1b[201~`)
          assert.ok(await settled(() => controller.current!.text() === prefix && screen().includes('▸')), `paste is an atomic block: ${screen()}`)
        }
        const last = `abcd-${tag}`
        const tail = scenario === 'two-empty' ? `\n\n${last}` : scenario === 'clamp-column' ? `xy\n${last}` : `\n${last}`
        controller.current!.append(tail)
        assert.ok(await settled(() => screen().includes(last)), 'current draft committed')
        const keys = (scenario === 'empty-home' ? '\x1b[H' : '') + '\x1b[A' + (scenario === 'two-empty' ? '\x1b[A' : '') + 'X'
        stdin.write(keys)
        assert.ok(await settled(() => controller.current!.text().includes('X')), 'edit after Up processed')
        const expected = prefix + (scenario === 'clamp-column' ? `xyX\n${last}` : `X${tail}`)
        const actual = controller.current!.text()
        checks++
        const ok = actual === expected
        if (!ok) failures++
        console.log(`${ok ? 'PASS' : 'FAIL'} ${fullscreen ? 'fullscreen' : 'inline'} ${columns} ${folded ? 'fold-tail' : 'ordinary'} ${scenario}: ${JSON.stringify({ expected, actual })}`)
      }
    }
  } finally {
    app.unmount()
    term.dispose()
  }
}
console.log(`verify-prompt-leading-empty-line: ${checks} checks, ${failures} failures`)
process.exitCode = failures === 0 ? 0 : 1
