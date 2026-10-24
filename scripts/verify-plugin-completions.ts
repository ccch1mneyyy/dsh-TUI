/**
 * 批 C-3 补全面：`/plugin info <name>` 补全行的描述是插件自己的元数据。
 *
 *   A. 净化：标题里的换行不得越出弹窗行，ANSI 不得留在缓存里（组合后过
 *      cleanScalarText）；
 *   B. 限宽：超宽标题（含东亚宽字符）在缓存里就有界，不靠渲染期兜底；
 *   C. 语言：缓存一次装入所有 shipped 语言，`/lang` 后弹窗与 `/plugin info`
 *      的标题一致 —— 不重启、不重新 warm；
 *   D. 端到端：真实 CommandSuggestions 在 100/50 列下，注入的标题不会多出
 *      一条没有左边框的行（修复前的实际症状）。
 *
 * 体验优化 PR 追加：
 *
 *   E. 参数位语法示例：`/plugin install ` 与 `/plugin info ` 在 `install` 上给出
 *      三种 spec 形状（与 README 逐字相同的三条）。示例行是**提示不是候选**：
 *      Tab 把草稿原样交回（半截 spec 不被吞、占位 spec 不进草稿），Enter 跑的是
 *      子命令本身（打用法行，绝不误装占位 spec）；`remove / enable / disable`
 *      仍然只补已装名，`info` 才是「已装名 + 三条形状」。
 *   F. 长名前的分隔：真实 100/50 列渲染里，比名字列还宽的行（git URL 那条）名字
 *      与描述不得粘成一串（修复前的实际症状 `…ple.gitExample: a git URL`）。
 *
 * 插件服务是替身：不装、不卸、不联网、不读用户状态。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-completions.ts`.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandCompletion, CommandCompletionNode } from '../src/commands.js'

// ── 隔离 HOME（必须先于任何 src 导入：i18n 的偏好目录在导入时定下）─────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-completions-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.FORCE_COLOR = '0'
process.env.DSH_TUI_LANG = 'en'

const [{ createPluginCompletionCatalog }, { setLang }, { completeCommands, localizedDescription, LOCAL_COMMANDS }, { pluginReport }, { stringWidth }, React, { Terminal }, { CommandSuggestions }, { Writable }, ui, { settled, viewportLines, writeParsed }, { createCommandCompletions }] = await Promise.all([
  import('../src/dsh-adapter/plugin-completions.js'),
  import('../src/i18n.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/plugins-info.js'),
  import('../src/ink/stringWidth.js'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/CommandSuggestions.js'),
  import('node:stream'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/dsh-adapter/channel/command-completions.js'),
])

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** 微任务排空：目录的 async 链只有微任务，一个宏任务边界就够。 */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const TITLE_EN = 'English title'
const TITLE_ZH = '中文标题'
const VERSION = '1.0.0'
const bundle = (title: unknown) => ({
  name: 'probe-plugin', version: VERSION, installed: true, optional: false,
  enabled: true, removable: true, rows: [], overrides: [], meta: { title },
})

/** 目录只读它的服务；其余字段给报告用。 */
const services = (item: ReturnType<typeof bundle>) => ({
  listBundles: async () => [item],
  listPlugins: async () => [],
})
const catalogOf = (item: ReturnType<typeof bundle>) => createPluginCompletionCatalog(
  { get: () => services(item) } as never,
  { owner: { current: () => true, signal: new AbortController().signal }, emit() {} },
)
const warmed = async (item: ReturnType<typeof bundle>) => {
  const catalog = catalogOf(item)
  catalog.warmPluginNames()
  await tick()
  return catalog.pluginNames()[0]!
}

// ── A/B. 不可信标题：换行、ANSI、超宽 ───────────────────────────────────────
const injected = await warmed(bundle({ en: 'first\nINJECTED-LINE', zh: `\u001b[31m${'界'.repeat(300)}\u001b[0m` }))
check('a newline in a title cannot leave the popup row',
  !injected.description.includes('\n') && injected.description.includes('first INJECTED-LINE'), JSON.stringify(injected.description))
check('an ANSI title is stripped before it is cached',
  !injected.description.includes('\u001b') &&
  Object.values(injected.descriptions ?? {}).every(text => !text.includes('\u001b')), JSON.stringify(injected.descriptions))

setLang('zh')
const wide = localizedDescription(injected)
check('a wide title is bounded in display cells',
  stringWidth(wide) <= 200 && wide.endsWith('…'), `${stringWidth(wide)} cells: ${JSON.stringify(wide.slice(0, 40))}`)
setLang('en')

// ── C. 语言：一次 warm，两种语言 ────────────────────────────────────────────
const localized = await warmed(bundle({ en: TITLE_EN, zh: TITLE_ZH }))
check('the popup titles a bundle in the language it was warmed in',
  localizedDescription(localized) === `${TITLE_EN} · ${VERSION}`, JSON.stringify(localized.description))
