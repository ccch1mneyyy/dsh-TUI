/**
 * 底栏缓存命中率的「本次 / 累计」双口径（change dsh-tui-cache-hit-rate-scope，T04）。
 *
 * 守的是口径而不是「有没有缓存字段」：同一组 AC-1 夹具在 request / session /
 * both 三档下必须给出三个不同的读数；both 在**底栏可用宽度** 80 列以下降级；
 * 三桶全零整段消失，而真实的首请求 0 命中必须留下 0.0%。纯函数、归一化、
 * 设置项选项与归一化的互比、两处手写的 Config 清单、真实 StatusLine 渲染、
 * 真实树（PageMargin 收窄后）的边界与 CI 自注册各一层——撤掉任一层对应实现，
 * 都至少有一条断言变红。
 *
 * Run: node --import tsx/esm scripts/verify-cache-scope.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { StatusLine }, { PageMargin }, prefs, { SETTING_DEFINITIONS }, { Config }, { configValues }, i18n, { readFileSync }, termTest, { activateModernEmojiWidths }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/StatusLine.js'),
    import('../src/components/PageMargin.js'),
    import('../src/tuiDisplayPrefs.js'),
    import('../src/settings/definitions.js'),
    import('../src/dsh-adapter/index.js'),
    import('../src/dsh-adapter/compat/settings.js'),
    import('../src/i18n.js'),
    import('node:fs'),
    import('./lib/term-test.mjs'),
    import('./lib/modern-widths.mjs'),
  ])

const { formatCacheHitRateFor, resolveCacheScope, normalizeStatusBar, DEFAULT_STATUS_BAR, CACHE_SCOPE_NARROW_COLUMNS, applyPageMargin } = prefs
const { settled, screenHas, viewportLines } = termTest

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── 1. 纯函数层 ─────────────────────────────────────────────────────────
// AC-1 的真实夹具（会话 b7b38b27）：lastUsage 的三桶合计 643 544，累计
// 合计 248 939 837。两个比率分别是 99.946% 与 85.636%，一位小数即
// 99.9% 与 85.6%——both 的斜杠两侧因此不可能相同，档位接反会立刻露馅。
const REQUEST_USAGE = { input: 344, output: 12, cacheRead: 643_200, cacheWrite: 0 }
const SESSION_TOKENS = { input: 30_562_681, output: 0, cacheRead: 213_180_668, cacheWrite: 5_196_488 }

{
  const both = formatCacheHitRateFor('both', REQUEST_USAGE, SESSION_TOKENS)
  const request = formatCacheHitRateFor('request', REQUEST_USAGE, SESSION_TOKENS)
  const session = formatCacheHitRateFor('session', REQUEST_USAGE, SESSION_TOKENS)
  check('AC-1 both = 本次/累计（本次在前）', both === '99.9%/85.6%', `both=${both}`)
  check('AC-2 request 只给本次率', request === '99.9%', `request=${request}`)
  check('AC-3 session 只给累计率', session === '85.6%', `session=${session}`)
}
{
  // D10：生产者（以及多个旧夹具）只报 { input, output }，缺的两个缓存桶必须
  // 读作未命中（0），否则除数出现 undefined → 'NaN%'。
  const noCacheBuckets = { input: 1_000, output: 0 }
  const rate = formatCacheHitRateFor('session', undefined, noCacheBuckets)
  const both = formatCacheHitRateFor('both', { input: 344, output: 0 }, SESSION_TOKENS)
  check('D10 缺 cacheRead/cacheWrite → 0.0% 而非 NaN', rate === '0.0%', `rate=${rate}`)
  check('D10 both 的缺桶一侧也不产 NaN', both === '0.0%/85.6%' && !String(both).includes('NaN'), `both=${both}`)
  const zeroTokens = { input: 0, output: 0 }
  check('D10 全零且缺桶 → undefined', formatCacheHitRateFor('session', undefined, zeroTokens) === undefined)
}
{
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0 }
  check('三桶全零 → undefined（三档一致）',
    ['request', 'session', 'both'].every(scope => formatCacheHitRateFor(scope as never, zero, zero) === undefined))
  const firstMiss = { input: 4_228, output: 15, cacheRead: 0, cacheWrite: 0 }
  check('AC-9 真 0 命中 → 0.0%（不是 undefined）',
    formatCacheHitRateFor('request', firstMiss, SESSION_TOKENS) === '0.0%')
}
{
  check(`resolveCacheScope：79 列 both → session`, resolveCacheScope('both', 79) === 'session')
  check('resolveCacheScope：80 列 both 不降级', resolveCacheScope('both', 80) === 'both')
  check('resolveCacheScope：request/session 不受列宽影响',
    resolveCacheScope('request', 40) === 'request' && resolveCacheScope('session', 40) === 'session')
  check('窄列阈值就是 80', CACHE_SCOPE_NARROW_COLUMNS === 80, `constant=${CACHE_SCOPE_NARROW_COLUMNS}`)
}

// ── 2. 归一化层 ─────────────────────────────────────────────────────────
{
  check('归一化：未知档位回落 both', normalizeStatusBar({ cacheScope: 'bogus' }).cacheScope === 'both')
  const off = normalizeStatusBar({ cache: false })
  check('AC-11 cache:false 不吞掉 cacheScope 默认值',
    off.cache === false && off.cacheScope === 'both' && off.cacheScope === DEFAULT_STATUS_BAR.cacheScope)
  check('AC-11 布尔循环不覆盖显式档位',
    normalizeStatusBar({ cache: false, cacheScope: 'request' }).cacheScope === 'request')
}

// ── 2b. 取值域互比：definitions.options ↔ normalizeCacheScope ───────────
// 同一取值域在本仓有 4 份副本，唯独 /settings 渲染的这份（options 的元素类型
// 是宽类型 value: string）既没有类型约束也没有门禁：加第 4 档或改档名时，
// tsc 与其它 Config 门禁全绿，而 normalizeCacheScope 会把不认识的值静默改回
// 'both'——用户在 /settings 里选得到，存下去却按默认口径显示。选项逐个从
// SETTING_DEFINITIONS 读；在这里再抄一份三值清单就是第 5 份副本。
{
  const { options } = SETTING_DEFINITIONS['statusBar.cacheScope']
  // 空 options 会让下面的循环一条断言都不发（假绿），显式失败。
  if (options.length === 0) throw new Error('statusBar.cacheScope declares no options to compare')
  for (const { value } of options) {
    const normalized = normalizeStatusBar({ cacheScope: value }).cacheScope
    check(`取值域互比：选项 '${value}' 被 normalizeStatusBar 原样接受`,
      normalized === value, `normalized=${normalized}`)
  }
}

// ── 3. Config 槽位层 ────────────────────────────────────────────────────
// 两份手写 statusBar 清单：index.ts 的 Config（可 import）与 plugin.ts 里
// createSettingsScope 的内联 schema（不导出）。前者查 dict，后者用源码
// 形状钉住——漏任一处，/settings 在该路径上都会静默退回默认值。
{
  const statusBarDict = (Config as unknown as { dict: { statusBar: { dict: Record<string, unknown> } } }).dict.statusBar.dict
  check('AC-10 Config.statusBar 声明 cacheScope 槽位', statusBarDict.cacheScope !== undefined)
  const parsed = configValues(Config({ statusBar: { cacheScope: 'bogus' } } as never)) as unknown as {
    statusBar: { cacheScope: string }
  }
  check('AC-10 Config 把非法档位归一化而不是拒绝文档', parsed.statusBar.cacheScope === 'both', `scope=${parsed.statusBar.cacheScope}`)
}
{
  const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  check('AC-10 legacy settings scope 也声明同一槽位',
    /cacheScope:\s*Schema\.transform\(/u.test(pluginSource))
}

// ── 4. 渲染层（真实 StatusLine + @xterm/headless）──────────────────────
const ROWS = 20

class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const BASE_CHANNEL = {
  minimalUi: false,
  model: 'deepseek-v4-flash',
  provider: 'volcengine',
  agentId: 'abcdef0123456789',
  displayCwd: '~',
  cwd: '~',
  mode: { plan: false, sandbox: 'workspace-write', approval: 'on-request' },
  modeIndex: 0,
  contextWindow: 262_000,
  contextUsed: 30_000,
  contextSegments: {},
  contextBarEnabled: false,
  working: false,
  tpsSamples: [],
  activityFrames: [],
  backgroundJobs: [],
}

async function statusLines(
  cols: number,
  scope: string | undefined,
  tokens: Record<string, number>,
  lastUsage: Record<string, number> | undefined,
  wrapInPageMargin = false,
): Promise<string[]> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 20, allowProposedApi: true })
  activateModernEmojiWidths(term)
  const stdout = new Writable({
    write(chunk, _e, cb) { term.write(String(chunk), cb) },
  }) as unknown as NodeJS.WriteStream & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = cols
  stdout.rows = ROWS
  stdout.isTTY = true
  const channel = {
    ...BASE_CHANNEL,
    tokens,
    lastUsage,
    statusBar: { cache: true, cacheScope: scope },
  }
  const footer = <StatusLine channel={channel as never} />
  // 真实树里底栏从不裸挂在终端上：plugin.ts 恒定把 PageMargin 挂在 Chat 之上，
  // 它把 TerminalSizeContext 收窄成内容区。所以 StatusLine 读到的 columns 是
  // 「底栏可用宽度」，不是终端物理列。包真的 PageMargin、不抄 margin 数学——
  // 边距改预设或改默认值时，这层跟着真实实现一起漂。
  const instance = await render(wrapInPageMargin ? <PageMargin>{footer}</PageMargin> : footer, {
    stdout,
    stdin: new FakeStdin() as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // 页脚上屏即断言：model 字段在每种缓存工况下都在，用它当上屏信号；
  // ctx 不能当信号——空 usage 时整段 ctx 读数本来就不渲染。
  const painted = await settled(() => screenHas(term, 'deepseek-v4-flash'))
  const lines = viewportLines(term, ROWS)
  instance.unmount()
  term.dispose()
  if (!painted) throw new Error(`status line never painted at ${cols} columns`)
  return lines
}

/** 命中的缓存字段本身（标签 + 读数），行内其它字段的 '/'（如 ctx 的
 *  `57k/262k`）不得被当成缓存分隔符。 */
