/**
 * verify-format-when-boundary — deterministic boundary tests for
 * nextFormatWhenChange (the AgentView idle-wake scheduler, #713 integration
 * review blocker 6).
 *
 * formatWhen's nested rounding (`seconds = round(ageMs/1000)`,
 * `minutes = round(seconds/60)`, `hours = round(minutes/60)`,
 * `days = round(hours/24)`) makes the true label boundaries anything but
 * the naive half-minute/half-hour marks. nextFormatWhenChange computes the
 * next change with formatWhen itself as the oracle; these tests pin the
 * exact instants and the flip exactness:
 *
 *   T1  now → minutes:  flips at age 44.5s (round(seconds)=45);
 *   T2  mid-minute:     "5m" flips to "6m" at age 5m29.5s (seconds=330);
 *   T3  minutes → hours: "59m" flips to "1h" at age 59m29.5s (minutes=60);
 *   T4  hours → days:   "23h" flips to "1d" at age 23h29.5m (hours=24);
 *   T5  day 7 → absolute date: flips at ~7.47 days (hours=180 → days=8);
 *   T6  absolute-date regime: Infinity (no further wake, ever);
 *   T7  flip exactness: formatWhen differs at the boundary and is identical
 *       one millisecond before, for every case above.
 *
 * Run: node --import tsx/esm scripts/verify-format-when-boundary.ts
 */
process.env.DSH_TUI_LANG = 'zh'

const { formatWhen, nextFormatWhenChange } = await import('../src/sessions/format.js')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const AT = 1_700_000_000_000
const sec = (s: number): number => Math.round(s * 1000)

// T1: "now" flips to minutes when round(age/1000) hits 45 → age 44.5s.
{
  const now = AT + sec(40)
  const next = nextFormatWhenChange(AT, now)
  check('T1: now→minutes boundary at age 44.5s', next === AT + sec(44.5), `next-age=${next - AT}ms`)
}

// T2: mid-minute label "5m" → "6m" when seconds reach 330 → age 329.5s.
{
  const now = AT + sec(320) // label: round(320/60)=5 → "5m"
  const next = nextFormatWhenChange(AT, now)
  check('T2: minute label flips at seconds=330 (age 329.5s)', next === AT + sec(329.5), `next-age=${next - AT}ms`)
}

// T3: minutes → hours: minutes=60 at seconds=3570 → age 3569.5s shows "1h".
{
  const now = AT + sec(3560) // seconds=3560 → minutes=round(59.33)=59 → "59m"
  const next = nextFormatWhenChange(AT, now)
  check('T3: minutes→hours flip at age 59m29.5s', next === AT + sec(3569.5), `next-age=${next - AT}ms`)
}

// T4: hours → days: hours=24 when minutes=1410 → seconds=84570 → age 84569.5s.
{
  const now = AT + sec(84_000) // seconds=84000 → minutes=1400 → hours=round(23.33)=23 → "23h"
  const next = nextFormatWhenChange(AT, now)
  check('T4: hours→days flip at age 23h29m29.5s', next === AT + sec(84_569.5), `next-age=${next - AT}ms`)
}

// T5: day 7 → absolute date: days=8 when hours=180 → minutes=10770 →
// seconds=646170 → age 646169.5s (~7.47 days).
{
  const now = AT + 7.4 * 24 * 60 * 60 * 1000 // ~7.4 days → days=round(7.4*24/24)... label "7d"
  const next = nextFormatWhenChange(AT, now)
  check('T5: day-7 label flips to absolute date at ~7.47 days', next === AT + sec(646_169.5), `next-age=${next - AT}ms`)
}

// T6: absolute-date regime never wakes again.
{
  const now = AT + 10 * 24 * 60 * 60 * 1000
  const next = nextFormatWhenChange(AT, now)
  check('T6: absolute-date label schedules no further wake (Infinity)', next === Infinity, `next=${next}`)
  // And it stays Infinity however far out we ask.
  const far = nextFormatWhenChange(AT, now + 365 * 24 * 60 * 60 * 1000)
  check('T6b: Infinity persists a year later', far === Infinity, `next=${far}`)
}

// T7: flip exactness — the label differs exactly AT the computed boundary
// and is identical one millisecond before (all finite cases above).
{
  const cases: Array<[label: string, ageAtAsk: number]> = [
    ['T1', 40],
    ['T2', 320],
    ['T3', 3560],
    ['T4', 84_000],
    ['T5', 7.4 * 24 * 3600],
  ]
  for (const [label, ageS] of cases) {
    const now = AT + sec(ageS)
    const next = nextFormatWhenChange(AT, now)
    const before = formatWhen(AT, next - 1)
    const at = formatWhen(AT, next)
    check(`T7 ${label}: label differs at the boundary and not 1ms before`,
      before === formatWhen(AT, now) && at !== before,
      `before="${before}" at="${at}"`)
  }
}

console.log(failed === 0 ? 'verify-format-when-boundary: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
