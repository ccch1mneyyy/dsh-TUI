/**
 * Verify the tips pool (src/tips.ts) and its two consumers:
 * the startup tip line (LogoV2) and the `/tips` panel (TipsPanel).
 *
 * Run with:
 *   node --import tsx/esm scripts/verify-tips.ts
 *
 * FORCE_COLOR must be set BEFORE any chalk import evaluates — ESM imports are
 * hoisted, so chalk-dependent modules are loaded via dynamic import() below.
 */
process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { render }, tipsModule, i18nModule] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/tips.js'),
  import('../src/i18n.js'),
])

class FakeStdout extends Writable {
  columns = 120
  rows = 32
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

const plainText = (frames: string[]) =>
  frames
    .join('')
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const { TIPS, TIP_GROUP_LABELS, pickRandomTip, tipsByGroup } = tipsModule
const groups = Object.keys(TIP_GROUP_LABELS)

// ── 1. Data invariants ────────────────────────────────────────────────
if (TIPS.length < 20) throw new Error(`tips: expected >= 20 tips, got ${TIPS.length}`)
const ids = new Set<string>()
for (const tip of TIPS) {
  if (ids.has(tip.id)) throw new Error(`tips: duplicate id ${tip.id}`)
  ids.add(tip.id)
  if (!tip.zh || !tip.en) throw new Error(`tips: empty copy for ${tip.id}`)
  if ([...tip.zh].length > 60) throw new Error(`tips: zh too long (${tip.id}): ${tip.zh}`)
  if (tip.en.length > 100) throw new Error(`tips: en too long (${tip.id}): ${tip.en}`)
  if (!groups.includes(tip.group)) throw new Error(`tips: unknown group ${tip.group} on ${tip.id}`)
}
for (const group of groups) {
  if (tipsByGroup(group as never).length < 2) throw new Error(`tips: group ${group} has too few tips`)
}
const first = pickRandomTip(() => 0)
const last = pickRandomTip(() => 0.999_999)
if (first !== TIPS[0]) throw new Error('tips: pickRandomTip(0) should pick the first tip')
if (last !== TIPS[TIPS.length - 1]) throw new Error('tips: pickRandomTip(1) should pick the last tip')
if (pickRandomTip(() => 0.1) === pickRandomTip(() => 0.2)) {
  throw new Error('tips: pickRandomTip did not vary across random draws')
}
console.log(`tips data OK (${TIPS.length} tips, ${groups.length} groups)`)

// ── 2. TipsPanel renders all group headers and tip rows (zh + en) ─────
for (const lang of ['zh', 'en'] as const) {
  i18nModule.setLang(lang)
  const { TipsPanel } = await import('../src/components/TipsPanel.js')
  const stdout = new FakeStdout()
  const instance = await render(<TipsPanel onClose={() => {}} />, {
    stdout,
    stdin: new FakeStdin(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise(resolve => setTimeout(resolve, 150))
  const plain = plainText(stdout.frames)
  const groupLabel = TIP_GROUP_LABELS[groups[0] as never]
  const expectedHeader = lang === 'zh' ? groupLabel.zh : groupLabel.en
  if (!plain.includes(expectedHeader)) throw new Error(`tips panel (${lang}): group header "${expectedHeader}" missing`)
  const sample = TIPS[0]!
  const expectedTip = lang === 'zh' ? sample.zh : sample.en
  if (!plain.includes(expectedTip)) throw new Error(`tips panel (${lang}): tip row "${expectedTip}" missing`)
  const hint = lang === 'zh' ? 'Esc 关闭' : 'Esc to close'
  if (!plain.includes(hint)) throw new Error(`tips panel (${lang}): hint line missing`)
  instance.unmount()
  console.log(`tips panel (${lang}) OK`)
}

// ── 3. LogoV2 settled header shows the daily tip + /tips pointer ──────
for (const lang of ['zh', 'en'] as const) {
  i18nModule.setLang(lang)
  const { LogoV2 } = await import('../src/components/LogoV2.js')
  const stdout = new FakeStdout()
  const instance = await render(
    <LogoV2 model="deepseek-v4-flash" effort="max" cwd="D:\\code" skipIntro={true} tip={pickRandomTip(() => 0)} />,
    {
      stdout,
      stdin: new FakeStdin(),
      stderr: new FakeStderr(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 150))
  const plain = plainText(stdout.frames)
  const tip = pickRandomTip(() => 0)
  const expectedTip = lang === 'zh' ? tip.zh : tip.en
  if (!plain.includes(expectedTip)) throw new Error(`logo (${lang}): random tip "${expectedTip}" missing`)
  if (!plain.includes('/tips')) throw new Error(`logo (${lang}): /tips pointer missing`)
  if (!plain.includes('dsh-TUI')) throw new Error(`logo (${lang}): wordmark missing`)
  instance.unmount()
  console.log(`logo tip line (${lang}) OK`)
}

console.log('verify-tips OK')
