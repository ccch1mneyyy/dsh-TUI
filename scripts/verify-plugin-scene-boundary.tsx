/**
 * Plugin scene boundary regression (dsh-tui-scenes): a scene component that
 * throws during render must be caught by PluginSceneBoundary — onError fires
 * exactly once with the scene id and the thrown error, the boundary stops
 * painting the scene afterwards, and the app process survives. A healthy
 * scene renders untouched, and a second scene id never crosses the report.
 *
 * Without the boundary the error bubbles to ink's app-level boundary
 * (src/ink/components/App.tsx), whose componentDidCatch runs the crash-exit
 * path — one plugin's render bug would take the whole TUI down.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-scene-boundary.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { render, Text }, { PluginSceneBoundary }, { settled }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/PluginSceneBoundary.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const frames: string[] = []
class FakeStdout extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    frames.push(String(chunk))
    cb()
  }
}
class FakeStderr extends Writable {
  isTTY = true
  override _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}

// --- 1. healthy scene renders through untouched ----------------------------
const healthy = await render(
  <PluginSceneBoundary id="ok" onError={() => { check('healthy scene never reports', false) }}>
    <Text>scene-ok-content</Text>
  </PluginSceneBoundary>,
  { stdout: new FakeStdout() as never, stderr: new FakeStderr() as never, patchConsole: false, exitOnCtrlC: false },
)
check('healthy scene content painted', await settled(() => frames.join('').includes('scene-ok-content')))
await healthy.unmount()

// --- 2. throwing scene is caught, reported once, and stops painting --------
frames.length = 0
const reports: Array<{ id: string; message: string }> = []
function Thrower(): React.ReactNode {
  throw new Error('boom-场景炸了')
}
const crashed = await render(
  <PluginSceneBoundary
    id="demo"
    onError={(id, error) => { reports.push({ id, message: error.message }) }}
  >
    <Thrower />
  </PluginSceneBoundary>,
  { stdout: new FakeStdout() as never, stderr: new FakeStderr() as never, patchConsole: false, exitOnCtrlC: false },
)
check('boundary reports the crash exactly once', await settled(() => reports.length === 1), `reports=${reports.length}`)
check('report carries scene id and error message',
  reports[0]?.id === 'demo' && reports[0]?.message.includes('boom-场景炸了'),
  JSON.stringify(reports[0]))
check('crashed scene paints nothing afterwards', !frames.join('').includes('boom-'))
await crashed.unmount()

if (failed > 0) {
  console.log(`\n${failed} boundary check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll plugin-scene boundary checks passed')