function cacheField(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /(?:缓存|cache) \S+/u.exec(line)
    if (match !== null) return match[0]
  }
  return undefined
}

{
  const both = cacheField(await statusLines(100, 'both', SESSION_TOKENS, REQUEST_USAGE))
  check('AC-1 渲染 both@100 列 = 缓存 99.9%/85.6%', both === '缓存 99.9%/85.6%', `field=${both}`)

  i18n.setLang('en')
  try {
    const english = cacheField(await statusLines(100, 'both', SESSION_TOKENS, REQUEST_USAGE))
    check('AC-1 英文环境 = cache 99.9%/85.6%', english === 'cache 99.9%/85.6%', `field=${english}`)
  } finally {
    i18n.setLang('zh')
  }

  const request = cacheField(await statusLines(100, 'request', SESSION_TOKENS, REQUEST_USAGE))
  check('AC-2 渲染 request 档只有单值', request === '缓存 99.9%', `field=${request}`)

  const session = cacheField(await statusLines(100, 'session', SESSION_TOKENS, REQUEST_USAGE))
  check('AC-3 渲染 session 档 = 85.6%', session === '缓存 85.6%', `field=${session}`)

  const narrow = cacheField(await statusLines(79, 'both', SESSION_TOKENS, REQUEST_USAGE))
  check('AC-4 79 列 both 降级为累计单值', narrow === '缓存 85.6%', `field=${narrow}`)

  const edge = cacheField(await statusLines(80, 'both', SESSION_TOKENS, REQUEST_USAGE))
  check('AC-5 80 列 both 仍带斜杠', edge === '缓存 99.9%/85.6%', `field=${edge}`)

  const empty = cacheField(await statusLines(100, 'both', { input: 0, output: 0 }, undefined))
  check('AC-8 无 usage 且累计全零 → 缓存字段整段不渲染', empty === undefined, `field=${empty}`)

  const firstMiss = { input: 4_228, output: 15, cacheRead: 0, cacheWrite: 0 }
  const zeroHit = cacheField(await statusLines(100, 'request', firstMiss, firstMiss))
  check('AC-9 首请求 0 命中仍渲染 0.0%', zeroHit === '缓存 0.0%', `field=${zeroHit}`)
}

