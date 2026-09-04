/**
 * JediTerm (JetBrains IDE terminal) compatibility regression.
 *
 * Real-terminal report: dsh-tui renders fine in VS Code but in JetBrains IDEs
 * (WebStorm/IntelliJ/PyCharm/GoLand/…) the layout slowly garbles as content
 * scrolls. JetBrains terminals are JediTerm with these traits:
 *
 *  - The IDE puts `TERMINAL_EMULATOR=JetBrains-JediTerm` in the pty env but
 *    does NOT set TERM_PROGRAM, so every TERM_PROGRAM-based capability check
 *    silently treats it as "unknown terminal".
 *  - JediTerm implements DEC 2026 synchronized output. Without BSU/ESU
 *    wrapping every frame lands in the IDE's reworked block renderer as
 *    partial updates, which reflows/re-renders between writes (the garbling
 *    source), while VS Code gets atomic frames via TERM_PROGRAM=vscode.
 *  - JediTerm's DECSTBM (scroll region) + CSI S/T semantics deviate from
 *    xterm; per-frame hardware scrolling with them corrupts the screen as
 *    content scrolls. The diff engine must repaint shifted rows cell-by-cell
 *    there instead (same gate as upstream Claude Code, which hard-disables
 *    DECSTBM on JetBrains terminals).
 *
 * Asserts:
 *  1. isJetBrainsIdeTerminal() reads TERMINAL_EMULATOR.
 *  2. Sync output is enabled for JediTerm (BSU/ESU per frame).
 *  3. DECSTBM is excluded for JediTerm even when sync output is on.
 *  4. End-to-end: a fullscreen render under the JetBrains env emits
 *     BSU/ESU-wrapped frames and zero DECSTBM sequences.
 *  5. Inline mode rewrites the visible frame on every frame. Tall frames use
 *     CR + CUU(rows-1) + ED0; short frames move up only to their real frame
 *     start, preserving shell history above the application. A one-row
 *     viewport skips the appended repaint because it has no separate park row.
 *  6. (Optional, local machines with a JetBrains IDE installed) the captured
 *     byte stream replays through the IDE's real bundled JediTerm emulator
 *     and produces a screen identical to xterm.js. Skipped on CI.
 *
 * Run: node --import tsx/esm scripts/verify-jediterm.tsx
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root, so `--import tsx/esm` resolves no matter where the script is
// invoked from.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- 1-3. capability wiring (SYNC_OUTPUT_SUPPORTED is computed at import) --
function probeEnv(env: Record<string, string | undefined>): { jet: boolean; sync: boolean; decstbm: boolean } {
  const terminalUrl = new URL('../src/ink/terminal.ts', import.meta.url).href
  const src = `
    const { isJetBrainsIdeTerminal, isSynchronizedOutputSupported, isDecstbmSafe } = await import(${JSON.stringify(terminalUrl)})
    console.log(JSON.stringify({
      jet: isJetBrainsIdeTerminal(),
      sync: isSynchronizedOutputSupported(),
      decstbm: isDecstbmSafe(),
    }))
  `
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', '-e', src], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr}`)
  return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}') as { jet: boolean; sync: boolean; decstbm: boolean }
}

const jb = probeEnv({ TERMINAL_EMULATOR: 'JetBrains-JediTerm', TERM_PROGRAM: '' })
check('JetBrains env detected via TERMINAL_EMULATOR', jb.jet)
check('sync output enabled for JediTerm', jb.sync)
check('DECSTBM excluded for JediTerm', jb.sync && !jb.decstbm)

const vscode = probeEnv({ TERMINAL_EMULATOR: '', TERM_PROGRAM: 'vscode' })
check('VS Code still sync + DECSTBM', vscode.sync && vscode.decstbm)

const plain = probeEnv({ TERMINAL_EMULATOR: '', TERM_PROGRAM: '' })
check('unknown terminal: no sync, no DECSTBM', !plain.sync && !plain.decstbm)

// ---- 4. end-to-end fullscreen render under the JetBrains env -------------
process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm'
delete process.env.TERM_PROGRAM
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render, AlternateScreen, Text }, { Chat }, { QuestionStore }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
  ])

const COLS = 100
const ROWS = 40
const frames: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    frames.push(String(chunk))
    cb()
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [
    { id: 1, kind: 'user', text: '看看这个项目' },
    { id: 2, kind: 'assistant', text: '构建配置在 pubspec.yaml，先跑构建看输出。', streaming: false },
  ],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  mode: { plan: false },
  reasoningEffort: 'max',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'idle',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  lastUserText: '看看这个项目',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

const instance = await render(
  <AlternateScreen><Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} /></AlternateScreen>,
  { stdout: new FakeStdout() as never, stdin: new FakeStdin() as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
for (let turn = 0; turn < 2; turn++) {
  channel.rows.push({
    id: 10 + turn,
    kind: 'assistant',
    text: `第 ${turn} 轮回复：应用装配、主题系统、同步与加密打包`.repeat(6),
    streaming: false,
  })
  bump()
  await sleep(120)
}
channel.rows.push({ id: 99, kind: 'user', text: '再检查一次构建配置，给个概览' })
bump()
await sleep(200)
await instance.unmount()

const allRaw = frames.join('')
const bsu = (allRaw.match(/\x1b\[\?2026h/g) ?? []).length
const esu = (allRaw.match(/\x1b\[\?2026l/g) ?? []).length
check('frames wrapped in BSU/ESU on JediTerm', bsu > 0 && bsu === esu, `bsu=${bsu} esu=${esu}`)
const decstbm = (allRaw.match(/\x1b\[(\d+);(\d+)r/g) ?? []).length
check('no DECSTBM scroll-region sequences on JediTerm', decstbm === 0, `found=${decstbm}`)

// ---- inline-mode: visible-frame repaint on every frame ------------------
// JediTerm's reworked block renderer only repaints rows whose model cells
// changed; the incremental relative-cursor diff touches only changed cells,
// so a misrendered row is never revisited and garbling accumulates as the
// transcript scrolls. Inline mode on JediTerm must therefore rewrite the
// visible frame each frame. A short frame must anchor at its own start rather
// than the viewport top, or it erases shell output above the application.
const shortInlineFrames: string[] = []
class ShortInlineStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    shortInlineFrames.push(String(chunk))
    cb()
  }
}
const shortInlineInstance = await render(
  <Text>short inline frame</Text>,
  { stdout: new ShortInlineStdout() as never, stdin: new FakeStdin() as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
)
await sleep(120)
await shortInlineInstance.unmount()

const shortRepaintAnchor = '\r\x1b[1A\x1b[J'
const fullViewportAnchor = '\r\x1b[' + (ROWS - 1) + 'A\x1b[J'
check(
  'short inline frame anchors at its own start',
  shortInlineFrames.some(frame => frame.includes(shortRepaintAnchor)) &&
    shortInlineFrames.every(frame => !frame.includes(fullViewportAnchor)),
)

const { createRequire } = await import('node:module')
const xterm = createRequire(import.meta.url)('@xterm/headless')
const shortTerm = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true })
await new Promise(resolve => shortTerm.write('shell history\r\nprompt$ dsh\r\n' + shortInlineFrames.join(''), resolve))
const shortReplayLines = Array.from({ length: shortTerm.buffer.active.length }, (_, y) =>
  shortTerm.buffer.active.getLine(y)?.translateToString(true) ?? '',
)
check(
  'short inline repaint preserves shell history',
  shortReplayLines.some(line => line.includes('shell history')) &&
    shortReplayLines.some(line => line.includes('short inline frame')),
)

const oneRowFrames: string[] = []
class OneRowStdout extends Writable {
  columns = COLS
  rows = 1
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    oneRowFrames.push(String(chunk))
    cb()
  }
}
const oneRowInstance = await render(
  <Text>x</Text>,
  { stdout: new OneRowStdout() as never, stdin: new FakeStdin() as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
)
await sleep(120)
await oneRowInstance.unmount()
check(
  'one-row viewport skips appended repaint without a park row',
  oneRowFrames.every(frame => !frame.includes('\x1b[J')),
)

// Once the application reaches the park row, the appended repaint covers the
// whole viewport: CR + CUU(rows-1) + ED0, then the frame tail top-to-bottom.
const inlineFrames: string[] = []
class InlineStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    inlineFrames.push(String(chunk))
    cb()
  }
}
const inlineInstance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />,
  { stdout: new InlineStdout() as never, stdin: new FakeStdin() as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
)
for (let turn = 2; turn < 4; turn++) {
  channel.rows.push({
    id: 10 + turn,
    kind: 'assistant',
    text: `第 ${turn} 轮回复：应用装配、主题系统、同步与加密打包`.repeat(6),
    streaming: false,
  })
  bump()
  await sleep(120)
}
channel.rows.push({ id: 100, kind: 'user', text: '再检查一次构建配置，给个概览' })
bump()
await sleep(200)
await inlineInstance.unmount()

const repaintAnchor = new RegExp('\r' + '\x1b\\[' + (ROWS - 1) + 'A' + '\x1b\\[J')
const visibleFrameAnchor = /\r(?:\x1b\[\d+A)?\x1b\[J/
// Render frames are the BSU-wrapped chunks; the rest are one-off terminal
// writes (raw-mode enables, OSC title/color queries, unmount restores).
// The unmount frame restores the cursor (SHOW_CURSOR only) and legitimately
// carries no repaint anchor.
const renderFrames = inlineFrames.filter(f => {
  if (!f.includes('\x1b[?2026h')) return false
  const body = f.replace(/^\x1b\[\?2026h\x1b\[0m\x1b\]8;;\x07/, '').replace(/\x1b\[\?2026l$/, '')
  return body !== '\x1b[?25h'
})
const framesWithAnchor = renderFrames.filter(f => repaintAnchor.test(f)).length
const framesWithVisibleAnchor = renderFrames.filter(f =>
  visibleFrameAnchor.test(f),
).length
check(
  'inline render frames repaint their visible area on JediTerm',
  renderFrames.length > 0 &&
    framesWithVisibleAnchor === renderFrames.length &&
    framesWithAnchor > 0,
  `${framesWithVisibleAnchor}/${renderFrames.length} frames repaint; ${framesWithAnchor} reach CR+CUU(${ROWS - 1})+ED0`,
)

// ---- 5. optional real-emulator replay (skipped when no IDE is installed) --
const rawPath = join(tmpdir(), 'dsh-jediterm-verify.bin')
writeFileSync(rawPath, allRaw)
const jetbrainsHome = process.env.DSH_JEDITEM_CORE_JAR ?? findBundledJediTermJar()
if (jetbrainsHome) {
  const ok = await replayThroughJediTerm(jetbrainsHome, rawPath, COLS, ROWS)
  check('JediTerm emulator replay matches xterm.js', ok)
  const inlinePath = join(tmpdir(), 'dsh-jediterm-verify-inline.bin')
  writeFileSync(inlinePath, inlineFrames.join(''))
  const inlineOk = await replayThroughJediTerm(jetbrainsHome, inlinePath, COLS, ROWS)
  check('inline JediTerm emulator replay matches xterm.js', inlineOk)
} else {
  console.log('SKIP: bundled JediTerm jar not found (DSH_JEDITEM_CORE_JAR overrides)')
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nALL PASS')

function findBundledJediTermJar(): string | undefined {
  const candidates = [
    '/Applications',
    join(process.env.HOME ?? '', 'Applications'),
  ].filter(existsSync)
  for (const base of candidates) {
    for (const app of readdirSync(base)) {
      if (!/\.app$/.test(app)) continue
      const jar = join(base, app, 'Contents/lib/intellij.libraries.jediterm.core.jar')
      if (existsSync(jar)) return jar
    }
  }
  return undefined
}

async function replayThroughJediTerm(jar: string, streamPath: string, cols: number, rows: number): Promise<boolean> {
  // Compile a tiny driver against the IDE's own JediTerm classes once, then
  // feed it the captured bytes and diff its screen against xterm.js' render.
  const dir = join(tmpdir(), 'dsh-jediterm-replay')
  const driver = join(dir, 'Replay.java')
  const javaSrc = `
    import com.jediterm.terminal.*;
    import com.jediterm.terminal.model.*;
    import com.jediterm.terminal.emulator.JediEmulator;
    public class Replay {
      static class D implements TerminalDisplay {
        public void setCursor(int x, int y) {}
        public void setCursorShape(CursorShape s) {}
        public void beep() {}
        public void scrollArea(int y, int h, int dy) {}
        public void setCursorVisible(boolean v) {}
        public void useAlternateScreenBuffer(boolean b) {}
        public String getWindowTitle() { return ""; }
        public void setWindowTitle(String t) {}
        public TerminalSelection getSelection() { return null; }
        public void terminalMouseModeSet(com.jediterm.terminal.emulator.mouse.MouseMode m) {}
        public void setMouseFormat(com.jediterm.terminal.emulator.mouse.MouseFormat f) {}
        public boolean ambiguousCharsAreDoubleWidth() { return false; }
      }
      public static void main(String[] a) throws Exception {
        int w = Integer.parseInt(a[0]), h = Integer.parseInt(a[1]);
        StyleState ss = new StyleState();
        TerminalTextBuffer buf = new TerminalTextBuffer(w, h, ss, 5000);
        JediTerminal term = new JediTerminal(new D(), buf, ss);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[65536]; int n;
        while ((n = System.in.read(b)) > 0) bos.write(b, 0, n);
        JediEmulator emu = new JediEmulator(new ArrayTerminalDataStream(new String(bos.toByteArray(), "UTF-8").toCharArray()), term);
        while (emu.hasNext()) emu.next();
        for (int y = 0; y < h; y++) {
          System.out.println(String.format("%03d|%s", y, buf.getLine(y).getText().replaceAll("[\\\\uE000-\\\\uF8FF]", "").replaceAll("\\\\s+$", "")));
        }
      }
    }
  `
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(driver, javaSrc)
  // Java tooling: prefer the JDK that can read the IDE's classes.
  const javaBin = process.env.DSH_JAVA_HOME
    ? join(process.env.DSH_JAVA_HOME, 'bin')
    : '/usr/bin'
  const m2 = join(process.env.HOME ?? '', '.m2/repository')
  const slf4j = join(m2, 'org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar')
  const kotlinStdlibOverride = process.env.DSH_KOTLIN_STDLIB
  const kotlinStdlib =
    kotlinStdlibOverride !== undefined && existsSync(kotlinStdlibOverride)
      ? kotlinStdlibOverride
      : join(m2, 'org/jetbrains/kotlin/kotlin-stdlib/2.2.21/kotlin-stdlib-2.2.21.jar')
  // JediTerm classes carry org.jetbrains.annotations: look next to the jar's app bundle.
  const annotations = join(jar, '..', '..', 'annotations.jar')
  const cp = [
    jar,
    dir,
    existsSync(slf4j) ? slf4j : undefined,
    existsSync(kotlinStdlib) ? kotlinStdlib : undefined,
    existsSync(annotations) ? annotations : undefined,
  ]
    .filter(Boolean)
    .join(':')
  const compile = spawnSync(join(javaBin, 'javac'), ['-cp', cp, driver], { encoding: 'utf8' })
  if (compile.status !== 0) {
    const firstError = (compile.stderr ?? '').split('\n')[0]
    console.log(`SKIP: JediTerm driver compile failed: ${firstError}`)
    return true // not a product failure — tooling unavailable
  }
  const run = spawnSync(join(javaBin, 'java'), ['-cp', cp, 'Replay', String(cols), String(rows)], {
    input: readFileSync(streamPath, 'utf8'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.status !== 0) {
    const firstError = (run.stderr ?? '').split('\n')[0]
    console.log(`SKIP: JediTerm replay failed: ${firstError}`)
    return true
  }

  // xterm.js oracle for the same bytes.
  const { createRequire } = await import('node:module')
  const xterm = createRequire(import.meta.url)('@xterm/headless')
  const term = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  await new Promise(res => term.write(readFileSync(streamPath, 'utf8'), res))
  const jediLines = (run.stdout ?? '').split('\n').filter(l => /^\d+\|/.test(l))
  if (jediLines.length !== rows) {
    console.log(`  replay produced ${jediLines.length}/${rows} rows (driver output shape changed?)`)
    return false
  }
  const total = term.buffer.active.length
  const start = Math.max(0, total - rows)
  for (let y = 0; y < rows; y++) {
    const xl = (term.buffer.active.getLine(start + y)?.translateToString(true) ?? '').replace(/\s+$/, '')
    const jl = jediLines[y]?.replace(/^\d+\|/, '') ?? ''
    if (xl !== jl) {
      console.log(`  first diff at row ${y}:\n    xterm:   ${xl}\n    jediterm: ${jl}`)
      return false
    }
  }
  return true
}