setLang('zh')
check('/lang repaints the same cached row without a reload',
  localizedDescription(localized) === `${TITLE_ZH} · ${VERSION}`, JSON.stringify(localized.description))

const probeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-completions-report-'))
const deps = {
  grants: { knownPermissions: () => [], allows: () => false },
  dataDir: probeHome,
  ledgerFile: join(probeHome, 'ledger.jsonl'),
  storageDir: probeHome,
}
const report = await pluginReport('info probe-plugin', deps as never, services(bundle({ en: TITLE_EN, zh: TITLE_ZH })) as never)
check('the popup and /plugin info agree on the title',
  report.some(line => line.includes(TITLE_ZH)) && localizedDescription(localized).startsWith(TITLE_ZH), report.join('\n'))

// ── D. 端到端：真实弹窗，两种宽度 ───────────────────────────────────────────
/** 含 `marker` 的行必须恰好一条、且带卡片左边框：修复前注入的标题会多出一条
 *  没有左边框的行（100 与 50 列都实测如此）。 */
const borderedOnce = (rows: readonly string[], marker: string): boolean => {
  const hits = rows.filter(line => line.includes(marker))
  return hits.length === 1 && hits[0]!.trimStart().startsWith('│')
}

const popup = (nodes: readonly CommandCompletionNode[]): ReturnType<typeof completeCommands> => completeCommands(
  '/plugin info ',
  [{ name: 'plugin', description: '' }],
  segments => segments.length === 1 ? [{ name: 'info', description: '' }] : nodes,
)
/** 一屏弹窗：`rows()` 读视口，`close()` 收尾。 */
async function renderPopup(commands: readonly CommandCompletion[], columns: number): Promise<{ rows(): string[]; close(): Promise<void> }> {
  const term = new Terminal({ cols: columns, rows: 12, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = 12
    isTTY = true
    _write(chunk: unknown, _encoding: string, callback: () => void): void { term.write(String(chunk), callback) }
  }
  const app = await ui.render(React.createElement(CommandSuggestions, { commands, selectedIndex: 0, columns }), {
    stdout: new Out() as never, exitOnCtrlC: false, patchConsole: false,
  })
  return {
    rows: () => viewportLines(term, 12),
    close: async () => {
      app.unmount()
      await writeParsed(term, '')
      term.dispose()
    },
  }
}

// 语言此刻是 zh，而这一行是在 en 下 warm 的：弹窗按渲染时的语言取标题。
for (const columns of [100, 50]) {
  const zh = await renderPopup(popup([localized]), columns)
  check(`${columns} columns: the popup shows the title of the language active at render`,
    await settled(() => zh.rows().some(line => line.includes(TITLE_ZH))), zh.rows().join('\n'))
  check(`${columns} columns: the localized title stays inside its row`,
    borderedOnce(zh.rows(), TITLE_ZH), zh.rows().join('\n'))
  await zh.close()
}

setLang('en')
for (const columns of [100, 50]) {
  const rows = await renderPopup(popup([injected]), columns)
  check(`${columns} columns: a newline in a title cannot add a borderless row`,
    await settled(() => rows.rows().some(line => line.includes('INJECTED-LINE'))) &&
    borderedOnce(rows.rows(), 'INJECTED-LINE'), rows.rows().join('\n'))
  await rows.close()
}

// ── E. 参数位的三种 spec 形状：是提示，不是候选 ─────────────────────────────
/** 与 README「Plugin Ecosystem」一段逐字相同的三条（顺序也一致）。 */
const SPEC_SHAPES = ['/path/to/repo', 'https://github.com/exam/ple.git', '@scope/package@1.2.3']

/** 真实的 `/plugin` 补全树；插件服务是替身，`installed` 决定已装名那一半。 */
function pluginCompletions(installed: readonly string[]) {
  return createCommandCompletions({
    state: () => ({ commandList: LOCAL_COMMANDS }) as never,
    themeHost: {} as never,
    workspaceCommands: () => [],
    plugin: {
      warmPluginNames: () => undefined,
      pluginNames: () => installed.map(name => ({ name, description: name, descriptions: { en: name, zh: name } })),
    },
    model: {
      warmModelNodes: () => undefined,
      modelNodes: () => [],
      warmPresetOptions: () => undefined,
      presetOptions: () => [],
      warmEffortLevels: () => undefined,
    },
  }) as (input: string) => readonly CommandCompletion[]
}

/** 一个 profile 里没有任何额外 bundle：只有安装自带的，浮窗没有已装名可补。 */
const fresh = pluginCompletions([])
const installRows = fresh('/plugin install ')
check('`/plugin install ` shows the three spec shapes the README lists',
  installRows.length === SPEC_SHAPES.length
  && installRows.every((row, index) => row.name === `plugin install ${SPEC_SHAPES[index]}`),
  JSON.stringify(installRows.map(row => row.name)))
check('every shape survives the argument-token charset as its own query',
  SPEC_SHAPES.every(spec => {
    const rows = fresh(`/plugin install ${spec}`)
    return rows.length === 1 && rows[0]!.name === `plugin install ${spec}`
  }),
  SPEC_SHAPES.map(spec => `${spec} → ${fresh(`/plugin install ${spec}`).length}`).join(' · '))
check('an example row hands Tab back the draft it was given (nothing is inserted)',
  installRows.length === SPEC_SHAPES.length && installRows.every(row => row.replacement === '/plugin install '),
  JSON.stringify(installRows.map(row => row.replacement)))
check('an example row never offers the placeholder as the line Enter runs',
  installRows.length === SPEC_SHAPES.length
  && installRows.every(row => !SPEC_SHAPES.some(spec => row.commandLine.includes(spec))),
  JSON.stringify(installRows.map(row => row.commandLine)))
// 空参数：示例行提交的正是草稿本身，也就是裸子命令（→ 打用法行）。
check('with the argument still empty, Enter runs the bare subcommand (its usage line)',
  installRows.length === SPEC_SHAPES.length
  && installRows.every(row => row.commandLine.trimEnd() === '/plugin install'),
  JSON.stringify(installRows.map(row => row.commandLine)))
// R1：真实的 spec 只要开头与示例重合（`/p` 之于 `/path/to/repo`），这一行就必须提交
// 他打的那一行——换成裸子命令会把参数丢掉、只剩用法行；换成示例文本则是误装占位。
for (const [form, typed] of [['install', '/pa'], ['install', '/path/to/repo'], ['info', '/p']] as const) {
  const rows = fresh(`/plugin ${form} ${typed}`)
  check(`\`/plugin ${form} ${typed}\`: a typed spec is submitted as typed, never replaced`,
    rows.length === 1
    && rows[0]!.commandLine === `/plugin ${form} ${typed}`
    && rows[0]!.replacement === `/plugin ${form} ${typed}`,
    JSON.stringify(rows.map(row => [row.name, row.commandLine, row.replacement])))
}
// 这三条是用户可见承诺：浮窗与双 README 必须写同一份，谁改都要两边改。
const readmeShapes = ['README.md', 'README_ZH.md'].map(file =>
  [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')] as const)
check('both READMEs list the same three shapes the popup shows',
  readmeShapes.every(([, text]) => SPEC_SHAPES.every(spec => text.includes(`/plugin install ${spec}`))),
  readmeShapes.map(([file, text]) =>
    `${file}: ${SPEC_SHAPES.filter(spec => text.includes(`/plugin install ${spec}`)).length}/3`).join(' · '))

const localizedEach = (row: CommandCompletion): readonly string[] => {
  setLang('en')
  const en = localizedDescription(row)
  setLang('zh')
  const zh = localizedDescription(row)
  setLang('en')
  return [en, zh]
}
const shapeLabels = installRows.flatMap(localizedEach)
check('each shape is labelled in both shipped languages',
  shapeLabels.length === SPEC_SHAPES.length * 2
  && shapeLabels.every((label, index) => index % 2 === 0 ? label.startsWith('Example:') : label.startsWith('示例：')),
  JSON.stringify(shapeLabels))

// `info` 也接受待装 spec，所以它给「已装名 + 三条形状」；三个生命周期动作只能
// 作用于已装项，一个示例都不给（点下去只会「找不到该 bundle」）。
const populated = pluginCompletions(['probe-plugin'])
const infoRows = populated('/plugin info ')
check('`info` keeps the installed names first, then the shapes',
  infoRows.length === SPEC_SHAPES.length + 1 && infoRows[0]!.name === 'plugin info probe-plugin'
  && infoRows.slice(1).every(row => row.commandLine === '/plugin info '),
  JSON.stringify(infoRows.map(row => [row.name, row.commandLine])))
check('`info` keeps an installed name a real candidate (Tab inserts it, Enter runs it)',
  infoRows[0]!.replacement === '/plugin info probe-plugin '
  && infoRows[0]!.commandLine === '/plugin info probe-plugin',
  JSON.stringify([infoRows[0]!.replacement, infoRows[0]!.commandLine]))
for (const form of ['remove', 'enable', 'disable']) {
  const rows = populated(`/plugin ${form} `)
  check(`\`${form}\` completes the installed names only (no example rows)`,
    rows.length === 1 && rows[0]!.name === `plugin ${form} probe-plugin`, JSON.stringify(rows.map(row => row.name)))
}
check('a profile with no extra bundle still shows the shapes on `info`',
  fresh('/plugin info ').length === SPEC_SHAPES.length
  && fresh('/plugin info ').every(row => row.commandLine === '/plugin info '),
  JSON.stringify(fresh('/plugin info ').map(row => [row.name, row.commandLine])))

// ── F. 真实三行示例的版式：长名前的分隔 + 没有幽灵行 ────────────────────────
const strayRows = (rows: readonly string[]): readonly string[] =>
  rows.filter(line => line.trim() !== '' && !'│╭╰'.includes(line.trimStart()[0]!))
setLang('en')
for (const columns of [100, 50]) {
  const view = await renderPopup(installRows, columns)
  check(`${columns} columns: three example rows add no borderless row`,
    await settled(() => view.rows().some(line => line.includes('/path/to/repo')))
    && strayRows(view.rows()).length === 0, view.rows().join('\n'))
  await view.close()
}
const widePopup = await renderPopup(installRows, 100)
const gitRow = await settled(() => widePopup.rows().some(line => line.includes('ple.git')))
  ? widePopup.rows().find(line => line.includes('ple.git')) ?? ''
  : ''
check('100 columns: a name wider than the name column keeps a gap before its description',
  /ple\.git\s\S/u.test(gitRow) && gitRow.trimEnd().endsWith('│'), JSON.stringify(gitRow))
await widePopup.close()

// ── G. `/panel` 的候选与侧栏同一个派生：本次运行隐藏的临时面板不出现 ─────────
// `/panel` 是第四个读启用集合的地方（侧栏、数字键、勾选屏之外）。临时面板在
// /settings 里被隐藏后，候选里还留着它，回车只会落到「面板不可用」的兜底提示。
{
  const [{ panelStore }, { registerBuiltinPanels }, prefs] = await Promise.all([
    import('../src/components/sidePanel/PanelStore.js'),
    import('../src/components/sidePanel/builtinPanels.js'),
    import('../src/tuiDisplayPrefs.js'),
  ])
  registerBuiltinPanels()
  const id = 'session:act321:scratch'
  const dispose = panelStore.register(
    { id, title: 'Scratch notes', icon: '◉', source: 'plugin', component: () => null },
    { pluginId: 'session:act321' },
  )
  const completion = pluginCompletions([])
  const offered = (): readonly string[] => completion('/panel ').map(row => row.name.slice('panel '.length))
  check('/panel offers a registered temporary panel while it is visible', offered().includes(id), JSON.stringify(offered()))
  prefs.setTemporarySidePanelHidden(id, true)
  check('/panel drops a temporary panel hidden in /settings', !offered().includes(id), JSON.stringify(offered()))
  prefs.setTemporarySidePanelHidden(id, false)
  check('/panel offers it again once it is restored', offered().includes(id), JSON.stringify(offered()))
  dispose()
}

// ── G. 限定名命令的参数树：按它运行的裸名查，行仍是键入的限定名 ──────────────
{
  const asked: string[][] = []
  const completion = createCommandCompletions({
    state: () => ({
      commandList: [
        ...LOCAL_COMMANDS,
        // Shadowed registry command: listed only as `/<owner>:<name>`.
        { name: 'com.example.echo:review', description: 'review', external: true, owner: 'com.example.echo' },
        // A backend's own colon command: its root stays exact.
        { name: 'ns:cmd', description: 'backend' },
      ],
    }) as never,
    themeHost: {} as never,
    commandTrees: {
      children: (path: readonly string[]) => {
        asked.push([...path])
        return path.length === 1 && (path[0] === 'review' || path[0] === 'ns:cmd') ? [{ name: 'fast', description: 'fast' }] : []
      },
    },
    workspaceCommands: () => [],
    model: {
      warmModelNodes: () => undefined,
      modelNodes: () => [],
      warmPresetOptions: () => undefined,
      presetOptions: () => [],
      warmEffortLevels: () => undefined,
    },
  }) as (input: string) => readonly CommandCompletion[]
  const qualifiedRows = completion('/com.example.echo:review ').map(row => row.name)
  check('a qualified registry command completes its children from the bare-name tree',
    JSON.stringify(qualifiedRows) === JSON.stringify(['com.example.echo:review fast'])
    && asked.some(path => path.join(' ') === 'review'), JSON.stringify({ qualifiedRows, asked }))
  asked.length = 0
  const backendRows = completion('/ns:cmd ').map(row => row.name)
  check('a backend\'s own colon command keeps its exact root',
    JSON.stringify(backendRows) === JSON.stringify(['ns:cmd fast']) && asked.every(path => path[0] === 'ns:cmd'), JSON.stringify({ backendRows, asked }))
}

console.log(`verify-plugin-completions OK (${passed} checks)`)
