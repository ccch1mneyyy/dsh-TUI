/**
 * Verification of the plugin toast seam (ctx.tuiToast): sanitized,
 * rate-limited, fire-and-forget notifications bridged by the host onto the
 * channel's notification surface.
 *
 * Two layers, one file:
 *  A. Store units (cordis-free): sink-less deliveries drop (false); a
 *     registered sink receives deliveries verbatim.
 *  B. Runtime units over a REAL cordis context: caller validation (warn,
 *     never throw), scalar-only text, control-char stripping + cell cap,
 *     timeout clamping (no plugin sticky toasts), unknown-color refusal,
 *     per-activation rate limiting with a sticky warning, and the
 *     host-only surface staying off the plugin-visible service object.
 *
 * The Chat-side rendering is NOT re-verified here: toasts ride the
 * channel's existing notification surface (NotificationItem), which has
 * its own regression coverage; the plugin.ts bridge is a pure forward.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-toast.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { Context },
  { TuiToastRuntime, TuiToastStore, getHostToastStore },
  { stringWidth },
  { settle },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/toast.js'),
  import('../src/ink/stringWidth.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

// ── A. store units ───────────────────────────────────────────────────────
{
  const store = new TuiToastStore()
  check('toast store: sink-less delivery returns false', store.deliver({ text: 'x', timeoutMs: 4000 }) === false)

  const received: { text: string; color?: string; timeoutMs: number }[] = []
  store.setSink(delivery => {
    received.push({ text: delivery.text, color: delivery.color, timeoutMs: delivery.timeoutMs })
  })
  check('toast store: delivery reaches the sink verbatim',
    store.deliver({ text: 'hello', timeoutMs: 6000 }) === true
    && received.length === 1 && received[0]!.text === 'hello' && received[0]!.timeoutMs === 6000)

  store.setSink(undefined)
  check('toast store: clearing the sink drops again', store.deliver({ text: 'x', timeoutMs: 1 }) === false && received.length === 1)
}

// ── B. runtime units over real cordis ────────────────────────────────────
const ctx = new Context()
const warnings: string[] = []
ctx.logger.warn = (format: unknown, ...params: unknown[]) => {
  warnings.push([format, ...params].map(String).join(' '))
}
const warnCount = (fragment: string): number => warnings.filter(line => line.includes(fragment)).length

ctx.plugin(TuiToastRuntime)
await settle(() => ctx.get('tuiToast') !== undefined)
check('runtime: service mounts on the cordis root', ctx.get('tuiToast') !== undefined)

const store = getHostToastStore(ctx.tuiToast)
if (store === undefined) throw new Error('toast host store was not initialized')
const received: { text: string; color?: string; timeoutMs: number }[] = []
store.setSink(delivery => {
  received.push({ text: delivery.text, color: delivery.color, timeoutMs: delivery.timeoutMs })
})

// Plugin-facing calls must originate from a live child activation (same
// contract as tuiStatus/tuiDialogs: root calls would bind to the host
// lifetime and are rejected).
check('runtime: root-context show is refused', ctx.tuiToast.show('nope') === false)
check('runtime: root refusal warns', warnCount('requires a live non-root plugin activation') >= 1)

let pluginCtx: Context | undefined
const fiber = ctx.plugin({
  name: 'toast-extension-probe',
  inject: ['tuiToast'],
  apply: (candidate: Context) => {
    pluginCtx = candidate
  },
})
await settle(() => pluginCtx !== undefined)
if (pluginCtx === undefined) {
  await Promise.resolve(fiber.dispose())
  throw new Error('toast extension probe did not start')
}

const show = (...args: Parameters<Context['tuiToast']['show']>): boolean => pluginCtx!.tuiToast.show(...args)

// Scalar text + defaults.
check('runtime: string text delivers with defaults',
  show('hello') === true
  && received.at(-1)?.text === 'hello' && received.at(-1)?.timeoutMs === 4000 && received.at(-1)?.color === undefined)
check('runtime: number text is coerced', show(42) === true && received.at(-1)?.text === '42')
check('runtime: boolean text is coerced', show(true) === true && received.at(-1)?.text === 'true')
check('runtime: known color passes through',
  show('careful', { color: 'warning' }) === true && received.at(-1)?.color === 'warning')

// Refusals (warn, never throw).
check('runtime: non-scalar text is refused', show({ toString: () => 'x' } as unknown as string) === false
  && warnCount('rejected non-scalar text') >= 1)
check('runtime: empty text is refused', show('   ') === false && warnCount('rejected empty text') >= 1)
check('runtime: unknown color is refused', show('x', { color: 'bogus' as unknown as 'error' }) === false
  && warnCount('unknown color') >= 1)

// Sanitization: complete ANSI sequences are stripped whole (cleanRenderText
// upgrade), remaining control chars become spaces (never smuggled to the
// screen), whitespace folds, width caps at 200 cells WITH an ellipsis.
check('runtime: control characters are flattened to spaces',
  show('a\x07b\x1b[2kc') === true && received.at(-1)?.text === 'a bc')
const wide = '鲸'.repeat(150)
check('runtime: text is capped at 200 cells with an ellipsis',
  show(wide) === true
  && (text => stringWidth(text) <= 200 && stringWidth(text) >= 198 && text.endsWith('…'))(received.at(-1)?.text ?? ''))

// Timeout clamping — sticky (0/negative) is a host-only device.
check('runtime: sticky timeout falls back to the default',
  show('sticky', { timeoutMs: 0 }) === true && received.at(-1)?.timeoutMs === 4000
  && warnCount('sticky timeoutMs') >= 1)
check('runtime: negative timeout falls back to the default',
  show('neg', { timeoutMs: -5 }) === true && received.at(-1)?.timeoutMs === 4000)
check('runtime: short timeout clamps up to 500ms',
  show('fast', { timeoutMs: 100 }) === true && received.at(-1)?.timeoutMs === 500)
check('runtime: long timeout clamps down to 12000ms',
  show('slow', { timeoutMs: 999999 }) === true && received.at(-1)?.timeoutMs === 12000)
check('runtime: in-range timeout passes through',
  show('mid', { timeoutMs: 6000 }) === true && received.at(-1)?.timeoutMs === 6000)

// Rate limiting: 20/min per activation, sticky one-time warning. The earlier
// assertions consumed this probe's budget, so the burst runs on its own
// fresh activation (windows are per-fiber).
let burstCtx: Context | undefined
const burstFiber = ctx.plugin({
  name: 'toast-burst-probe',
  inject: ['tuiToast'],
  apply: (candidate: Context) => {
    burstCtx = candidate
  },
})
await settle(() => burstCtx !== undefined)
let burstDelivered = 0
for (let index = 0; index < 20; index += 1) {
  if (!burstCtx!.tuiToast.show(`burst ${index}`)) break
  burstDelivered += 1
}
check('runtime: rate limit allows 20 per minute', burstDelivered === 20, `delivered ${burstDelivered}`)
check('runtime: the 21st toast in a minute is dropped', burstCtx!.tuiToast.show('over') === false)
check('runtime: the drop warns exactly once (sticky)',
  warnCount('rate-limited') === 1 && burstCtx!.tuiToast.show('over again') === false && warnCount('rate-limited') === 1)

// A different activation keeps its own budget (per-fiber windows).
let secondCtx: Context | undefined
const fiber2 = ctx.plugin({
  name: 'toast-extension-probe-2',
  inject: ['tuiToast'],
  apply: (candidate: Context) => {
    secondCtx = candidate
  },
})
await settle(() => secondCtx !== undefined)
check('runtime: a fresh activation has its own budget', secondCtx!.tuiToast.show('fresh') === true)

// Host-only surface: the plugin-visible service object exposes no store.
check('host-only: toast store is absent from the plugin service',
  !('store' in (pluginCtx.tuiToast as object)) && !('setSink' in (pluginCtx.tuiToast as object)))

// The public shim re-exports the runtime + types (plugin-facing contract).
const publicSurface = await import('../src/extensions.js')
check('public surface: extensions shim exports TuiToastRuntime',
  (publicSurface as Record<string, unknown>).TuiToastRuntime === TuiToastRuntime)

await Promise.resolve(burstFiber.dispose())
await Promise.resolve(fiber2.dispose())
await Promise.resolve(fiber.dispose())

if (failures > 0) {
  console.error(`verify-plugin-toast: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-plugin-toast: ALL PASS')
process.exit(0)
