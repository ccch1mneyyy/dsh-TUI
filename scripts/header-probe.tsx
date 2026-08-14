/**
 * Header probe: renders the LogoHeader (opening animation -> settled title
 * bar) into an in-memory terminal and verifies both phases.
 * Run: node --import tsx/esm scripts/header-probe.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render, ThemeProvider }, { LogoHeader }, { LogoV2 }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/components/LogoV2.js'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 30
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const stdout = new FakeStdout()
const instance = await render(
  <ThemeProvider>
    <LogoHeader model="deepseek-v4-flash" effort="high" cwd="D:/code/projects/test" />
  </ThemeProvider>,
  {
    stdout,
    stdin: new FakeStdin(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Capture opening output (first ~1.5s: whale animating + block text).
await sleep(1500)
const openingLen = stdout.frames.length
const opening = stdout.frames.join('')

// Wait for the intro to finish (~3.4s sequence + margin), then watch for
// any further repaints (there must be none once settled).
await sleep(2600)
const settledLen = stdout.frames.length
await sleep(1200)
const afterSettleLen = stdout.frames.length
const all = stdout.frames.join('')

const plain = (s: string) =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const openingPlain = plain(opening)
// The settled state starts at the chunk where the whale's final standard
// pose lands; just take the last chunks (the whole text column repaints).
const settledPlain = plain(stdout.frames.slice(-6).join(''))

console.log('--- opening: has block font?', openingPlain.includes('█'))
console.log('--- opening: has whale SGR truecolor?', /\x1b\[38;2;78;111;255m/.test(opening))
console.log('--- opening: has wordmark dsh-TUI?', openingPlain.includes('dsh-TUI'))
console.log('--- frames during opening:', openingLen)
console.log('--- frames opening->settle:', settledLen - openingLen)
console.log('--- frames after settle (must be 0):', afterSettleLen - settledLen)

await instance.unmount()

// Phase B: mount straight into the settled header (skipIntro) and read the
// COMPLETE first paint — differential diffs can't show the full screen.
const stdout2 = new FakeStdout()
const instance2 = await render(
  <ThemeProvider>
    <LogoV2 model="deepseek-v4-flash" effort="high" cwd="D:/code/projects/test" skipIntro />
  </ThemeProvider>,
  {
    stdout: stdout2,
    stdin: new FakeStdin(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await sleep(600)
const raw2 = stdout2.frames.join('')
const full = plain(raw2)

console.log()
console.log('=== SETTLED FULL FIRST PAINT ===')
console.log(full)
// The model/tip text sits on the same terminal row as whale art (which
// legitimately uses truecolor SGR), so check the SGR state AFTER the last
// reset preceding the text — that is the text's own styling.
const sgrBefore = (needle: string): string => {
  const i = raw2.indexOf(needle)
  const before = raw2.slice(0, i)
  return before.slice(before.lastIndexOf('\x1b[0m'))
}
console.log('--- settled: has block font?', full.includes('█'))
console.log('--- settled: has wordmark dsh-TUI?', full.includes('dsh-TUI'))
console.log('--- settled: has version?', full.includes('v0.1.0'))
console.log('--- settled: has model?', full.includes('deepseek-v4-flash'))
console.log('--- settled: has cwd?', full.includes('D:/code/projects/test'))
console.log('--- settled: has tip?', full.includes('/model'))
console.log('--- settled: has welcome?', full.includes('探索未至之境！'))
// The welcome line sits centered under the whale art: 12 leading columns
// (art bbox 3..34 → center 18.5, minus half of the 14-column text).
const welcomeLine = full.split('\n').find(line => line.includes('探索未至之境！'))
console.log(
  '--- settled: welcome centered under whale?',
  welcomeLine !== undefined && /^ {12}探索未至之境！/.test(welcomeLine),
)
console.log('--- settled: no divider?', !full.includes('─'))
console.log('--- settled: model text is uncolored?', !/38;2;/.test(sgrBefore('deepseek-v4-flash')))
console.log('--- settled: tip command text is uncolored?', !/38;2;/.test(sgrBefore('/model')))

await instance2.unmount()
process.exit(0)