// ── 4b. 真实树边界：PageMargin 收窄后的可用宽度 ────────────────────────
// AC-4/AC-5 的 79/80 是**底栏可用宽度**，不是终端物理列。真实树里 PageMargin
// 先按页边距收窄（默认 normal = 左右各 2 列 ⇒ 终端 83 → 可用 79、终端 84 →
// 可用 80），分栏时侧的 SidePanelLayout 还会再收窄成聊天列宽。上面的裸渲染
// 只钉逻辑边界；这一层钉「逻辑边界 ↔ 真实终端宽度」的映射：撤掉 PageMargin
// 包裹（把终端列直接当 columns 喂给 StatusLine）本层立刻红。
{
  applyPageMargin('normal')
  const narrow = cacheField(await statusLines(83, 'both', SESSION_TOKENS, REQUEST_USAGE, true))
  check('AC-4 真实树：终端 83 列（可用 79）both 只显示累计', narrow === '缓存 85.6%', `field=${narrow}`)

  const edge = cacheField(await statusLines(84, 'both', SESSION_TOKENS, REQUEST_USAGE, true))
  check('AC-5 真实树：终端 84 列（可用 80）both 仍带斜杠', edge === '缓存 99.9%/85.6%', `field=${edge}`)

  // 终端 80 列在默认页边距下只有 76 可用列，所以它**不是**双值——这条把
  // 「80 列仍双值」那种拿终端列当 columns 的写法钉死。
  const typical = cacheField(await statusLines(80, 'both', SESSION_TOKENS, REQUEST_USAGE, true))
  check('AC-4 真实树：终端 80 列（可用 76）不是双值', typical === '缓存 85.6%', `field=${typical}`)
}

// ── 5. 自注册 ───────────────────────────────────────────────────────────
// 脚本写好了但没进 CI 组等于没跑；撤掉登记这一条就红。
{
  const ciGroup = readFileSync(new URL('./run-ci-group.mjs', import.meta.url), 'utf8')
  // 整行匹配（含组内缩进），避免只在注释里提到脚本名也能绿。
  const entry = `    ["verify-cache-scope", ['node', '--import', 'tsx/esm', 'scripts/verify-cache-scope.tsx']],`
  check('CI 自注册：channel-ui 组登记 verify-cache-scope', ciGroup.includes(entry))
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
