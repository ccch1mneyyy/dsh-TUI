/**
 * Verify the tips pool (src/tips.ts) and its two consumers:
 * the startup tip line (LogoV2) and the `/tips` panel (TipsPanel),
 * plus the merged upstream-drift notice LogoV2 renders under the tip
 * (hidden on a coherent install; one natural-language line per drift kind).
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
  // This repo's tree is coherent (CI gate verify:contract), so the drift
  // notice must stay hidden without an explicit pin.
  if (plain.includes('⚠')) throw new Error(`logo (${lang}): drift notice shown on a coherent install`)
  instance.unmount()
  console.log(`logo tip line (${lang}) OK`)
}

// ── 4. LogoV2 drift notice: one merged line per kind, hidden when null ─
// Expected copy interpolates UPSTREAM_VALIDATED_VERSION so a contract bump
// (e.g. adapting to 0.1.1) needs zero edits here — the notice itself must
// always show the newest validated line, never a pinned literal.
const { UPSTREAM_VALIDATED_VERSION } = await import('../src/dsh-adapter/contract.js')
type UpstreamDriftSummary = import('../src/dsh-adapter/contract.js').UpstreamDriftSummary
const V = UPSTREAM_VALIDATED_VERSION
// Keep the rendering fixture unambiguously newer than every realistic 0.x
// contract line; using yesterday's primary here became semantically stale as
// soon as alpha.1 replaced rc.2.
const FUTURE_VERSION = '99.0.0-alpha.1'
const driftCases: Array<{ summary: UpstreamDriftSummary; zh: string; en: string }> = [
  {
    summary: { kind: 'newer', versions: [FUTURE_VERSION] },
    zh: `比本界面验证过的 ${V} 新`,
    en: `newer than the ${V} this UI is validated against`,
  },
  {
    summary: { kind: 'older', versions: ['0.1.0-rc.5'] },
    zh: `低于本界面验证过的 ${V}`,
    en: `older than the ${V} this UI is validated against`,
  },
  {
    summary: { kind: 'mixed', versions: ['0.1.0-rc.8', '0.1.1-rc.2'] },
    zh: '多版本混装（0.1.0-rc.8 / 0.1.1-rc.2）',
    en: 'Mixed dsh engine versions detected (0.1.0-rc.8 / 0.1.1-rc.2)',
  },
  {
    summary: { kind: 'broken', versions: ['missing'] },
    zh: '版本异常（missing）',
    en: 'Unexpected dsh engine versions (missing)',
  },
]
for (const lang of ['zh', 'en'] as const) {
  i18nModule.setLang(lang)
  const { LogoV2 } = await import('../src/components/LogoV2.js')
  for (const { summary, zh, en } of driftCases) {
    const stdout = new FakeStdout()
    const instance = await render(
      <LogoV2
        model="deepseek-v4-flash"
        effort="max"
        cwd="D:\\code"
        skipIntro={true}
        tip={pickRandomTip(() => 0)}
        drift={summary}
      />,
      { stdout, stdin: new FakeStdin(), stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(resolve => setTimeout(resolve, 150))
    // The notice wraps at the fake terminal's 120 columns and continuation
    // lines re-indent to the whale column, so squash ALL whitespace on both
    // sides before substring assertions — robust to any wrap/indent point.
    const squash = (text: string): string => text.replace(/\s+/g, '')
    const flat = squash(plainText(stdout.frames))
    if (!plainText(stdout.frames).includes('⚠')) throw new Error(`logo drift ${summary.kind} (${lang}): notice missing`)
    const expected = squash(lang === 'zh' ? zh : en)
    if (!flat.includes(expected)) throw new Error(`logo drift ${summary.kind} (${lang}): copy "${expected}" missing`)
    const fix = squash(`npm i -g @deepseek-ai/dsh@${UPSTREAM_VALIDATED_VERSION}`)
    if (!flat.includes(fix)) throw new Error(`logo drift ${summary.kind} (${lang}): fix command missing`)
    instance.unmount()
  }
  // Explicit null suppresses the notice (test seam → hidden line).
  const stdout = new FakeStdout()
  const instance = await render(
    <LogoV2 model="deepseek-v4-flash" cwd="D:\\code" skipIntro={true} tip={pickRandomTip(() => 0)} drift={null} />,
    { stdout, stdin: new FakeStdin(), stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 150))
  if (plainText(stdout.frames).includes('⚠')) throw new Error(`logo drift (${lang}): null must suppress the notice`)
  instance.unmount()
  console.log(`logo drift notice (${lang}) OK`)
}

console.log('verify-tips OK')
