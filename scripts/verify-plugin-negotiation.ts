/**
 * 批 6 电池：/plugins 诊断面 + /doctor 增补（C-070 信任披露 + C-030 协商诊断）。
 *
 *   A. 信任披露 banner 固定首行（overview / check / 未知子命令三路径一致）；
 *   B. Host Descriptor 摘要：generation/契约/dropped 行；row 未挂载降级行；
 *   C. 授权矩阵：临时 HOME 的 grants/denies/台账/存储目录足迹并集成行，
 *      8 权限有效值逐位正确（含 denies 撤销与 allow 默认），host/undeclared
 *      不成行，超出 20 行出 overflow 注记；
 *   D. 台账尾 5：7 条记录只显后 5、损坏行跳过、空台账 empty 行；
 *   E. /plugins check：vendored fixtures 跑五态（compatible /
 *      waiting_authorization / unknown + grants 翻转 compatible）、schema 与
 *      语义失败路径、not-found、坏 JSON、输出零控制字符（不可信输入消毒）；
 *   F. 接线断言：LOCAL_COMMANDS、Chat.tsx 派发、channel 接口与实现、
 *      doctorInfo 新行引用的 i18n 键、cmd-desc-plugins、banner 双语。
 *
 * HOME/USERPROFILE 在导入 src 前隔离。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-negotiation.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 隔离 HOME（必须先于任何 src 导入）─────────────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-negotiation-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'

const { pluginsInfoLines, PLUGINS_MATRIX_MAX_ROWS } = await import('../src/dsh-adapter/plugins-info.js')
const { readGrantStore } = await import('../src/dsh-adapter/grants.js')
const { buildHostDescriptor } = await import('../src/dsh-adapter/host-descriptor.js')
const { DATA_DIR } = await import('../src/utils/paths.js')
const { PLUGIN_STORAGE_DIR } = await import('../src/dsh-adapter/plugin-storage.js')
const { EFFECT_LEDGER_FILE } = await import('../src/dsh-adapter/effect-ledger.js')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name: string) => join(root, 'ecosystem-spec', 'conformance', 'fixtures', name)
const cleanup: string[] = [fakeHome]

let checks = 0
const failures: string[] = []
const check1 = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

// ── 足迹布景：grants + denies + 台账 + 存储目录 ──────────────────────────
mkdirSync(DATA_DIR, { recursive: true })
const scoped = (name: string, scope: string) => ({ name, scope })
const grantsTable: Record<string, object[]> = {
  alpha: [scoped('storage.local.read', 'alpha'), scoped('storage.local.write', 'alpha')],
}
for (let index = 1; index <= 21; index += 1) grantsTable[`p${String(index).padStart(2, '0')}`] = []
writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
  grants: grantsTable,
  denies: { evil: [scoped('commands.invoke', 'diagnostic.command')] },
}))
mkdirSync(join(DATA_DIR, PLUGIN_STORAGE_DIR), { recursive: true })
writeFileSync(join(DATA_DIR, PLUGIN_STORAGE_DIR, 'gamma.json'), '{}')
const ledgerRecords = [
  { sequence: 0, operation: 'create', resource: { kind: 'scene', id: 's1' }, pluginId: 'alpha', result: 'applied' },
  { sequence: 1, operation: 'bind', resource: { kind: 'shortcut', id: 'ctrl+shift+z' }, pluginId: 'beta', result: 'applied' },
  { sequence: 2, operation: 'bind', resource: { kind: 'permission', id: 'commands.invoke' }, pluginId: 'host', result: 'failed', errorCode: 'PERMISSION_NOT_GRANTED' },
  { sequence: 3, operation: 'create', resource: { kind: 'storage-namespace', id: 'alpha' }, pluginId: 'undeclared', result: 'applied' },
  { sequence: 4, operation: 'replace', resource: { kind: 'status', id: 'alpha-line' }, pluginId: 'alpha', result: 'applied' },
  { sequence: 5, operation: 'release', resource: { kind: 'scene', id: 's1' }, pluginId: 'alpha', result: 'applied' },
  { sequence: 6, operation: 'bind', resource: { kind: 'permission', id: 'messages.observe.read' }, pluginId: 'evil', result: 'failed', errorCode: 'PERMISSION_NOT_GRANTED' },
]
writeFileSync(EFFECT_LEDGER_FILE, ledgerRecords.map(r => JSON.stringify(r)).join('\n') + '\n{corrupt line\n')

const grants = readGrantStore()
const host = buildHostDescriptor({ generationId: 'negotiation-battery' })
const overview = () => pluginsInfoLines('', { grants, host })

// ── A. banner 固定首行 ────────────────────────────────────────────────────
{
  const fromOverview = overview()[0]
  const fromCheck = pluginsInfoLines('check ' + fixture('valid-plugin.json'), { grants, host })[0]
  const fromUnknown = pluginsInfoLines('bogus', { grants, host })[0]
  check1('banner is the first line on the overview path', fromOverview.includes('同进程运行') && fromOverview.includes('C-070'))
  check1('banner is the first line on the check path', fromCheck === fromOverview)
  check1('banner is the first line on the unknown-subcommand path', fromUnknown === fromOverview)
}

// ── B. Host Descriptor 摘要 ───────────────────────────────────────────────
{
  const lines = overview()
  const joined = lines.join('\n')
  check1('descriptor summary carries the generation', joined.includes('generation negotiation-battery'))
  check1('descriptor summary lists the advertised contracts',
    joined.includes('commands.dsh/v1alpha1#Command') &&
    joined.includes('storage.dsh/v1alpha1#LocalStorage') &&
    joined.includes('messages.dsh/v1alpha1#MessageObserver'))
  const degraded = pluginsInfoLines('', { grants, host: undefined })
  check1('missing plugin-host row degrades to the explicit line',
    degraded.some(line => line.includes('plugin-host 行未挂载')))
}

// ── C. 授权矩阵 ───────────────────────────────────────────────────────────
{
  const lines = overview()
  const matrixAt = lines.findIndex(line => line.includes('授权矩阵'))
  check1('matrix section present with the footprints-only note', matrixAt !== -1 && lines[matrixAt].includes('仅显示有足迹的插件'))
  const legend = lines[matrixAt + 1] ?? ''
  check1('legend lists all 8 registered permissions',
    ['storage.local.read', 'storage.local.write', 'commands.invoke', 'messages.observe.read',
      'session.input.intercept', 'session.rewind.intercept', 'session.switch.intercept', 'session.compact.intercept']
      .every(permission => legend.includes(permission)), legend)
  const rowOf = (plugin: string) => lines.find(line => line.trimStart().startsWith(plugin + ' '))
  const marks = (plugin: string) => rowOf(plugin)?.trimStart().slice(plugin.length).trim().split(/\s+/)
  check1('alpha row: granted storage ✓✓, invoke ✓ (allow default), rest denied',
    JSON.stringify(marks('alpha')) === JSON.stringify(['✓', '✓', '✓', '·', '·', '·', '·', '·']), JSON.stringify(marks('alpha')))
  check1('beta row (ledger footprint only): invoke ✓, everything else denied',
    JSON.stringify(marks('beta')) === JSON.stringify(['·', '·', '✓', '·', '·', '·', '·', '·']), JSON.stringify(marks('beta')))
  check1('evil row: denies revoke the allow-default invoke → all denied',
    JSON.stringify(marks('evil')) === JSON.stringify(['·', '·', '·', '·', '·', '·', '·', '·']), JSON.stringify(marks('evil')))
  check1('gamma row (storage-dir footprint) present', rowOf('gamma') !== undefined)
  check1("'host' never becomes a matrix row", rowOf('host') === undefined)
  check1("'undeclared' never becomes a matrix row", rowOf('undeclared') === undefined)
  check1('overflow note beyond the row cap',
    lines.some(line => line.includes('另有') && line.includes('未显示')),
    `rows=${PLUGINS_MATRIX_MAX_ROWS}, plugins=${21 + 4}`)
}

// ── D. 台账尾 5 ───────────────────────────────────────────────────────────
{
  const lines = overview()
  const headerAt = lines.findIndex(line => line.includes('效果台账') && line.includes('尾 5 条'))
  check1('ledger tail header present', headerAt !== -1)
  const tail = lines.slice(headerAt + 1).filter(line => line.trimStart().startsWith('#'))
  check1('exactly 5 tail records shown from 7 valid lines', tail.length === 5, `${tail.length}`)
  check1('oldest records are not in the tail', !tail.some(line => line.startsWith('  #0 ') || line.startsWith('  #1 ')))
  check1('corrupt line skipped silently', tail.every(line => !line.includes('corrupt')))
  check1('tail record format carries operation/resource/plugin/result',
    tail.some(line => line.includes('bind permission/messages.observe.read evil failed (PERMISSION_NOT_GRANTED)')))
  const empty = pluginsInfoLines('', { grants, host, ledgerFile: join(fakeHome, 'no-such-ledger.jsonl') })
  check1('missing ledger file renders the empty line', empty.some(line => line.includes('效果台账为空')))
}

// ── E. /plugins check 五态与失败路径 ──────────────────────────────────────
{
  const checkLines = (arg: string) => pluginsInfoLines(`check ${arg}`, { grants, host }).slice(1) // 去 banner
  const compatible = checkLines(fixture('valid-plugin.json'))
  check1('valid fixture negotiates compatible against the real descriptor',
    compatible.some(line => line.includes('协商结果：compatible') && !line.includes('degraded')), compatible.join(' | '))
  const waiting = checkLines(fixture('waiting-authorization-plugin.json'))
  check1('observer fixture waits for authorization with the denied permission named',
    waiting.some(line => line.includes('waiting_authorization') && line.includes('PERMISSION_NOT_GRANTED') && line.includes('messages.observe.read')),
    waiting.join(' | '))
  const unknown = checkLines(fixture('unknown-version-plugin.json'))
  check1('unregistered version answers unknown (never rejected)',
    unknown.some(line => line.includes('unknown') && line.includes('UNKNOWN_PROTOCOL_VERSION') && line.includes('storage.dsh/v2beta1#LocalStorage')),
    unknown.join(' | '))

  // grants 翻转：授予 com.example.observer 后同 fixture 变 compatible
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: { 'com.example.observer': [scoped('messages.observe.read', 'session:*')] },
  }))
  const flipped = pluginsInfoLines('check ' + fixture('waiting-authorization-plugin.json'), { grants: readGrantStore(), host }).slice(1)
  check1('granting the permission flips the same fixture to compatible',
    flipped.some(line => line.includes('协商结果：compatible')), flipped.join(' | '))
  // 还原足迹布景
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: grantsTable,
    denies: { evil: [scoped('commands.invoke', 'diagnostic.command')] },
  }))

  const semantic = checkLines(fixture('invalid-plugin-duplicate-command.json'))
  check1('duplicate command id is rejected by the official manifest parser',
    semantic.some(line => line.includes('schema 校验失败')), semantic.join(' | '))
  const schemaFail = checkLines(fixture('invalid-plugin-client-facet.json'))
  check1('client facet fails the vendored schema',
    schemaFail.some(line => line.includes('schema 校验失败')), schemaFail.join(' | '))
  check1('missing file reports not-found',
    checkLines(join(fakeHome, 'nope.json')).some(line => line.includes('文件不存在')))
  const garbage = join(fakeHome, 'garbage.json')
  writeFileSync(garbage, '{ not json !!!')
  check1('unparseable file reports invalid-json',
    checkLines(garbage).some(line => line.includes('不是可解析的 JSON')))
  check1('bare check prints usage', pluginsInfoLines('check', { grants, host }).some(line => line.includes('用法：/plugins check')))

  // 不可信输入消毒：所有输出行不得含控制字符（manifest/文件材料过 cleanScalarText）
  const all = [
    ...checkLines(fixture('valid-plugin.json')),
    ...checkLines(fixture('invalid-plugin-duplicate-command.json')),
    ...checkLines(garbage),
    ...overview(),
  ]
  // eslint-disable-next-line no-control-regex
  check1('no control characters in any output line', all.every(line => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)))
}

// ── E2. TUI 宿主扩展覆盖层（P2-11）────────────────────────────────────────
{
  const extensionCheck = (path: string, store = grants, targetHost = host) =>
    pluginsInfoLines(`check ${path}`, { grants: store, host: targetHost }).slice(1) // 去 banner
  const privateFixture = fixture('valid-private-protocol-plugin.json')
  const noDecisionHost = {
    descriptor: JSON.parse(readFileSync(fixture('host-no-observe.example.json'), 'utf8')),
    dropped: [],
    warnings: [],
  }
  const unavailable = extensionCheck(privateFixture, grants, noDecisionHost)
  check1('the current-schema private fixture reaches negotiation',
    !unavailable.some(line => line.includes('schema 校验失败') || line.includes('语义校验失败')), unavailable.join(' | '))
  check1('a host without DecisionEvents rejects the required private protocol',
    unavailable.some(line => line.includes('rejected')
      && line.includes('REQUIRED_PROTOCOL_UNAVAILABLE')
      && line.includes('x-ccch1mneyyy.tui/v1alpha1#DecisionEvents')), unavailable.join(' | '))
  // 遵循文档的插件：声明 session.input.intercept 并订阅 tui/input——
  // vendored 核心面答不出（schema 枚举仅 4 个核心权限名、registry 无
  // tui/* 条目），必须走 TUI 扩展覆盖层，且输出要如实声明这一点。
  const tuiPlugin = join(fakeHome, 'tui-extension-plugin.json')
  writeFileSync(tuiPlugin, JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    id: 'com.example.input-guard',
    name: 'Input Guard',
    version: '0.1.0',
    manifestVersion: '0.15',
    facets: { host: { entry: 'dist/main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [{ apiVersion: 'x-ccch1mneyyy.tui/v1alpha1', kind: 'DecisionEvents' }] },
    permissions: [{ name: 'session.input.intercept', scope: 'tui/input', reason: 'guard user input' }],
    contributes: { commands: [] },
    subscriptions: [],
    license: 'MIT',
    source: { repository: 'https://example.com/guard', revision: 'abc123' },
  }))
  const decisionBuild = buildHostDescriptor({ generationId: 'decision-battery' })
  const ungranted = extensionCheck(tuiPlugin, grants, decisionBuild)
  check1('extension manifest reaches negotiation (no schema/semantic failure)',
    !ungranted.some(line => line.includes('schema 校验失败') || line.includes('语义校验失败')), ungranted.join(' | '))
  check1('ungranted intercept permission answers waiting_authorization naming it',
    ungranted.some(line => line.includes('waiting_authorization') && line.includes('session.input.intercept@tui/input')),
    ungranted.join(' | '))
  // 授予后翻 compatible（intercept 权限在覆盖层 descriptor 里是 host-declared）。
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: { ...grantsTable, 'com.example.input-guard': [scoped('session.input.intercept', 'tui/input')] },
    denies: { evil: [scoped('commands.invoke', 'diagnostic.command')] },
  }))
  const grantedLines = extensionCheck(tuiPlugin, readGrantStore(), decisionBuild)
  check1('granting the exact event scope flips DecisionEvents to compatible',
    grantedLines.some(line => line.includes('协商结果：compatible') && !line.includes('degraded')), grantedLines.join(' | '))
  // 还原足迹布景
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: grantsTable,
    denies: { evil: [scoped('commands.invoke', 'diagnostic.command')] },
  }))
  // 双侧都失败的 manifest（未注册权限名）→ 报 base 错误，绝不靠覆盖层放行。
  const bogusPlugin = join(fakeHome, 'bogus-permission-plugin.json')
  writeFileSync(bogusPlugin, JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    id: 'com.example.bogus',
    name: 'Bogus',
    version: '0.1.0',
    manifestVersion: '0.15',
    facets: { host: { entry: 'dist/main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [{ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }] },
    permissions: [{ name: 'bogus.permission', scope: 'x' }],
    contributes: { commands: [] },
    subscriptions: [],
    license: 'MIT',
    source: { repository: 'https://example.com/bogus' },
  }))
  const bogus = extensionCheck(bogusPlugin, grants, decisionBuild)
  check1('an unregistered permission fails profile semantic validation',
    bogus.some(line => line.includes('语义校验失败') && line.includes('bogus.permission')),
    bogus.join(' | '))
  const coreLines = extensionCheck(fixture('valid-plugin.json'))
  check1('public manifests still negotiate through the same catalog',
    coreLines.some(line => line.includes('协商结果：compatible')))
}

// ── F. 接线断言 ───────────────────────────────────────────────────────────
{
  const commands = readFileSync(join(root, 'src/commands.ts'), 'utf8')
  check1("LOCAL_COMMANDS carries 'plugins'", /\{ name: 'plugins', description: /.test(commands))
  const chat = readFileSync(join(root, 'src/screens/Chat.tsx'), 'utf8')
  check1("Chat.tsx dispatches case 'plugins' to channel.pluginsInfo(rawInput)",
    chat.includes("case 'plugins':") && chat.includes('channel.pluginsInfo(rawInput)'))
  const channel = readFileSync(join(root, 'src/dsh-adapter/channel.ts'), 'utf8')
  check1('channel interface declares pluginsInfo(args)', channel.includes('pluginsInfo(args: string): string[]'))
  check1('channel implementation soft-probes tuiPluginHost for pluginsInfo',
    /pluginsInfo\(args: string\) \{[\s\S]{0,300}ctx\.get\('tuiPluginHost'\)/.test(channel))
  check1('doctorInfo adds the generation line', channel.includes("t('doctor-plugin-generation'"))
  check1('doctorInfo adds the registry self-check line', channel.includes("t('doctor-plugin-registry'"))
  const i18n = readFileSync(join(root, 'src/i18n.ts'), 'utf8')
  check1('trust banner exists in both languages',
    i18n.includes("'plugins-trust-banner'") && i18n.includes('同进程运行') && i18n.includes('in-process with the host'))
  check1("cmd-desc-plugins exists", i18n.includes("'cmd-desc-plugins'"))
  check1('doctor plugin keys exist in both languages',
    i18n.includes("'doctor-plugin-generation'") && i18n.includes('Plugin runtime generation') &&
    i18n.includes("'doctor-plugin-registry'") && i18n.includes('Plugin-spec registry self-check'))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-negotiation battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-negotiation battery OK (${checks} checks: trust banner, descriptor summary, grant matrix, ledger tail, /plugins check five-state, wiring)`)
process.exit(0)
