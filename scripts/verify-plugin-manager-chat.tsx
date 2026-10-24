/**
 * `/plugin` in real Chat (Stage C-3): the diagnostics half, the profile's
 * bundles and rows from the host plugin service, gate 1's tag, `info`,
 * `registries`, the removed old name, and what happens when the service is
 * absent or refuses every call.
 *
 * The service is a fake: package removals touch only temporary fixtures.
 * The declared-and-supported branch of the tag goes through the same
 * parse/validate/negotiate path `check <path>` uses, which
 * `verify-plugin-negotiation` already exercises against real fixtures and a
 * live host descriptor.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-manager-chat.tsx
 */
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { PluginInstallFlow } from '../src/dsh-adapter/plugin-install.js'
import type {
  PluginManageFlow,
  PluginManageSink,
  PluginManageStep,
  PluginResidueWatch,
} from '../src/dsh-adapter/plugin-manage.js'
import type { PluginInstallNotice } from '../src/dsh-adapter/plugin-declaration.js'
import type { FirstPartyEntry, FirstPartyFeedLoad } from '../src/dsh-adapter/plugin-feed.js'
import type { PluginInstallSink } from '../src/dsh-adapter/plugin-install.js'
import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallCancellation,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginSpecInspection,
} from '@deepseek-ai/dsh-plugin-manager/types'

const [{ Writable, PassThrough }, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync }, { tmpdir }, { join }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { pluginReport, parsePluginArgs }, { kernelEntriesOf }, { listBackends }, { findText, settle, settled, sleep, viewportLines }, { Context }, { createPluginInstallFlow, createPluginInstallEntry }, { COMPOSITION_PACKAGE }, { pathToFileURL }, { createDshSession }, { PluginInstallPane },
  { createPluginManageFlow, createPluginManageEntry, residueWatchOf },
  { CORE_BUNDLES, HOST_BUNDLE }, { loadFirstPartyFeed }, { PluginManagePane }, { backendDataDir },
  { createTeamCommandEntry }] = await Promise.all([
  import('node:stream'),
  import('node:fs'),
  import('node:os'),
  import('node:path'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/plugins-info.js'),
  import('../src/components/kernelCatalog.js'),
  import('../src/dsh-adapter/backend-registry.js'),
  import('./lib/term-test.mjs'),
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/plugin-install.js'),
  import('../src/dsh-adapter/plugin-declaration.js'),
  import('node:url'),
  import('../src/dsh-adapter/backend/session.js'),
  import('../src/components/PluginInstallPane.js'),
  // Appended, never inserted: this list is matched against the destructuring
  // below by position, so a new import in the middle silently shifts every
  // binding after it.
  import('../src/dsh-adapter/plugin-manage.js'),
  import('../src/dsh-adapter/plugin-guard.js'),
  import('../src/dsh-adapter/plugin-feed.js'),
  import('../src/components/PluginManagePane.js'),
  import('../src/utils/paths.js'),
  import('../src/dsh-adapter/team-mode.js'),
])

setLang('en')
// Tall enough that `/plugin list` at 50 columns keeps both sections (the
// four wrapped experimental entries and the plugins you added) on screen.
const ROWS = 48

const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const AUTO_REVIEW_BUNDLE = '@deepseek-ai/dsh-experimental-auto-review'
const SESSION_SEARCH_BUNDLE = '@deepseek-ai/dsh-experimental-session-search'
const WORKTREE_BUNDLE = '@deepseek-ai/dsh-experimental-tool-worktree'
const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'

const bundles: BundleInfo[] = [
  {
    // The installation's own base layer, in the shape a real profile reports:
    // supplied by the installation (`installed: false`) and named by no shipped
    // template's `OPTIONAL_BUNDLES` (`optional: false`) — so the overview's
    // groups must key on `installed`, or this row lands under "Profile
    // dependencies".
    name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', enabled: true, installed: false,
    optional: false, removable: false, rows: [], overrides: ['hmr'],
  },
  {
    name: '@deepseek-harness-tui/dsh-tui', version: '0.14.0', enabled: true, installed: true,
    optional: false, removable: true, rows: [{ rowId: 'tui-row', moduleName: '@deepseek-harness-tui/dsh-tui' }], overrides: [],
  },
  {
    name: 'verify-plugin-undeclared', version: '3.1.4', enabled: false, installed: true,
    optional: false, removable: true, rows: [], overrides: [],
  },
  {
    name: 'verify-plugin-locked', version: '4.0.0', enabled: true, installed: true, optional: false,
    removable: false, readOnlyReason: 'management-required', error: { code: 'bundle-in-use', diagnostic: 'held by 2 rows' },
    rows: [], overrides: [],
  },
]
/** Installation-supplied optional bundles: only the TUI-adapted ones belong in `list`. */
const experimentalBundles: BundleInfo[] = [
  {
    name: TEAM_BUNDLE, version: '0.2.0-rc.2', enabled: false, installed: false, optional: true, removable: false,
    meta: { title: { en: 'Agent Teams', zh: '智能体团队' } }, rows: [], overrides: [],
  },
  {
    name: AUTO_REVIEW_BUNDLE, version: '0.2.0-rc.2', enabled: true, installed: false, optional: true, removable: false,
    meta: { title: { en: 'Auto review', zh: '自动授权审查' } }, rows: [], overrides: [],
  },
  {
    // Shipped from 0.2.1 on: the version string keeps the fixture honest about
    // the line that first offers it (`legacyManager` below is the older shape).
    name: SESSION_SEARCH_BUNDLE, version: '0.2.1-rc.2', enabled: false, installed: false,
    optional: true, removable: false,
    meta: { title: { en: 'Session search', zh: '会话搜索' } }, rows: [], overrides: [],
  },
  {
    // Shipped from 0.2.1 on, like session search.
    name: WORKTREE_BUNDLE, version: '0.2.1-rc.2', enabled: false, installed: false,
    optional: true, removable: false,
    meta: { title: { en: 'Git Worktrees', zh: 'Git 工作树' } }, rows: [], overrides: [],
  },
  {
    // Shipped by dsh but not adapted by the TUI: the section must leave it out.
    name: SCHEDULE_BUNDLE, version: '0.2.0-rc.2', enabled: false, installed: false, optional: true, removable: false,
    meta: { title: { en: 'Schedule', zh: '自动化任务' } }, rows: [], overrides: [],
  },
]
const plugins: PluginInfo[] = [
  { entryId: 'entry-live' as PluginEntryId, moduleName: '@deepseek-ai/dsh-base', enabled: true, fiberPhase: 'active', patchId: 'row-base' },
  {
    entryId: 'entry-orphan' as PluginEntryId, moduleName: 'orphan-row', enabled: false, fiberPhase: 'pending',
    readOnlyReason: 'unaddressable', meta: { title: { en: 'Orphan row', zh: '孤儿行' } },
  },
]
/** What an npm/pnpm configuration may embed in a registry URL's userinfo: the
 *  report is a transcript, so this must never reach the screen. */
const CREDENTIAL = 'tok3n-s3cret'
const CREDENTIAL_URL = `https://reader:${CREDENTIAL}@registry.npmjs.org/`
/** The same secret in the two shapes the upstream hands back beyond a URL
 *  field: a spec a person typed (the report falls back to it when the upstream
 *  leaves a git URL unnamed) and a URL quoted inside free text. */
const SPEC_CREDENTIAL = 'fake-review-credential'
const SPEC_CREDENTIAL_URL = `https://reader:${SPEC_CREDENTIAL}@git.example.com/org/repo.git`

/** Every spec `inspect` was handed, in order. The prefix-overlap regression
 *  (`/plugin info /p`) reads it: the typed spec must reach the service, so the
 *  argument cannot have been swapped for the bare subcommand on the way. */
const inspectedSpecs: string[] = []

const manager: PluginManagerView = {
  listBundles: () => Promise.resolve(bundles),
  listPlugins: () => Promise.resolve(plugins),
  registries: () => Promise.resolve({
    registry: CREDENTIAL_URL,
    fallbackRegistries: [`https://reader:${CREDENTIAL}@registry.npmmirror.com/`],
    resolved: null,
  }),
  inspect: spec => {
    inspectedSpecs.push(spec)
    return Promise.resolve(spec === 'verify-bad-spec'
      ? { status: 'refused', problem: 'not-found', reason: '404 Not Found' }
      // A git spec the upstream accepts without naming it: the report falls back
      // to the spec itself, which is exactly the line that must not carry it.
      : spec === SPEC_CREDENTIAL_URL
        ? { status: 'accepted', kind: 'git', bundle: true, registry: null }
        : {
            status: 'accepted', kind: 'registry', name: 'verify-fresh-plugin', version: '9.9.9',
            description: 'a fresh plugin', bundle: true, registry: CREDENTIAL_URL,
            host: `https://reader:${CREDENTIAL}@git.example.com/repo.git`,
          })
  },
  // The write half (C-4). The read-only forms never reach these; the install
  // flow below hands in its own service so every write stays assertable.
  installBundle: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'install', target: 'verify-fresh-plugin' }),
  cancelInstall: () => Promise.resolve({ status: 'cancelled' }),
  listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
  setVersionExemption: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'enable', target: 'verify-fresh-plugin' }),
  // The lifecycle half (C-5). The read-only forms never reach these; the manage
  // flow below hands in its own service so every write stays assertable.
  removeBundle: name => Promise.resolve({ changed: true, application: 'restart-required', stage: 'remove', target: name }),
  setBundleEnabled: (name, enabled) => Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: name, enabled }),
  setPluginEnabled: (id, enabled) => Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: id, enabled }),
}

/** The same service with the installation's optional experimental bundles, for the list section. */
const experimentalManager: PluginManagerView = {
  ...manager,
  listBundles: () => Promise.resolve([...bundles, ...experimentalBundles]),
}

/** The same service, refusing every call: the report must survive it. */
const SERVICE_FAILURE = 'the plugin service is gone'
const failingManager: PluginManagerView = {
  listBundles: () => Promise.reject(new Error(SERVICE_FAILURE)),
  listPlugins: () => Promise.reject(new Error(SERVICE_FAILURE)),
  registries: () => Promise.reject(new Error(SERVICE_FAILURE)),
  inspect: () => Promise.reject(new Error(SERVICE_FAILURE)),
  removeBundle: () => Promise.reject(new Error(SERVICE_FAILURE)),
  setBundleEnabled: () => Promise.reject(new Error(SERVICE_FAILURE)),
  setPluginEnabled: () => Promise.reject(new Error(SERVICE_FAILURE)),
}

/** The same service, throwing BEFORE it returns a promise: `.catch` cannot see
 *  that, so every consumer has to contain it on its own. */
const SYNC_FAILURE = 'the plugin service threw before answering'
const syncThrowManager: PluginManagerView = {
  ...manager,
  listBundles: () => { throw new Error(SYNC_FAILURE) },
  // A service can throw before it hands back a promise on a write too: `.catch`
  // cannot see that, and the flow has to contain it on its own (C-5).
  removeBundle: () => { throw new Error(SYNC_FAILURE) },
}

/** Only the installation-supplied bundle: the "nothing added yet" profile. */
const officialOnlyManager: PluginManagerView = {
  ...manager,
  listBundles: () => Promise.resolve(bundles.filter(bundle => !bundle.installed)),
}

/** A 0.2.0-rc.2 installation: it ships the two older TUI bundles, not session
 *  search or worktrees (both first appeared in 0.2.1). The advertised section
 *  is the intersection with what the installation supplies, so this one shows
 *  two. */
const legacyManager: PluginManagerView = {
  ...manager,
  listBundles: () => Promise.resolve([
    ...bundles,
    ...experimentalBundles.filter(bundle => bundle.name !== SESSION_SEARCH_BUNDLE && bundle.name !== WORKTREE_BUNDLE),
  ]),
}

/** The service each form mounts (`absent` mounts none). */
const SERVICES: Record<string, PluginManagerView | undefined> = {
  present: manager,
  experimental: experimentalManager,
  legacy: legacyManager,
  'official-only': officialOnlyManager,
  absent: undefined,
  failing: failingManager,
  'sync-throw': syncThrowManager,
}

/** Drain the microtask queue: the report's async chain holds no timers, so one
 *  macrotask boundary sees it finished. */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** The agent fixture a real channel binds as its startup session. */
function makeAgent(id: string, sessionId: string) {
  return {
    id, status: 'idle',
    session: { id: sessionId, seq: 0, events: [], header: {} },
    ctx: { on: () => () => undefined },
    followup() {}, steer() {}, inbox: { remove: () => true },
  }
}

/** One terminal + Chat rig: stdin → React → throttled render → xterm. Both the
 *  forms loop below and the session-fence case drive this same pipeline. */
function makeHarness(columns: number, fullscreen: boolean) {
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class In extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new In()
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  const hasText = (text: string): boolean => screen().replaceAll(/\s+/gu, '').includes(text.replaceAll(/\s+/gu, ''))
  const type = async (line: string): Promise<void> => {
    for (const char of line) stdin.write(char)
    // 固定窗:pacing the prompt applies typed characters on its own render tick.
    await sleep(60)
  }
  const run = async (line: string): Promise<void> => {
    await type(line)
    stdin.write('\r')
  }
  const clear = async (): Promise<void> => {
    for (let index = 0; index < 40; index += 1) stdin.write('\x7f')
    // 固定窗:pacing backspaces land before the next keystroke batch.
    await sleep(60)
  }
  const above = (first: string, second: string): boolean => {
    const one = findText(term, first)
    const two = findText(term, second)
    return one !== null && two !== null && one.row < two.row
  }
  const render = (node: React.ReactElement): Promise<{ unmount(): void }> => ui.render(
    fullscreen ? <ui.AlternateScreen mouseTracking>{node}</ui.AlternateScreen> : node,
    {
      stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never,
      exitOnCtrlC: false, patchConsole: false,
    },
  )
  return { term, stdin, screen, hasText, type, run, clear, above, render }
}

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

for (const [fullscreen, columns, service] of [
  [false, 100, 'present'],
  [false, 50, 'present'],
  [true, 100, 'present'],
  [false, 100, 'experimental'],
  [false, 50, 'experimental'],
  [false, 100, 'legacy'],
  [false, 100, 'official-only'],
  [false, 100, 'absent'],
  [false, 100, 'failing'],
  [false, 100, 'sync-throw'],
] as const) {
  const tag = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}${service === 'present' ? '' : ` ${service}`}`
  const { term, stdin, screen, hasText, type, run, clear, above, render } = makeHarness(columns, fullscreen)
  const ctx = {
    on: () => () => undefined,
    get: (name: string) => name === 'pluginManager' ? SERVICES[service] : undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as never
  // `/plugin` is a DSH-served command (its requirement defaults to `dsh`), so
  // the fixture is an Agent: createChannel builds the real DSH session around
  // it and attaches the DSH extensions this command lives in.
  const channel = createChannel(ctx, makeAgent('plugin-chat', 's-plugin-chat') as never, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false })
  const instance = await render(React.createElement(Chat, {
    channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
    onExit: () => undefined, fullscreen, trajectorySeen: true,
    kernelEntries: kernelEntriesOf(listBackends()),
    // `agentTeams` is absent in this fixture, so `/team` is hidden from the
    // catalog; the typed form must still reach this entry instead of the model.
    onTeamCommand: createTeamCommandEntry(ctx as never),
  }))

  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)

    if (service === 'official-only') {
      await run('/plugin list')
      check(`${tag}: a profile with nothing added says so`,
        await settled(() => hasText(t('plugins-list-empty'))), screen())
      await clear()
      continue
    }
    if (service === 'legacy') {
      // The 0.2.0-rc.2 shape: session search and worktrees do not exist yet,
      // so the advertised section is the intersection — two entries only.
      await run('/plugin list')
      check(`${tag}: an older installation advertises only the older features`,
        await settled(() => hasText(t('plugins-experimental-header', { count: '2' })) &&
          hasText('Agent Teams 0.2.0-rc.2 · off') &&
          hasText('Auto review 0.2.0-rc.2 · on')), screen())
      check(`${tag}: an older installation shows no session-search or worktree row`,
        !hasText('Session search') && !hasText(SESSION_SEARCH_BUNDLE) &&
        !hasText('Git Worktrees') && !hasText(WORKTREE_BUNDLE), screen())
      await clear()
      continue
    }
    if (service === 'experimental') {
      await run('/plugin list')
      check(`${tag}: list advertises the TUI experimental features`,
        await settled(() => hasText(t('plugins-experimental-header', { count: '4' })) &&
          hasText('Agent Teams 0.2.0-rc.2 · off') &&
          hasText('Auto review 0.2.0-rc.2 · on') &&
          hasText('Session search 0.2.1-rc.2 · off') &&
          hasText('Git Worktrees 0.2.1-rc.2 · off')), screen())
      check(`${tag}: experimental rows give one state-appropriate switch line`,
        hasText(t('plugins-experimental-enable', { bundle: TEAM_BUNDLE })) &&
        hasText(t('plugins-experimental-disable', { bundle: AUTO_REVIEW_BUNDLE })) &&
        hasText(t('plugins-experimental-enable', { bundle: SESSION_SEARCH_BUNDLE })) &&
        hasText(t('plugins-experimental-enable', { bundle: WORKTREE_BUNDLE })), screen())
      check(`${tag}: experimental hints name the TUI entry points`,
        hasText(t('plugins-experimental-team-hint')) && hasText(t('plugins-experimental-auto-review-hint')) &&
        hasText(t('plugins-experimental-session-search-hint')) && hasText(t('plugins-experimental-worktree-hint')), screen())
      check(`${tag}: list drops the old footer and provenance note`,
        !hasText('Details: /plugin info') && !hasText('These packages ship with') &&
        !hasText('Enable/disable:'), screen())
      check(`${tag}: experimental rows keep their indentation`,
        screen().split('\n').some(line => line === '    Agent Teams 0.2.0-rc.2 · off'), screen())
      {
        const rows = screen().split('\n')
        const teamAt = rows.findIndex(line => line === '    Agent Teams 0.2.0-rc.2 · off')
        const autoAt = rows.findIndex(line => line === '    Auto review 0.2.0-rc.2 · on')
        const searchAt = rows.findIndex(line => line === '    Session search 0.2.1-rc.2 · off')
        const worktreeAt = rows.findIndex(line => line === '    Git Worktrees 0.2.1-rc.2 · off')
        check(`${tag}: experimental features have no blank row between them`,
          teamAt >= 0 && autoAt > teamAt && searchAt > autoAt && worktreeAt > searchAt &&
          !rows.slice(teamAt + 1, worktreeAt).some(line => line.trim() === ''), screen())
      }
      check(`${tag}: list still leaves the installation's non-TUI bundles out`,
        !hasText('@deepseek-ai/dsh-base') && !hasText('@deepseek-harness-tui/dsh-tui') &&
        !hasText('Schedule') && !hasText(SCHEDULE_BUNDLE), screen())
      check(`${tag}: the person's own plugins still lead the list`,
        hasText('Plugins you added (2)') && hasText('verify-plugin-undeclared 3.1.4 · off'), screen())
      await clear()
      continue
    }
    if (service === 'sync-throw') {
      // The service throws before it hands back a promise, which `.catch`
      // cannot see: the completion tree must fall back to its static forms
      // instead of taking the keystroke path down with the raw throw.
      await type('/plugin ')
      // Two static rows, not the whole table: the popup viewport holds five of
      // the eight forms at this terminal height, and what this asserts is that
      // the static half survived the throw at all.
      check(`${tag}: a synchronously throwing service leaves the static forms`,
        await settled(() => hasText('plugin list') && hasText('plugin remove')), screen())
      await clear()
    }
    if (service === 'present') {
      // `list` runs first: it is the only form that asserts an ABSENCE (the
      // installation's own bundles), and the transcript keeps every earlier
      // report's lines on screen.
      await run('/plugin list')
      // Settle on the block's tail, then assert the exclusion FIRST: it is the
      // reason `list` exists, and it is the assertion a wrong predicate must
      // break before the header count hides it.
      check(`${tag}: list answers`,
        await settled(() => hasText(t('plugins-list-header', { count: '2' }))), screen())
      check(`${tag}: list leaves the installation's own bundles out`,
        !hasText('@deepseek-ai/dsh-base') && !hasText('@deepseek-harness-tui/dsh-tui'), screen())
      check(`${tag}: list names the plugins the person added`,
        hasText(`verify-plugin-undeclared 3.1.4 · off · ${t('plugins-tag-undeclared')}`) &&
        hasText('verify-plugin-locked 4.0.0 · on · not removable'), screen())
      check(`${tag}: list leads with the trust banner`,
        above('C-070', t('plugins-list-header', { count: '2' })), screen())
      check(`${tag}: list omits the experimental section without optional bundles`,
        !hasText(t('plugins-experimental-header', { count: '2' })) &&
        !hasText(t('plugins-experimental-header', { count: '3' })) &&
        !hasText(t('plugins-experimental-header', { count: '4' })), screen())
      // `agentTeams` is absent and the manager lists no team bundle: a typed
      // `/team` must still be answered here (never sent to the model), and it
      // must not name an enable command this installation cannot serve.
      await run('/team')
      check(`${tag}: a hidden /team says the installation ships no team bundle`,
        await settled(() => hasText(t('team-cmd-bundle-absent', { bundle: TEAM_BUNDLE }))), screen())
      await clear()

      // The completion tree: the static subcommand hints first, then whatever
      // names the service holds. The popup shows the path WITHOUT a leading
      // slash and the composer with one, so the Tab assertion below reads the
      // composer alone.
      await type('/plugin ')
      // C-5 把子命令从 5 条加到 8 条，本用例的 12 行终端只放得下前 5 条：可见的
      // 是「浏览 / 查详情 / 安装 / 卸载 / 关闭」，余下三条落到折叠线以下（列表
      // 自己带 ↓N），由下面的「打字即达」断言补上。
      check(`${tag}: the popup leads with the actions, the lifecycle forms included`,
        await settled(() => hasText('plugin list') && hasText('plugin info') && hasText('plugin install') &&
          hasText('plugin remove') && hasText('plugin disable')), screen())
      if (columns >= 100) {
        check(`${tag}: the popup describes the forms`,
          hasText(t('sugg-plugin-list-desc')) && hasText(t('sugg-plugin-install-desc')) &&
          hasText(t('sugg-plugin-remove-desc')) && hasText(t('sugg-plugin-disable-desc')), screen())
      }
      await type('regi')
      check(`${tag}: a form below the fold is still reachable by typing it`,
        await settled(() => hasText('plugin registries')), screen())
      if (columns >= 100) {
        check(`${tag}: the narrowed popup still describes the form`,
          hasText(t('sugg-plugin-registries-desc')), screen())
      }
      await clear()
      await type('/plugin ')
      await type('info ')
      check(`${tag}: info completes the names the profile added`,
        await settled(() => hasText('plugin info verify-plugin-undeclared')), screen())
      check(`${tag}: the popup leaves the installation's own bundles out`,
        !hasText('@deepseek-ai/dsh-base'), screen())
      stdin.write('\t')
      check(`${tag}: Tab accepts the completed name into the composer`,
        await settled(() => hasText('/plugin info verify-plugin-undeclared')), screen())
      await clear()

      // 体验优化 PR：`/plugin install ` 的参数位、以及 `/plugin info ` 的已装名
      // 之后，是三种 spec 形状——**提示不是候选**。Tab 不得把占位 spec 写进草稿，
      // Enter 跑的是子命令本身（打用法行），所以谁也不会误装示例。
      await type('/plugin install ')
      check(`${tag}: install shows the spec shapes at its argument position`,
        await settled(() => hasText('plugin install /path/to/repo') &&
          (columns < 100 || hasText('plugin install https://github.com/exam/ple.git'))), screen())
      console.log(`\n=== DUMP ${tag} ===\n${screen()}`)
      // Tab 的落点是「草稿逐字没变」，而这个不变量没有可轮询的完成条件（草稿没改
      // ⇒ 没有新帧）：用一次退格把它变成可观察的——真插进了示例的话，弹窗此刻停在
      // 那条示例上；没插进去则退回裸子命令，屏幕上再没有示例行。
      stdin.write('\t')
      stdin.write('\x7f')
      check(`${tag}: Tab inserts nothing — one backspace leaves the bare form, not an example`,
        await settled(() => hasText(t('sugg-count', { n: 1 }))) &&
        !hasText('plugin install /path/to/repo'), screen())
      await clear()
      await type('/plugin install ')
      stdin.write('\r')
      check(`${tag}: Enter on an example prints the usage line instead of installing it`,
        await settled(() => hasText(t('plugins-install-usage'))), screen())
      await clear()
      await type('/plugin info ')
      check(`${tag}: info offers the spec shapes after the installed names`,
        await settled(() => hasText('plugin info /path/to/repo') &&
          hasText('plugin info verify-plugin-undeclared')), screen())
      await clear()

      // R1 回归：参数恰好是示例前缀时（`/p` 之于 `/path/to/repo`），Enter 必须提交
      // 这个人打的那一行——服务真的收到 `/p` 才算数；换成裸子命令就只剩用法行。
      inspectedSpecs.length = 0
      await type('/plugin info /p')
      stdin.write('\r')
      check(`${tag}: a typed spec that starts like an example reaches the service`,
        await settled(() => inspectedSpecs.includes('/p')) && !hasText(t('plugins-info-usage')), screen())
      await clear()

      // Edits and the accepting key share one stdin batch: React has not
      // recomputed the example row yet. Assert the service argument itself,
      // including after Tab, so a visible but subsequently lost suffix fails.
      for (const [label, chunk] of [
        ['kitty Enter', 'roject\x1b[13;1u'],
        ['paste Enter', '\x1b[200~roject\x1b[201~\r'],
        ['Tab', 'roject\t'],
      ] as const) {
        inspectedSpecs.length = 0
        await type('/plugin info /p')
        stdin.write(chunk)
        if (label === 'Tab') {
          check(`${tag}: batched Tab keeps the complete draft`,
            await settled(() => hasText('/plugin info /project')), screen())
          stdin.write('\r')
        }
        check(`${tag}: batched ${label} submits the complete spec`,
          await settled(() => inspectedSpecs.length > 0)
          && inspectedSpecs.length === 1 && inspectedSpecs[0] === '/project', JSON.stringify(inspectedSpecs))
        await clear()
      }
    }

    await run('/plugin')
    if (service === 'failing' || service === 'sync-throw') {
      // The service fails: the diagnostics half is intact and the failure is
      // one line of its own, not a lost report (and not an unhandled rejection
      // — nor, for the synchronous throw, an escaped one).
      const failure = service === 'failing' ? SERVICE_FAILURE : SYNC_FAILURE
      check(`${tag}: a failing service keeps the diagnostics and reports itself`,
        await settled(() => hasText(t('plugins-host-unavailable')) &&
          hasText(t('plugins-service-error', { err: failure }))), screen())
      await clear()
      continue
    }
    // Land on a marker at the END of the report: in a narrow viewport the
    // diagnostics half wraps past what the screen can hold, so the block's own
    // tail is the only anchor that is always on screen.
    check(`${tag}: the overview answers`,
      await settled(() => hasText('Orphan row') || hasText('ctx.pluginManager')), screen())
    if (service === 'absent') {
      check(`${tag}: absent service keeps the diagnostics and explains itself`,
        hasText(t('plugins-matrix-note')) && hasText('ctx.pluginManager'), screen())
      // The write path degrades to the same place (C-4): an install form this
      // composition cannot run through the service answers with the CLI route
      // instead of pretending to install.
      await clear()
      await run('/plugin install verify-fresh-plugin')
      check(`${tag}: an install form without the service points at the CLI`,
        await settled(() => hasText('dsh plugin --profile dsh-tui') && hasText('ctx.pluginManager')), screen())
      await clear()
      // C-5: the line must not promise a verb the CLI does not have. Install and
      // remove do; enable and disable are written into the profile's own files by
      // the service, so the route for those is this application, started on that
      // profile — a `dsh plugin … enable` would be refused before doing anything.
      await run('/plugin enable verify-fresh-plugin')
      check(`${tag}: a lifecycle form without the service answers with the route line`,
        await settled(() => hasText(t('plugins-service-unavailable-route'))), screen())
      check(`${tag}: …and that line never claims a CLI verb the CLI does not have`,
        hasText('no CLI verb') && !hasText('or enable from the CLI') &&
        !hasText(t('plugins-manage-usage', { sub: 'enable' })), screen())
      continue
    }
    if (columns >= 100) {
      check(`${tag}: the trust banner stays the first line`, above('C-070', 'Installed bundles'), screen())
      // The installation's own base layer is `installed: false, optional: false`
      // — keyed on `optional` it would land under "Profile dependencies", below
      // that label instead of above it.
      check(`${tag}: an installation-supplied bundle sits under the official group`,
        above('@deepseek-ai/dsh-base 0.2.0-rc.2', 'Profile dependencies'), screen())
    }
    check(`${tag}: official bundles precede the profile's own`,
      above('Official', 'Profile dependencies'), screen())
    check(`${tag}: an undeclared third-party row carries gate 1's tag`,
      hasText(`verify-plugin-undeclared 3.1.4 · off · ${t('plugins-tag-undeclared')}`), screen())
    check(`${tag}: the composition's own rows carry no tag`,
      hasText('@deepseek-ai/dsh-base 0.2.0-rc.2 · on · not removable · rows 0 / overrides 1') &&
      hasText('@deepseek-harness-tui/dsh-tui 0.14.0 · on · rows 1 / overrides 0'), screen())
    check(`${tag}: locked and problem states render verbatim`,
      hasText(`verify-plugin-locked 4.0.0 · on · not removable · ${t('plugins-bundle-locked', { reason: 'management-required' })} · ${t('plugins-bundle-problem', { code: 'bundle-in-use' })}`), screen())
    check(`${tag}: an unaddressable loader entry is listed separately`,
      hasText(t('plugins-rows-header')) && hasText('Orphan row'), screen())
    check(`${tag}: the tag is explained once, in the legend`,
      hasText('the package ships no package-root dsh-plugin.json'), screen())
    await clear()

    await run('/plugin info verify-plugin-locked')
    check(`${tag}: info describes an installed bundle`,
      await settled(() => hasText(t('plugins-info-bundle', { name: 'verify-plugin-locked' }))), screen())
    check(`${tag}: info repeats the problem with its diagnostic`,
      hasText(`${t('plugins-bundle-problem', { code: 'bundle-in-use' })} — held by`), screen())
    await clear()

    await run('/plugin info verify-fresh-plugin')
    check(`${tag}: info inspects a spec that is not installed`,
      await settled(() => hasText('Installable: verify-fresh-plugin 9.9.9 · registry · bundle=true')), screen())
    check(`${tag}: the inspection keeps its description`, hasText('a fresh plugin'), screen())
    check(`${tag}: the inspection shows its registry and host without credentials`,
      !hasText(CREDENTIAL) && hasText('registry.npmjs.org') && hasText('git.example.com'), screen())
    await clear()

    await run('/plugin info verify-bad-spec')
    check(`${tag}: a refused spec reports its problem and reason`,
      await settled(() => hasText('Not installable: not-found — 404 Not Found')), screen())
    await clear()

    await run('/plugin registries')
    check(`${tag}: registries lists the first and its fallbacks`,
      await settled(() => hasText('registry.npmjs.org') && hasText('registry.npmmirror.com')), screen())
    check(`${tag}: an unreadable pnpm resolution is reported as none`,
      hasText(t('plugins-info-registries-resolved', { registry: t('plugins-info-registries-none') })), screen())
    check(`${tag}: the registries keep their names but never their credentials`,
      !hasText(CREDENTIAL) && hasText('registry.npmjs.org') && hasText('registry.npmmirror.com'), screen())
    await clear()

    // The spec itself: the upstream accepts a git URL without naming it, so the
    // report falls back to what the person typed. That line is a transcript
    // line like any other — it keeps host and path and never the userinfo.
    await run(`/plugin info ${SPEC_CREDENTIAL_URL}`)
    check(`${tag}: info redacts the credentials of the spec it was handed`,
      await settled(() => hasText('Installable: https://git.example.com/org/repo.git')) &&
      !hasText(SPEC_CREDENTIAL), screen())
    await clear()

    // The rename shipped without a deprecation cycle: nothing was released
    // under the old name, so the merged catalog — the list dispatch and the
    // root completion both match `name` against — must no longer carry it.
    // (A screen-level absence check would read the transcript, which still
    // holds the previous report's lines.)
    check(`${tag}: the removed old name is not a command`,
      !channel.commandList.some(command => command.name === 'plugins'), channel.commandList.map(command => command.name).join(','))
    await clear()

    await run('/plugin bogus')
    check(`${tag}: an unknown subcommand names every supported form`,
      await settled(() => hasText('Unknown subcommand: bogus') && hasText('registries')), screen())
    // …including the write path: a form the list forgets is a form nobody
    // discovers (the list is prose, so nothing else can catch it).
    check(`${tag}: the unknown-subcommand list names the install form`,
      await settled(() => hasText('install <spec>')), screen())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}

// ── Every credential-bearing path of the report, without a terminal ─────────
// Four ways a secret reaches `pluginReport`, three of which are TEXT rather
// than a URL field: an accepted spec the upstream left unnamed (the report
// falls back to the raw spec), a refusal reason, a thrown error — plus registry
// fields whose credential is a query parameter and needs no userinfo at all.
// The report is a transcript, so each of them keeps host and path and loses the
// secret. `deps` points at an empty directory: this block reads no user state.
{
  const probeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-redaction-'))
  const deps = {
    grants: { knownPermissions: () => [], allows: () => false },
    dataDir: probeHome,
    ledgerFile: join(probeHome, 'ledger.jsonl'),
    storageDir: probeHome,
  }
  const inspectOf = (inspection: unknown): PluginManagerView => ({ ...manager, inspect: () => Promise.resolve(inspection as never) })
  const spec = SPEC_CREDENTIAL_URL
  const paths: readonly [string, PluginManagerView, string][] = [
    ['an accepted spec the upstream left unnamed', inspectOf({ status: 'accepted', kind: 'git', bundle: true, registry: null }), spec],
    ['a refusal reason quoting it', inspectOf({ status: 'refused', problem: 'network', reason: `Failed to fetch ${spec}` }), 'probe-plugin'],
    ['an exception message quoting it', { ...manager, inspect: () => { throw new Error(`Cannot reach ${spec}`) } }, 'probe-plugin'],
  ]
  for (const [label, service, arg] of paths) {
    const lines = await pluginReport(`info ${arg}`, deps as never, service)
    check(`report: ${label} keeps host and path, never the credential`,
      !lines.some(line => line.includes(SPEC_CREDENTIAL)) &&
      lines.some(line => line.includes('git.example.com/org/repo.git')),
      lines.join('\n'))
  }
  const query = (host: string, key: string): string => `https://${host}/?${key}=${SPEC_CREDENTIAL}`
  const registries = await pluginReport('registries', deps as never, {
    ...manager,
    registries: () => Promise.resolve({
      registry: query('registry.example.com', 'token'),
      fallbackRegistries: [query('npm.example.com', 'access_token')],
      resolved: `https://other.example.com/path?_authToken=${SPEC_CREDENTIAL}`,
    }),
  })
  check('report: a query-only token keeps host and path, never the credential',
    !registries.some(line => line.includes(SPEC_CREDENTIAL)) &&
    ['registry.example.com', 'npm.example.com', 'other.example.com/path']
      .every(host => registries.some(line => line.includes(host))),
    registries.join('\n'))

  const plain = await pluginReport('list', deps as never, {
    ...manager,
    listBundles: () => Promise.resolve(bundles.filter(bundle => !bundle.installed && !bundle.optional)),
  })
  check('report: a host without optional bundles keeps the list output unchanged',
    plain.length === 2 && plain[0] === t('plugins-trust-banner') && plain[1] === t('plugins-list-empty'),
    plain.join('\n'))

  const experimentalOnly = await pluginReport('list', deps as never, {
    ...manager,
    listBundles: () => Promise.resolve([...bundles.filter(bundle => !bundle.installed), ...experimentalBundles]),
  })
  check('report: an empty profile still advertises switchable experimental features',
    experimentalOnly[0] === t('plugins-trust-banner') &&
    experimentalOnly.includes(t('plugins-list-empty')) &&
    experimentalOnly.includes(t('plugins-experimental-header', { count: '4' })),
    experimentalOnly.join('\n'))
}
// ── The install flow, headless (C-4) ─────────────────────────────────────────
// What `/plugin install` asks about, what it refuses to guess, and what it does
// with each shape of result. No terminal: the flow's whole contract is the
// steps it hands back and the lines it writes, and a fake service can produce
// every branch (a real one needs pnpm, a profile and a network).
{
  const tag = 'install flow'
  const PLUGIN = '@probe/verify-fresh-plugin'
  const VERSION = '9.9.9'
  const feedOf = (...entries: FirstPartyEntry[]): FirstPartyFeedLoad =>
    ({ kind: 'ok', path: '/probe/tui-profile/feed/first-party.json', feed: { feedVersion: 1, entries } })
  const TRUSTED = feedOf({ name: PLUGIN, scope: '@probe', version: VERSION })
  /** The same feed, one version behind: "we publish this, but not this artifact". */
  const STALE = feedOf({ name: PLUGIN, scope: '@probe', version: '0.0.1' })
  /** A feed nobody could read (missing file, corrupt bytes): vouches for nothing. */
  const NO_FEED: FirstPartyFeedLoad = { kind: 'unavailable', reason: 'feed file is missing (probe)' }
  const ACCEPTED = { status: 'accepted', kind: 'registry', name: PLUGIN, version: VERSION, bundle: true, registry: null } as const
  const CHANGE = { changed: true, application: 'restart-required', stage: 'install', target: PLUGIN } as const

  interface Rig {
    readonly flow: PluginInstallFlow
    readonly lines: string[]
    readonly installs: InstallBundleOptions[]
    /** The spec each `installBundle` call was handed, in order. */
    readonly installSpecs: string[]
    /** How many times the inspection ran: a refused install makes none. */
    readonly inspections: number
    readonly cancels: PluginInstallRequestId[]
    /** `[package@version, runtime version, enabled, accept risk]` per exemption granted. */
    readonly exemptions: string[][]
    setInstall(next: () => Promise<ChangeResult>): void
    emitState(progress: PluginInstallProgress): void
    emitLog(chunk: PluginInstallLogChunk): void
  }

  function makeInstallRig(options: {
    readonly feed: FirstPartyFeedLoad
    readonly inspect?: PluginSpecInspection | (() => Promise<PluginSpecInspection>)
    readonly notice?: (target: { readonly name?: string; readonly directory?: string }) => PluginInstallNotice
    readonly binding?: () => number
    /** What the person typed; the pinned form of this feed's entry by default. */
    readonly spec?: string
    /** Whether a turn is running; idle unless a case says otherwise. */
    readonly busy?: () => boolean
    readonly ownVersion?: string
    readonly bundles?: BundleInfo[]
    readonly install?: () => Promise<ChangeResult>
    /** Defers the service's answer to `cancelInstall`: the rollback's own clock. */
    readonly cancel?: () => Promise<PluginInstallCancellation>
    /** Overrides the exemptions reader (including one that throws synchronously). */
    readonly readExemptions?: () => { exemptions: Record<string, string[]>; warnings: string[] }
    readonly exempt?: (packageVersion: string, runtimeVersion: string) => Promise<ChangeResult>
  }): Rig {
    const lines: string[] = []
    const installs: InstallBundleOptions[] = []
    const installSpecs: string[] = []
    let inspections = 0
    const cancels: PluginInstallRequestId[] = []
    const exemptions: string[][] = []
    let install = options.install ?? (() => Promise.resolve(CHANGE))
    const state: Array<(progress: PluginInstallProgress) => void> = []
    const log: Array<(chunk: PluginInstallLogChunk) => void> = []
    const service: PluginManagerView = {
      ...manager,
      inspect: () => {
        inspections += 1
        return typeof options.inspect === 'function' ? options.inspect() : Promise.resolve(options.inspect ?? ACCEPTED)
      },
      installBundle: (spec, settings) => { installSpecs.push(spec); installs.push(settings ?? {}); return install() },
      cancelInstall: requestId => {
        cancels.push(requestId)
        return options.cancel?.() ?? Promise.resolve({ status: 'cancelled' } as const)
      },
      listVersionExemptions: options.readExemptions ?? (() => ({ exemptions: {}, warnings: [] })),
      setVersionExemption: (packageVersion, runtimeVersion, enabled, acceptRisk) => {
        exemptions.push([packageVersion, runtimeVersion, String(enabled), String(acceptRisk)])
        return options.exempt?.(packageVersion, runtimeVersion) ?? Promise.resolve(CHANGE)
      },
      listBundles: () => Promise.resolve(options.bundles ?? []),
    }
    const flow = createPluginInstallFlow({
      manager: service,
      // A precise `name@version` by default: only a spec that names the version
      // can be the artifact the feed pinned (see the bare-name case below).
      spec: options.spec ?? `${PLUGIN}@${VERSION}`,
      feed: options.feed,
      noticeOf: options.notice ?? (() => ({ kind: 'declared' })),
      binding: options.binding ?? (() => 0),
      busy: options.busy ?? (() => false),
      onLines: batch => { lines.push(...batch) },
      events: {
        onState: (_requestId, listener) => { state.push(listener); return () => undefined },
        onLog: (_requestId, listener) => { log.push(listener); return () => undefined },
      },
      ownVersion: options.ownVersion,
      requestId: 'probe-request' as PluginInstallRequestId,
    })
    return {
      flow, lines, installs, installSpecs, cancels, exemptions,
      get inspections(): number { return inspections },
      setInstall: next => { install = next },
      emitState: progress => { for (const listener of state) listener(progress) },
      emitLog: chunk => { for (const listener of log) listener(chunk) },
    }
  }

  // The trust route: a feed hit with a readable declaration is the one case that
  // installs without asking, and it still leaves an audit line.
  {
    const rig = makeInstallRig({ feed: TRUSTED })
    const step = await rig.flow.begin()
    check(`${tag}: a first-party package with a declaration installs without asking`,
      step.kind === 'done' && rig.installs.length === 1, `${step.kind} · ${rig.installs.length}`)
    check(`${tag}: skipping the confirmation still leaves an audit line`,
      rig.lines.some(line => line.includes('First-party (feed hit)') && line.includes(`${PLUGIN}@${VERSION}`)),
      rig.lines.join(' | '))
    check(`${tag}: the install carries the request id the flow owns`,
      rig.installs[0]?.requestId === rig.flow.requestId, JSON.stringify(rig.installs[0]))
    check(`${tag}: the service is asked for the exact version that was inspected`,
      rig.installSpecs[0] === `${PLUGIN}@${VERSION}`, JSON.stringify(rig.installSpecs))
  }

  // What the person confirmed is what the service is asked to install. A bare
  // name, a range or a tag is resolved again by the install (and again by a
  // retry), so it is not the pinned artifact — and the install is pinned to the
  // version the inspection read, whatever the spec spelled.
  for (const [label, spec] of [
    ['a bare name', PLUGIN],
    ['a range', `${PLUGIN}@^1`],
    ['a tag', `${PLUGIN}@latest`],
  ] as const) {
    const rig = makeInstallRig({ feed: TRUSTED, spec, notice: () => ({ kind: 'declared' }) })
    const step = await rig.flow.begin()
    check(`${tag}: ${label} is not treated as the artifact the feed pinned`,
      step.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'version-mismatch',
      JSON.stringify(step))
    const after = await rig.flow.confirm()
    check(`${tag}: ${label} installs the exact version the inspection read`,
      after.kind === 'done' && JSON.stringify(rig.installSpecs) === JSON.stringify([`${PLUGIN}@${VERSION}`]),
      JSON.stringify(rig.installSpecs))
  }

  // A turn is running: the install refuses before it asks anything. The check is
  // repeated before the write, because a turn can start while the pane waits.
  {
    const rig = makeInstallRig({ feed: TRUSTED, busy: () => true })
    const step = await rig.flow.begin()
    check(`${tag}: a running turn refuses the install before any service call`,
      step.kind === 'done' && rig.inspections === 0 && rig.installSpecs.length === 0,
      `${step.kind} · inspections ${rig.inspections} · installs ${rig.installSpecs.length}`)
    check(`${tag}: the refusal says what to do about it`,
      rig.lines.includes(t('plugins-install-busy')), rig.lines.join(' | '))
  }
  {
    let busy = false
    const rig = makeInstallRig({ feed: TRUSTED, spec: PLUGIN, busy: () => busy })
    const step = await rig.flow.begin()
    check(`${tag}: an idle turn still asks first`, step.kind === 'confirm', JSON.stringify(step))
    busy = true
    const after = await rig.flow.confirm()
    check(`${tag}: a turn that started while the pane was open stops the write`,
      after.kind === 'done' && rig.installSpecs.length === 0 && rig.lines.includes(t('plugins-install-busy')),
      `${after.kind} · ${rig.installSpecs.length} · ${rig.lines.join(' | ')}`)
  }

  // Fail closed: an unlisted name, a listed name at another version, and a feed
  // nobody could read all ask first — and none of them installs before the answer.
  for (const [label, feed, reason] of [
    ['a name the feed does not list', feedOf(), 'not-listed'],
    ['a listed name at another version', STALE, 'version-mismatch'],
    ['a feed that cannot be read', NO_FEED, 'no-feed'],
  ] as const) {
    const rig = makeInstallRig({ feed, notice: () => ({ kind: 'unjudged' }) })
    const step = await rig.flow.begin()
    check(`${tag}: ${label} is asked about before anything installs`,
      step.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === reason && rig.installs.length === 0,
      `${step.kind} · ${step.kind === 'confirm' ? step.trust.kind : ''} · installs ${rig.installs.length}`)
    check(`${tag}: ${label} keeps the notice the wiring read (gate 1)`,
      step.kind === 'confirm' && step.notice.kind === 'unjudged', JSON.stringify(step))
    const after = await rig.flow.confirm()
    check(`${tag}: ${label} installs once the person confirms`,
      after.kind === 'done' && rig.installs.length === 1, `${after.kind} · ${rig.installs.length}`)
  }

  // A first-party package whose declaration is missing still asks: gate 1 has
  // something to say even when the feed vouches for the artifact.
  {
    const rig = makeInstallRig({ feed: TRUSTED, notice: () => ({ kind: 'undeclared' }) })
    const step = await rig.flow.begin()
    check(`${tag}: a first-party package with no declaration still gets gate 1's notice`,
      step.kind === 'confirm' && step.trust.kind === 'first-party' && step.notice.kind === 'undeclared' && rig.installs.length === 0,
      JSON.stringify(step))
  }

  // A spec the service refuses never reaches an install.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      inspect: { status: 'refused', problem: 'not-found', reason: '404 Not Found' },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a refused spec reports itself and installs nothing`,
      step.kind === 'done' && rig.installs.length === 0 &&
      rig.lines.some(line => line.includes('Not installable: not-found — 404 Not Found')), rig.lines.join(' | '))
  }

  // Build scripts: the service blocks the install, the approval retries with them.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({ ...CHANGE, application: 'failed', pendingBuilds: ['esbuild', 'sharp'] }),
    })
    const step = await rig.flow.begin()
    check(`${tag}: blocked build scripts come back as a decision`,
      step.kind === 'build-blocked' && step.builds.join(',') === 'esbuild,sharp', JSON.stringify(step))
    rig.setInstall(() => Promise.resolve(CHANGE))
    const after = await rig.flow.approve(['esbuild', 'sharp'])
    check(`${tag}: approving the scripts writes them into the retry`,
      after.kind === 'done' && rig.installs.length === 2 &&
      JSON.stringify(rig.installs[1]?.approvedBuilds) === '["esbuild","sharp"]',
      JSON.stringify(rig.installs))
    check(`${tag}: the approval is reported before the retry`,
      rig.lines.some(line => line.includes('Approved 2 build scripts')), rig.lines.join(' | '))
  }

  // An incompatible version: the service's own list, and the exemption escape.
  for (const field of ['peers', 'requirements'] as const) {
    const peer = { name: 'verify-other', version: '1.0.0', runtimeVersion: '0.2.0-rc.2', [field]: { 'engines.dsh': '^9' } }
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: [peer] },
      }),
    })
    const step = await rig.flow.begin()
    check(`${tag}: an incompatible version comes back with the packages and the exemptions`,
      step.kind === 'incompatible' && step.packages.length === 1 && step.exemptions.exemptions !== undefined,
      JSON.stringify(step))
    check(`${tag}: ${field} retains the host's exact version requirement for the pane`,
      step.kind === 'incompatible' && step.packages[0]?.peers['engines.dsh'] === '^9', JSON.stringify(step))
    rig.setInstall(() => Promise.resolve(CHANGE))
    const after = await rig.flow.acceptRisk()
    check(`${tag}: accepting the risk registers the exact exemption and retries`,
      after.kind === 'done' && rig.exemptions.length === 1 &&
      rig.exemptions[0]?.join('|') === 'verify-other@1.0.0|0.2.0-rc.2|true|true' && rig.installs.length === 2,
      `${JSON.stringify(rig.exemptions)} · installs ${rig.installs.length}`)
  }

  // A pending input can start a turn while the incompatible pane waits. The
  // exemption itself writes and reloads the profile, before the install retry.
  for (const becomesBusy of ['before approval', 'during the first write'] as const) {
    let busy = false
    const peers = ['probe-peer-a', 'probe-peer-b'].map(name => ({
      name, version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {},
    }))
    const rig = makeInstallRig({
      feed: TRUSTED,
      busy: () => busy,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: peers },
      }),
      exempt: () => {
        busy = true
        return Promise.resolve(CHANGE)
      },
    })
    const blocked = await rig.flow.begin()
    check(`${tag}: ${becomesBusy} starts from the incompatible decision`, blocked.kind === 'incompatible')
    if (becomesBusy === 'before approval') busy = true
    const after = await rig.flow.acceptRisk()
    check(`${tag}: ${becomesBusy} stops all subsequent profile writes`,
      after.kind === 'done' && rig.exemptions.length === (becomesBusy === 'before approval' ? 0 : 1)
      && rig.installs.length === 1 && rig.lines.includes(t('plugins-install-busy')),
      `${JSON.stringify(rig.exemptions)} · installs ${rig.installs.length}`)
    rig.flow.dispose()
  }

  // The service answers a refusal in-band (a stale runtime version, a
  // compatibility file it will not rewrite): reporting that as "recorded" and
  // retrying would loop forever.
  {
    const peer = { name: 'verify-other', version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {} }
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: [peer] },
      }),
      exempt: () => Promise.resolve({
        ...CHANGE, application: 'failed', stage: 'enable', error: { code: 'stale-approval', diagnostic: 'cannot approve a runtime this app is not running' },
      }),
    })
    const blocked = await rig.flow.begin()
    const step = await rig.flow.acceptRisk()
    check(`${tag}: a refused exemption is reported, not retried as if it had been granted`,
      blocked.kind === 'incompatible' && step.kind === 'done' && rig.installs.length === 1 &&
      rig.lines.some(line => line.includes('stale-approval')) &&
      !rig.lines.some(line => line.includes('Recorded an exact-version exemption')),
      `${blocked.kind} · ${rig.lines.join(' | ')}`)
  }

  // The exemptions reader is the one service call that answers synchronously:
  // it can throw past a promise's catch, and the flow contains it either way.
  {
    const peer = { name: 'verify-other', version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {} }
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: [peer] },
      }),
      readExemptions: () => { throw new Error(SYNC_FAILURE) },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a service that throws while reading the exemptions is contained in one line`,
      step.kind === 'incompatible' && step.exemptions.exemptions !== undefined &&
      rig.lines.some(line => line.includes(SYNC_FAILURE)), rig.lines.join(' | '))
  }

  // A directory spec whose own manifest claims a feed entry: the feed lists what
  // was published, and a directory vouching for itself is not that.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      inspect: { status: 'accepted', kind: 'path', name: PLUGIN, version: VERSION, bundle: true, registry: null },
      notice: () => ({ kind: 'declared' }),
    })
    const step = await rig.flow.begin()
    check(`${tag}: a path spec cannot claim a feed entry to skip the confirmation`,
      step.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'unverifiable-source' &&
      rig.installs.length === 0, JSON.stringify(step))
  }

  // A failure keeps the evidence, loses the credentials, and says how to retry.
  {
    const output = 'first line\nlast line\nfrom https://reader:probe-secret@registry.example.com/x'
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        // The real service emits the stream and repeats its capture in the
        // result; evidence must come from the former, before byte truncation.
        rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe',
          stream: 'stderr', text: output,
        })
        return Promise.resolve({
          ...CHANGE,
          application: 'failed',
          error: { code: 'operation-error', diagnostic: output },
          packageResult: { exitCode: 1, truncated: false, logPath: '/probe/pnpm.log', output },
        })
      },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a failed install reports the reason, the tail and the manual command`,
      step.kind === 'done' && rig.lines.some(line => line.includes('operation-error')) &&
      rig.lines.some(line => line.includes('last line')) &&
      // The manual command names the spec that was actually attempted (the pinned
      // version), so running it reproduces the install that failed.
      rig.lines.some(line => line.includes(`dsh plugin --profile dsh-tui add ${PLUGIN}@${VERSION}`)) &&
      rig.lines.some(line => line.includes('dsh-tui safe --rescue')), rig.lines.join(' | '))
    check(`${tag}: the tail never carries the credentials of the registry it quotes`,
      !rig.lines.some(line => line.includes('probe-secret')), rig.lines.join(' | '))
  }

  // The service retains the last outputBytes bytes, and reuses that capture
  // as the error diagnostic. Its leading fragment can be inside credentials.
  for (const [label, prefix, suffix] of [
    ['userinfo', 'fetch https://reader:', '@registry.example.com/x'],
    ['query token', 'GET https://registry.example.com/x?token=', ''],
  ] as const) {
    const secret = 'probe-cutoff-secret'
    const full = `${prefix}${'p'.repeat(1000)}${secret}${suffix} ${'x'.repeat(16200)}\ncomplete captured line\n`
    const bytes = Buffer.from(full)
    const output = bytes.subarray(bytes.length - 16384).toString('utf8')
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        rig.emitLog({ requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream: 'stdout', text: full })
        return Promise.resolve({
          ...CHANGE, application: 'failed',
          error: { code: 'operation-error', diagnostic: output },
          packageResult: { exitCode: 1, output, truncated: true },
        })
      },
    })
    await rig.flow.begin()
    check(`${tag}: a capture starting inside ${label} leaks neither its diagnostic nor its tail`,
      !rig.lines.some(line => line.includes(secret)), rig.lines.join(' | '))
    check(`${tag}: truncation preserves complete captured lines and the structured reason (${label})`,
      rig.lines.some(line => line.includes('complete captured line')) && rig.lines.some(line => line.includes('operation-error')),
      rig.lines.join(' | '))
  }

  // Upstream captures the last 16 KiB, byte by byte, and copies that capture
  // into its failure diagnostic. A retained suffix can lose its URL header.
  // Mixing stdout/stderr can split a URL even without truncating any bytes.
  for (const source of ['userinfo tail', 'query tail', 'interleaved streams'] as const) {
    const secret = 'probe-captured-secret-1528'
    const suffix = source === 'query tail' ? `${secret}&padding=` : `${secret}@registry.example.com/x `
    const prefix = source === 'query tail' ? 'GET https://registry.example.com/x?token=' : 'fetch https://reader:'
    const whole = `${prefix}${suffix}${'x'.repeat(16384 - Buffer.byteLength(suffix))}`
    const captured = source === 'interleaved streams'
      ? `${prefix}stderr-evidence\n${secret}@registry.example.com/x\n`
      : Buffer.from(whole).subarray(-16384).toString('utf8')
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        const log = (text: string, stream: 'stdout' | 'stderr') => rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream, text,
        })
        if (source === 'interleaved streams') {
          log(prefix, 'stdout')
          log('stderr-evidence\n', 'stderr')
          log(`${secret}@registry.example.com/x\n`, 'stdout')
        } else {
          log(`${whole}\n`, 'stdout')
        }
        log('retained-event-evidence\n', 'stderr')
        return Promise.resolve({
          ...CHANGE, application: 'failed',
          error: { code: 'operation-error', diagnostic: captured },
          packageResult: {
            exitCode: 1, truncated: source !== 'interleaved streams', logPath: '/probe/pnpm.log', output: captured,
          },
        })
      },
    })
    const after = await rig.flow.begin()
    check(`${tag}: ${source} cannot reintroduce credentials through output or diagnostic`,
      after.kind === 'done' && !rig.lines.some(line => line.includes(secret)), rig.lines.join(' | '))
    check(`${tag}: ${source} still reports the failure and complete event evidence`,
      rig.lines.some(line => line.includes('operation-error')) && rig.lines.includes('  retained-event-evidence'),
      rig.lines.join(' | '))
    rig.flow.dispose()
  }

  // Logs use a byte budget, including incomplete lines. Never truncate a
  // credential-bearing line into a printable suffix; discard through its next
  // newline, then resume normally. A CR-only progress stream is still one line.
  for (const source of ['one chunk', 'many CR-only chunks', 'wide characters'] as const) {
    const rejectedPrefix = 'OVER-BUDGET-1528'
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        const log = (text: string) => rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream: 'stdout', text,
        })
        // Exactly 16 KiB remains admissible, independently of the implementation's constant.
        const acceptedPrefix = 'AT-BYTE-LIMIT-1528'
        log(`${acceptedPrefix}${'x'.repeat(16384 - acceptedPrefix.length)}\n`)
        log(`${rejectedPrefix} https://reader:probe-oversize-secret@registry.example.com/x `)
        if (source === 'wide characters') log('界'.repeat(5500))
        else if (source === 'one chunk') log('x'.repeat(32768))
        else for (let index = 0; index < 128; index += 1) log(`${'x'.repeat(2048)}\r`)
        log('\nRECOVERED-EVIDENCE-1528\n')
        return Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'operation-error' } })
      },
    })
    await rig.flow.begin()
    const tail = rig.lines.filter(line => line.startsWith('  '))
    check(`${tag}: ${source} drops the whole oversized line, including its prefix`,
      !rig.lines.some(line => line.includes(rejectedPrefix) || line.includes('probe-oversize-secret')),
      rig.lines.join(' | '))
    check(`${tag}: ${source} keeps the byte-limit line and resumes after the discarded one`,
      tail.some(line => line.includes('AT-BYTE-LIMIT-1528')) && tail.includes('  RECOVERED-EVIDENCE-1528')
      && tail.length === 3,
      tail.join(' | '))
    rig.flow.dispose()
  }

  // Failures applying a bundle after pnpm succeeded still have whole activation
  // diagnostics, rather than the failed package run's opaque capture.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed',
        error: { code: 'operation-error', diagnostic: 'activation-evidence-1528' },
        packageResult: { exitCode: 0, truncated: false, output: '', logPath: '/probe/pnpm.log' },
      }),
    })
    await rig.flow.begin()
    check(`${tag}: a failed activation retains its own diagnostic`,
      rig.lines.some(line => line.includes('activation-evidence-1528')), rig.lines.join(' | '))
    rig.flow.dispose()
  }

  // pnpm writes a stream chunk by chunk, and a credential can straddle two of
  // them. Redaction reads URLs, so a fragment that lost its `scheme://user:`
  // head is not one — the line has to be whole before it is judged. Both split
  // positions are covered: inside the userinfo, and inside a query token.
  for (const [label, chunks] of [
    ['userinfo', ['fetch https://reader:', 'probe-secret@registry.example.com/x\n']],
    ['a query token', ['GET https://registry.example.com/x?token=', 'probe-secret\n']],
  ] as const) {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        for (const text of chunks) {
          rig.emitLog({
            requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe',
            stream: 'stdout', text,
          })
        }
        return Promise.resolve({
          ...CHANGE,
          application: 'failed',
          error: { code: 'operation-error', diagnostic: 'pnpm exited 1' },
        })
      },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a credential split across log chunks (${label}) stays out of the report`,
      step.kind === 'done' && !rig.lines.some(line => line.includes('probe-secret')),
      rig.lines.join(' | '))
    check(`${tag}: the same URL is still reported, redacted, once its chunks are joined (${label})`,
      rig.lines.some(line => line.includes('https://registry.example.com/x')), rig.lines.join(' | '))
  }

  // The other end of the same rule: a stream that ends without a newline has
  // still said its last line, and the report keeps it.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe',
          stream: 'stderr', text: 'last line without a newline',
        })
        return Promise.resolve({
          ...CHANGE,
          application: 'failed',
          error: { code: 'operation-error', diagnostic: 'pnpm exited 1' },
        })
      },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a final line with no newline is still reported`,
      step.kind === 'done' && rig.lines.some(line => line.includes('last line without a newline')),
      rig.lines.join(' | '))
  }

  // An oversized line cannot be cut into a publishable suffix. Drop it through
  // its delimiter, keep other streams independent, and resume on the next line.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        const identity = { requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe' }
        rig.emitLog({ ...identity, stream: 'stdout', text: `oversized-line https://reader:${'x'.repeat(65536)}` })
        rig.emitLog({ ...identity, stream: 'stderr', text: 'independent stream line\n' })
        rig.emitLog({ ...identity, stream: 'stdout', text: 'probe-secret@registry.example.com/x\nnext complete line\n' })
        rig.emitLog({ ...identity, stream: 'stdout', text: `oversized-final-line ${'x'.repeat(65536)}` })
        return Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'operation-error' } })
      },
    })
    await rig.flow.begin()
    check(`${tag}: oversized lines and their credential suffixes are discarded, including at EOF`,
      !rig.lines.some(line => /oversized-|probe-secret/u.test(line)), rig.lines.join(' | '))
    check(`${tag}: a discarded line does not lose the next line or another stream`,
      rig.lines.some(line => line.includes('next complete line')) && rig.lines.some(line => line.includes('independent stream line')),
      rig.lines.join(' | '))
  }

  // A service that throws before it hands back a promise: contained like a rejection.
  {
    const rig = makeInstallRig({ feed: TRUSTED, install: () => { throw new Error(SYNC_FAILURE) } })
    const step = await rig.flow.begin()
    check(`${tag}: a service that throws synchronously is contained in one line`,
      step.kind === 'done' && rig.lines.some(line => line.includes(SYNC_FAILURE)), rig.lines.join(' | '))
  }

  // Cancellation: the service's own three-state answer, and no second ending.
  {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => {
        // The service's cancelled answer follows the owned install's rollback.
        resolveInstall?.({ ...CHANGE, application: 'cancelled' })
        return Promise.resolve({ status: 'cancelled' })
      },
    })
    const pending = rig.flow.begin()
    await tick()
    const step = await rig.flow.cancel()
    check(`${tag}: cancelling asks the service for that very request`,
      step.kind === 'done' && rig.cancels.length === 1 && rig.cancels[0] === rig.flow.requestId,
      JSON.stringify(rig.cancels))
    check(`${tag}: the cancellation is reported exactly once`,
      rig.lines.filter(line => line.includes(t('plugins-install-cancelled'))).length === 1, rig.lines.join(' | '))
    // A second Esc (or a second call from anywhere) must not ask again: the first
    // answer is the one that gets reported.
    await rig.flow.cancel()
    check(`${tag}: a second cancel does not ask the service again`,
      rig.cancels.length === 1 && rig.lines.filter(line => line.includes('Install cancelled')).length === 1,
      `${rig.cancels.length} · ${rig.lines.join(' | ')}`)
    await pending
    check(`${tag}: an install that ends cancelled does not report a second ending`,
      !rig.lines.some(line => line.includes('Install failed')), rig.lines.join(' | '))
  }

  // Cancellation refusal or failure does not settle an applying installation.
  for (const status of ['too-late', 'not-running', 'rejected'] as const) {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => status === 'rejected'
        ? Promise.reject(new Error('cancel fixture failed'))
        : Promise.resolve({ status }),
    })
    const pending = rig.flow.begin()
    await tick()
    const first = rig.flow.cancel()
    const second = rig.flow.cancel()
    let cancelled = false
    void first.then(() => { cancelled = true })
    await tick()
    check(`${tag}: ${status} cancellation keeps waiting for the owned install`,
      !cancelled && rig.cancels.length === 1, `${cancelled} · ${rig.cancels.length}`)
    resolveInstall?.(CHANGE)
    await pending
    check(`${tag}: ${status} cancellation settles once the install finishes, including repeated calls`,
      (await first).kind === 'done' && (await second).kind === 'done' &&
      rig.lines.some(line => line.includes(`Installed ${PLUGIN}`)), rig.lines.join(' | '))
  }

  // Cancelling while one exemption is being written waits for that write and
  // starts no more. The completed exemption is reported, never called undone.
  {
    let resolveExemption: ((result: ChangeResult) => void) | undefined
    const packages = ['verify-one', 'verify-two'].map(name => ({ name, version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {} }))
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: packages } }),
      exempt: () => new Promise<ChangeResult>(resolve => { resolveExemption = resolve }),
    })
    const blocked = await rig.flow.begin()
    const granting = rig.flow.acceptRisk()
    const cancellation = rig.flow.cancel()
    let cancelled = false
    void cancellation.then(() => { cancelled = true })
    await tick()
    check(`${tag}: cancelling an exemption waits for the write and does not cancel an expired install`,
      blocked.kind === 'incompatible' && !cancelled && rig.exemptions.length === 1 && rig.cancels.length === 0,
      `${cancelled} · ${JSON.stringify(rig.exemptions)} · ${JSON.stringify(rig.cancels)}`)
    resolveExemption?.(CHANGE)
    await granting
    check(`${tag}: cancellation prevents subsequent exemptions and the install retry`,
      (await cancellation).kind === 'done' && rig.exemptions.length === 1 && rig.installs.length === 1,
      `${JSON.stringify(rig.exemptions)} · ${rig.installs.length}`)
    check(`${tag}: cancellation reports the one exemption that did land`,
      rig.lines.includes(t('plugins-install-exempted', { count: '1' })) && !rig.lines.includes(t('plugins-install-exempted', { count: '2' })),
      rig.lines.join(' | '))
  }

  // Two Escs, one rollback. A repeated cancel shares the owned wait, so a
  // second cancel answers only when the first one does: a `done` that lands
  // before the profile is restored is what lets the screen close the pane (and
  // hand the prompt back) over work that is still going on.
  {
    let resolveCancel: ((value: PluginInstallCancellation) => void) | undefined
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => new Promise<PluginInstallCancellation>(resolve => { resolveCancel = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    const first = rig.flow.cancel()
    const second = rig.flow.cancel()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await tick()
    check(`${tag}: a repeated cancel waits for the rollback instead of answering early`,
      !secondSettled && rig.cancels.length === 1, `settled ${secondSettled} · ${rig.cancels.length}`)
    resolveCancel?.({ status: 'cancelled' })
    resolveInstall?.({ ...CHANGE, application: 'cancelled' })
    await pending
    check(`${tag}: both cancels settle on the one answer`,
      (await first).kind === 'done' && (await second).kind === 'done', `${secondSettled}`)
    check(`${tag}: the rollback is still announced exactly once`,
      rig.lines.filter(line => line.includes(t('plugins-install-cancelled'))).length === 1,
      rig.lines.join(' | '))
  }

  // Closing the pane while the spec is still being read: the inspection's answer
  // must not start an install, and there is nothing in flight to cancel.
  {
    let resolveInspect: ((value: PluginSpecInspection) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      inspect: () => new Promise<PluginSpecInspection>(resolve => { resolveInspect = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    const step = await rig.flow.cancel()
    resolveInspect?.(ACCEPTED)
    check(`${tag}: cancelling while the spec is still being read installs nothing`,
      (await pending).kind === 'done' && step.kind === 'done' && rig.installs.length === 0,
      `${rig.installs.length} installs · ${rig.lines.join(' | ')}`)
    check(`${tag}: cancelling before anything started does not ask the service to cancel`,
      rig.cancels.length === 0, JSON.stringify(rig.cancels))
    check(`${tag}: nothing claims an install was cancelled when none had started`,
      !rig.lines.some(line => line.includes('Install cancelled') || line.includes('realign it')),
      rig.lines.join(' | '))
  }

  // The fence: a session that moved on gets no further lines, and the run goes on.
  {
    let binding = 7
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      binding: () => binding,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    binding = 8
    rig.emitState({ requestId: rig.flow.requestId, phase: 'installing', attempt: { registry: 'https://registry.example.com/', index: 1, total: 2 } })
    rig.emitLog({ requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream: 'stdout', text: 'late output' })
    resolveInstall?.({ ...CHANGE })
    await pending
    check(`${tag}: a report for a session that moved on stays out of the transcript`,
      !rig.lines.some(line => line.includes('Asking registry') || line.includes('late output') || line.includes('Installed')),
      rig.lines.join(' | '))
    check(`${tag}: the lines written while it was still bound are kept`,
      rig.lines.some(line => line.includes('First-party (feed hit)')), rig.lines.join(' | '))
  }

  // Progress: the service's own phases, in the transcript, before the result.
  {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    rig.emitState({ requestId: rig.flow.requestId, phase: 'installing', attempt: { registry: 'https://registry.example.com/', index: 1, total: 2 } })
    rig.emitState({ requestId: rig.flow.requestId, phase: 'applying' })
    resolveInstall?.({ ...CHANGE })
    await pending
    check(`${tag}: the registry attempts and the applying phase are reported`,
      rig.lines.some(line => line.includes('Asking registry 1/2') && line.includes('registry.example.com')) &&
      rig.lines.some(line => line.includes('Applying')), rig.lines.join(' | '))
    check(`${tag}: the result follows the progress it reports`,
      rig.lines.findIndex(line => line.includes('Installed')) >
      rig.lines.findIndex(line => line.includes('Asking registry')), rig.lines.join(' | '))
    check(`${tag}: a restart-required install says so, and asks for the restart`,
      rig.lines.some(line => line.includes('restart required')) &&
      rig.lines.some(line => line.includes('Restart this app')), rig.lines.join(' | '))
  }

  // #1340: an install that moves this application's own version is reported,
  // never repaired.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      ownVersion: '0.15.0',
      bundles: [{
        name: COMPOSITION_PACKAGE, version: '0.14.0', enabled: true, installed: true,
        optional: false, removable: true, rows: [], overrides: [],
      }],
    })
    await rig.flow.begin()
    check(`${tag}: an install that moved this app's own version is reported with the fix`,
      rig.lines.some(line => line.includes('0.14.0') && line.includes('0.15.0') &&
        line.includes(`dsh plugin --profile dsh-tui add ${COMPOSITION_PACKAGE}@0.15.0`)), rig.lines.join(' | '))
  }
  {
    const rig = makeInstallRig({ feed: TRUSTED, ownVersion: '0.15.0' })
    await rig.flow.begin()
    check(`${tag}: an install that left this app's own version alone is silent about it`,
      !rig.lines.some(line => line.includes('realign it')), rig.lines.join(' | '))
  }
}

// ── The lifecycle flow, headless (C-5) ───────────────────────────────────────
// What `/plugin remove | enable | disable` refuses, what it asks about, and what
// it does with each shape of result. No terminal: the flow's whole contract is the
// steps it hands back and the lines it writes, and a fake service can produce every
// branch — the real one needs a profile and a package manager.
{
  const tag = 'manage flow'
  const APP = COMPOSITION_PACKAGE
  const HOST = HOST_BUNDLE
  const THIRD = 'probe-managed-plugin'
  const KEPT = 'probe-kept-bundle'
  const LOCKED = 'probe-locked-bundle'
  const HOST_ROW_MODULE = '@deepseek-ai/dsh-host-webserver'
  const LEFTOVER = '/probe/home/.dsh-tui/backends/probe-backend'

  /**
   * A profile in the shape gate 2 exists for: the application and the host layer
   * are reported as perfectly **addressable** (`removable: true`, no
   * `readOnlyReason`), which is exactly what the real host does — its protected
   * list is first-party module names, and ours are not in it. A case that passes
   * only because the host locked something is not testing the guard at all.
   */
  const MANAGE_BUNDLES: BundleInfo[] = [
    {
      name: HOST, version: '0.2.0-rc.2', enabled: true, installed: false, optional: false, removable: true,
      rows: [{ rowId: 'host-webserver', moduleName: HOST_ROW_MODULE }], overrides: ['tool-web'],
    },
    {
      name: APP, version: '0.15.0', enabled: true, installed: true, optional: false, removable: true,
      // The shape a real profile reports: this bundle's patch inserts rows that
      // load first-party modules too, and the host protects only one of those
      // (`@deepseek-ai/dsh-host-webserver`). The rest are ours because our patch
      // inserts them — which no module-name rule can see.
      rows: [
        { rowId: 'tui-row', moduleName: APP },
        { rowId: 'tui-storage', moduleName: '@deepseek-ai/dsh-storage' },
        { rowId: 'tui-webserver', moduleName: HOST_ROW_MODULE },
      ],
      overrides: ['tool-web'],
    },
    {
      name: THIRD, version: '1.0.0', enabled: false, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'third-row', moduleName: THIRD }], overrides: [],
    },
    // Supplied by the installation, so the host says it is not removable.
    { name: KEPT, version: '2.0.0', enabled: true, installed: false, optional: true, removable: false, rows: [], overrides: [] },
    // The host's own lock: reported, never re-derived into a rule of ours.
    {
      name: LOCKED, version: '3.0.0', enabled: true, installed: true, optional: false, removable: false,
      readOnlyReason: 'management-required', rows: [], overrides: [],
    },
  ]
  const MANAGE_PLUGINS: PluginInfo[] = [
    { entryId: 'entry-app' as PluginEntryId, moduleName: APP, enabled: true, patchId: 'tui-row' },
    // This application's own row loading a first-party module: addressable as far
    // as the host is concerned, and still this application's.
    { entryId: 'entry-storage' as PluginEntryId, moduleName: '@deepseek-ai/dsh-storage', enabled: true, patchId: 'tui-storage' },
    // The host layer's own `tool-web` row, which this application's patch overrides:
    // legitimate to switch off, with a word of warning.
    { entryId: 'entry-tool-web' as PluginEntryId, moduleName: '@deepseek-ai/dsh-tools', enabled: true, patchId: 'tool-web' },
    { entryId: 'entry-host' as PluginEntryId, moduleName: HOST_ROW_MODULE, enabled: true, patchId: 'host-webserver' },
    { entryId: 'entry-third' as PluginEntryId, moduleName: THIRD, enabled: false, patchId: 'third-row' },
    // A seam row of this application: a subpath of the package, and the shape
    // that has no bundle of the same name — so it is reachable by the module name
    // the report prints, which is how gate 2's prefix rule gets exercised here.
    { entryId: 'entry-seam' as PluginEntryId, moduleName: `${APP}/panels`, enabled: true, patchId: 'seam-row' },
    // One character of difference from a core row, and a plugin like any other.
    { entryId: 'entry-sibling' as PluginEntryId, moduleName: `${APP}-extra`, enabled: true, patchId: 'sibling-row' },
    { entryId: 'entry-orphan' as PluginEntryId, moduleName: 'orphan-row', enabled: true, readOnlyReason: 'unaddressable' },
  ]
  const CHANGED = { changed: true, application: 'applied', stage: 'enable', target: THIRD } as const

  /** Gate 2's refusal lines, by the rule they break: a refusal has to say which. */
  const REFUSALS: Record<string, Parameters<typeof t>[0]> = {
    'app-bundle': 'plugins-manage-refused-app-bundle',
    'host-bundle': 'plugins-manage-refused-host-bundle',
    'not-removable': 'plugins-manage-refused-not-removable',
    'row-not-removable': 'plugins-manage-refused-row-not-removable',
    'app-row': 'plugins-manage-refused-app-row',
    'service-locked': 'plugins-manage-refused-service-locked',
  }

  interface ManageRig {
    readonly flow: PluginManageFlow
    readonly lines: string[]
    /** Every write the flow made, in order, as `method:argument`. */
    readonly calls: string[]
    setChange(next: () => Promise<ChangeResult>): void
  }

  function makeManageRig(options: {
    readonly action: 'remove' | 'enable' | 'disable'
    readonly target: string
    readonly bundles?: readonly BundleInfo[]
    readonly plugins?: readonly PluginInfo[]
    readonly binding?: () => number
    readonly busy?: () => boolean
    readonly change?: () => Promise<ChangeResult>
    /** A resolution that throws before it returns a promise. */
    readonly reads?: () => Promise<never>
    /** The removal's leftover watch: a fixture, since the real one reads a package. */
    readonly residue?: (name: string) => PluginResidueWatch | undefined
  }): ManageRig {
    const lines: string[] = []
    const calls: string[] = []
    let change = options.change ?? ((): Promise<ChangeResult> => Promise.resolve(CHANGED))
    const service: PluginManagerView = {
      ...manager,
      listBundles: () => options.reads?.() ?? Promise.resolve([...(options.bundles ?? MANAGE_BUNDLES)]),
      listPlugins: () => Promise.resolve([...(options.plugins ?? MANAGE_PLUGINS)]),
      removeBundle: name => { calls.push(`removeBundle:${name}`); return change() },
      setBundleEnabled: (name, enabled) => { calls.push(`setBundleEnabled:${name}:${String(enabled)}`); return change() },
      setPluginEnabled: (id, enabled) => { calls.push(`setPluginEnabled:${String(id)}:${String(enabled)}`); return change() },
    }
    const flow = createPluginManageFlow({
      manager: service,
      action: options.action,
      target: options.target,
      binding: options.binding ?? (() => 0),
      busy: options.busy ?? (() => false),
      onLines: batch => { lines.push(...batch) },
      profileName: 'probe-profile',
      residueOf: options.residue,
    })
    return { flow, lines, calls, setChange: next => { change = next } }
  }
  type ManageOptions = Omit<Parameters<typeof makeManageRig>[0], 'action' | 'target'>
  /** Run one form to its end, optionally answering the confirmation it asks. */
  async function manage(
    action: 'remove' | 'enable' | 'disable',
    target: string,
    options: ManageOptions = {},
    confirm = false,
  ): Promise<ManageRig & { readonly first: PluginManageStep }> {
    const rig = makeManageRig({ action, target, ...options })
    const first = await rig.flow.begin()
    if (confirm && first.kind === 'confirm') await rig.flow.confirm()
    return { ...rig, first }
  }
  const has = (rig: { readonly lines: readonly string[] }, text: string): boolean => rig.lines.some(line => line.includes(text))

  // Gate 2: the three suicides, each refused with the rule it broke and with no
  // service call at all. The last two reach the same row by its `entryId` and by
  // its module name — the report prints the module, so that is what a person types.
  for (const [label, action, target, reason, named] of [
    ['removing the application bundle', 'remove', APP, 'app-bundle', APP],
    ['disabling the application bundle', 'disable', APP, 'app-bundle', APP],
    ['removing the host layer', 'remove', HOST, 'host-bundle', HOST],
    ['disabling the host layer', 'disable', HOST, 'host-bundle', HOST],
    ['disabling a row of this application', 'disable', 'entry-app', 'app-row', APP],
    ['disabling a seam row of this application by module name', 'disable', `${APP}/panels`, 'app-row', `${APP}/panels`],
  ] as const) {
    const rig = await manage(action, target)
    check(`${tag}: ${label} is refused, and the service is never asked`,
      rig.first.kind === 'done' && rig.calls.length === 0, `${rig.first.kind} · ${rig.calls.join(',')}`)
    check(`${tag}: ${label} names the rule it broke`,
      has(rig, t(REFUSALS[reason]!, { target: named })), rig.lines.join(' | '))
  }

  // A name only a bundle has wins over a row identity, and the next package along
  // is not this one: the prefix rule needs the separator, so `…-extra` is a plugin
  // like any other (and asks, rather than being refused).
  {
    const bundle = await manage('disable', APP)
    check(`${tag}: a name that is both a bundle and a row resolves to the bundle`,
      bundle.calls.length === 0 && has(bundle, t(REFUSALS['app-bundle']!, { target: APP })), bundle.lines.join(' | '))
    const sibling = await manage('disable', `${APP}-extra`)
    check(`${tag}: a module that merely starts the same is not this application's row`,
      sibling.first.kind === 'done' && sibling.calls.join(',') === 'setPluginEnabled:entry-sibling:false',
      `${sibling.first.kind} · ${sibling.calls.join(',')}`)
  }

  // The measured half of gate 2's row rule: this application's own patch inserts
  // rows that load first-party modules, and the host protects only one of them. A
  // module-name rule cannot see the rest, so the snapshot has to say they are ours.
  {
    const own = await manage('disable', 'entry-storage')
    check(`${tag}: a row this application's own patch inserts is refused, first-party module or not`,
      own.first.kind === 'done' && own.calls.length === 0 &&
      has(own, t(REFUSALS['app-row']!, { target: '@deepseek-ai/dsh-storage' })), `${own.first.kind} · ${own.lines.join(' | ')}`)
    // …while the host layer's own row stays a legitimate, confirmed action: that is
    // the whole difference between "ours" and "the host's".
    const hostRow = await manage('disable', 'entry-tool-web')
    check(`${tag}: a host-layer row is switchable, and asks first`,
      hostRow.first.kind === 'confirm' && hostRow.first.question.kind === 'host-row' && hostRow.calls.length === 0,
      `${hostRow.first.kind} · ${hostRow.calls.join(',')}`)
    const off = await manage('disable', 'entry-tool-web', {}, true)
    check(`${tag}: confirming switches the host layer's own row off`,
      off.calls.join(',') === 'setPluginEnabled:entry-tool-web:false', off.calls.join(','))
  }

  // The host's own lock is reported as such, with the reason the host gave — never
  // re-derived, and never turned into one of our rules. It refuses both directions,
  // because the service itself does.
  {
    const locked = await manage('remove', LOCKED)
    check(`${tag}: a target the host locked is refused with the host's own reason`,
      locked.first.kind === 'done' && locked.calls.length === 0 &&
      has(locked, t(REFUSALS['service-locked']!, { target: LOCKED, reason: 'management-required' })),
      locked.lines.join(' | '))
    const enabled = await manage('enable', 'entry-orphan')
    check(`${tag}: the host's lock refuses enable too — it is not ours to lift`,
      enabled.calls.length === 0 &&
      has(enabled, t(REFUSALS['service-locked']!, { target: 'orphan-row', reason: 'unaddressable' })),
      enabled.lines.join(' | '))
    const row = await manage('remove', 'entry-third')
    check(`${tag}: a row is not removed on its own, and nothing is called`,
      row.calls.length === 0 && has(row, t(REFUSALS['row-not-removable']!, { target: THIRD })), row.lines.join(' | '))
  }

  // A bundle the installation supplied is the host's `not-removable`, a different
  // answer from "this is core": it says why, and the bundle is still switchable.
  {
    const rig = await manage('remove', KEPT)
    check(`${tag}: a bundle the host calls not removable is refused for that reason`,
      rig.calls.length === 0 && has(rig, t(REFUSALS['not-removable']!, { target: KEPT })), rig.lines.join(' | '))
    const off = await manage('disable', KEPT)
    check(`${tag}: …and switching it off needs no confirmation`,
      off.calls.join(',') === `setBundleEnabled:${KEPT}:false`, off.lines.join(' | '))
  }

  // Removing a third-party bundle: destructive, so it asks — and asking is not
  // doing. The write happens once, on the confirmation, and it names the bundle.
  {
    const asked = await manage('remove', THIRD)
    check(`${tag}: removing a third-party bundle asks first, and writes nothing yet`,
      asked.first.kind === 'confirm' && asked.first.question.kind === 'remove' && asked.calls.length === 0,
      `${asked.first.kind} · ${asked.calls.join(',')}`)
    const done = await manage('remove', THIRD, {}, true)
    check(`${tag}: confirming removes exactly that bundle, once`,
      done.calls.join(',') === `removeBundle:${THIRD}`, done.calls.join(','))
    check(`${tag}: the removal reports the service's own outcome`,
      has(done, t('plugins-manage-removed', { target: THIRD, state: t('plugins-install-state-applied') })),
      done.lines.join(' | '))
  }

  // `application` is the same funnel an installation goes through, so it gets the
  // same three words for what the running host did with the write.
  {
    const restart = await manage('remove', THIRD, {
      change: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'remove', target: THIRD }),
    }, true)
    check(`${tag}: a write that needs a restart says so`,
      has(restart, t('plugins-manage-removed', { target: THIRD, state: t('plugins-install-state-restart') })) &&
      has(restart, t('plugins-install-restart-hint')), restart.lines.join(' | '))
    const overridden = await manage('disable', THIRD, {
      change: () => Promise.resolve({ changed: true, application: 'overridden', stage: 'enable', target: THIRD }),
    })
    check(`${tag}: an overridden write says HMR is live, in the install flow's own words`,
      has(overridden, t('plugins-install-state-overridden')), overridden.lines.join(' | '))
    // Repeating an action can leave the patch unchanged while the running host
    // still overrides it or still needs a restart. The two outcomes are independent.
    for (const action of ['enable', 'disable'] as const) {
      for (const application of ['overridden', 'restart-required'] as const) {
        for (const changed of [true, false]) {
          const rig = await manage(action, 'entry-third', {
            change: () => Promise.resolve({ changed, application, stage: 'enable', target: 'entry-third' }),
          }, true)
          const state = t(application === 'overridden' ? 'plugins-install-state-overridden' : 'plugins-install-state-restart')
          check(`${tag}: ${action} with changed=${String(changed)} preserves ${application}`,
            has(rig, t(action === 'enable' ? 'plugins-manage-enabled' : 'plugins-manage-disabled', { target: THIRD, state })) &&
            !has(rig, t('plugins-manage-unchanged', { target: THIRD })) &&
            (application !== 'restart-required' || has(rig, t('plugins-install-restart-hint'))), rig.lines.join(' | '))
        }
      }
    }
  }

  // The write that changed nothing: the profile is already in that state, and the
  // report says exactly that instead of dressing it up as an action.
  {
    const rig = await manage('disable', THIRD, {
      change: () => Promise.resolve({ changed: false, application: 'applied', stage: 'enable', target: THIRD }),
    })
    check(`${tag}: a write that changed nothing says so`,
      rig.calls.join(',') === `setBundleEnabled:${THIRD}:false` &&
      has(rig, t('plugins-manage-unchanged', { target: THIRD })) &&
      !has(rig, t('plugins-manage-disabled', { target: THIRD, state: t('plugins-install-state-applied') })),
      rig.lines.join(' | '))
  }

  // Installed metadata has no source attestation, even when it matches the feed.
  {
    const feed = loadFirstPartyFeed()
    if (feed.kind !== 'ok') throw new Error(feed.reason)
    const pinned = feed.feed.entries[0]!
    const matching = await manage('enable', pinned.name, {
      bundles: [{ ...MANAGE_BUNDLES[1]!, name: pinned.name, version: pinned.version }],
    })
    check(`${tag}: matching the shipped feed's exact identity still requires confirmation`,
      matching.first.kind === 'confirm' && matching.first.question.kind === 'trust' && matching.calls.length === 0,
      `${matching.first.kind} · ${matching.calls.join(',')}`)
    const unverified = await manage('enable', THIRD)
    check(`${tag}: enabling any installed bundle asks before writing`,
      unverified.first.kind === 'confirm' && unverified.first.question.kind === 'trust' && unverified.calls.length === 0,
      `${unverified.first.kind} · ${unverified.calls.join(',')}`)
    const asked = await manage('enable', THIRD, {}, true)
    check(`${tag}: confirming trust enables exactly that bundle, once`,
      asked.calls.join(',') === `setBundleEnabled:${THIRD}:true`, asked.calls.join(','))
    const row = await manage('enable', 'entry-third')
    check(`${tag}: enabling a row also requires confirmation`,
      row.first.kind === 'confirm' && row.first.question.kind === 'trust' && row.calls.length === 0,
      `${row.first.kind} · ${row.calls.join(',')}`)
  }

  // A module can have several differently configured rows. Enumeration order
  // must never decide which one is changed; an explicit identity still works.
  {
    const moduleName = '@probe/multi-instance'
    const rows: PluginInfo[] = [
      { entryId: 'entry-alpha' as PluginEntryId, patchId: 'row-alpha', moduleName, enabled: true },
      { entryId: 'entry-beta' as PluginEntryId, patchId: 'row-beta', moduleName, enabled: true },
    ]
    for (const plugins of [rows, [...rows].reverse()]) {
      for (const action of ['enable', 'disable'] as const) {
        const rig = await manage(action, moduleName, { plugins })
        check(`${tag}: ${action} by an ambiguous module name writes nothing in either order`,
          rig.first.kind === 'done' && rig.calls.length === 0, `${rig.first.kind} · ${rig.calls.join(',')}`)
        check(`${tag}: ${action} lists the explicit identities instead of choosing a row`,
          has(rig, t('plugins-manage-ambiguous', { target: moduleName, ids: plugins.map(row => row.entryId).join(', ') })),
          rig.lines.join(' | '))
      }
      const enabled = await manage('enable', 'entry-alpha', { plugins }, true)
      check(`${tag}: an explicit entry id enables only its row in either order`,
        enabled.calls.join(',') === 'setPluginEnabled:entry-alpha:true', enabled.calls.join(','))
      const disabled = await manage('disable', 'row-beta', { plugins })
      check(`${tag}: an explicit patch id disables only its row in either order`,
        disabled.calls.join(',') === 'setPluginEnabled:entry-beta:false', disabled.calls.join(','))
    }
  }

  // `disable` asks about one thing only: a row the host layer owns, whose removal
  // takes this application's own services down with it. Which rows those are comes
  // from `dsh-base`'s own rows and overrides — not from a list kept here.
  {
    const hostRow = await manage('disable', 'entry-host')
    check(`${tag}: disabling a host-layer row asks first, and writes nothing yet`,
      hostRow.first.kind === 'confirm' && hostRow.first.question.kind === 'host-row' && hostRow.calls.length === 0,
      `${hostRow.first.kind} · ${hostRow.calls.join(',')}`)
    const done = await manage('disable', 'entry-host', {}, true)
    check(`${tag}: confirming switches that row off by the id the service takes`,
      done.calls.join(',') === 'setPluginEnabled:entry-host:false', done.calls.join(','))
    const third = await manage('disable', 'entry-third')
    check(`${tag}: a third-party row is reversible and needs no confirmation`,
      third.first.kind === 'done' && third.calls.join(',') === 'setPluginEnabled:entry-third:false',
      `${third.first.kind} · ${third.calls.join(',')}`)
  }

  // A failure arrives in-band (`application: 'failed'`), and the manual route it
  // prints depends on what was asked: only a removal has a CLI verb. Handing out
  // the install flow's `add` here would name a command that undoes the opposite.
  {
    const failed = await manage('remove', THIRD, {
      change: () => Promise.resolve({
        changed: false, application: 'failed', stage: 'remove', target: THIRD,
        error: { code: 'not-removable' },
      }),
    }, true)
    check(`${tag}: a failed removal reports the service's own code`,
      has(failed, t('plugins-manage-failed', { reason: 'not-removable' })), failed.lines.join(' | '))
    check(`${tag}: a failed removal prints the CLI remove command for this profile`,
      has(failed, `dsh plugin --profile probe-profile remove ${THIRD}`), failed.lines.join(' | '))
    check(`${tag}: a failed removal never prints the install flow's add command`,
      !failed.lines.some(line => line.includes(' add ')), failed.lines.join(' | '))
  }
  {
    const incompatible = await manage('enable', THIRD, {
      change: () => Promise.resolve({
        changed: false, application: 'failed', stage: 'enable', target: THIRD,
        error: {
          code: 'incompatible-version',
          incompatible: [{ name: THIRD, version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: { '@deepseek-ai/dsh': '^9' } }],
        },
      }),
    }, true)
    check(`${tag}: an incompatible enable lists what the running host refuses`,
      has(incompatible, `${THIRD}@1.0.0`), incompatible.lines.join(' | '))
    check(`${tag}: …and points at the CLI's own allow-version verb`,
      has(incompatible, 'dsh plugin --profile probe-profile allow-version'), incompatible.lines.join(' | '))
    check(`${tag}: enable and disable have no CLI verb, so the route offered is the profile`,
      has(incompatible, t('plugins-manage-manual-profile', { profile: 'probe-profile', target: THIRD })),
      incompatible.lines.join(' | '))
  }
  // A removal runs pnpm too, so the failure reason it prints goes through the very
  // rule the install flow's report does: a package run's capture can begin halfway
  // through a credential-bearing URL, and reusing it as the diagnostic would put
  // that fragment in the transcript. One implementation, two callers.
  {
    const secret = 'manage-cutoff-secret'
    const full = `fetch https://reader:${'p'.repeat(1000)}${secret}@registry.example.com/x ${'x'.repeat(16200)}\ncomplete captured line\n`
    const bytes = Buffer.from(full)
    const output = bytes.subarray(bytes.length - 16384).toString('utf8')
    const rig = await manage('remove', THIRD, {
      change: () => Promise.resolve({
        changed: false, application: 'failed', stage: 'remove', target: THIRD,
        error: { code: 'operation-error', diagnostic: output },
        packageResult: { exitCode: 1, output, truncated: true, logPath: '/probe/log' },
      }),
    }, true)
    check(`${tag}: a failed removal never prints a capture that starts inside a credential`,
      !rig.lines.some(line => line.includes(secret)), rig.lines.join(' | '))
    check(`${tag}: …but it still names the structured reason`,
      has(rig, t('plugins-manage-failed', { reason: 'operation-error' })), rig.lines.join(' | '))
  }

  // A rejected call and one that throws before returning a promise both have to
  // leave a readable line: the second is the shape `.catch` cannot see.
  {
    const rejected = await manage('remove', THIRD, {
      change: () => Promise.reject(new Error(SERVICE_FAILURE)),
    }, true)
    check(`${tag}: a rejected write leaves one line, not an unhandled rejection`,
      has(rejected, t('plugins-manage-failed', { reason: SERVICE_FAILURE })), rejected.lines.join(' | '))
    const thrown = await manage('remove', THIRD, {
      change: () => { throw new Error(SYNC_FAILURE) },
    }, true)
    check(`${tag}: a write that throws before answering is contained the same way`,
      has(thrown, t('plugins-manage-failed', { reason: SYNC_FAILURE })), thrown.lines.join(' | '))
    const readsThrow = await manage('remove', THIRD, { reads: () => { throw new Error(SYNC_FAILURE) } })
    check(`${tag}: a resolution that throws synchronously is contained too`,
      readsThrow.first.kind === 'done' && readsThrow.calls.length === 0 &&
      has(readsThrow, t('plugins-service-error', { err: SYNC_FAILURE })), readsThrow.lines.join(' | '))
  }

  // A turn is running: nothing is asked, nothing is called — checked before the
  // resolution, and again before the write (a turn can start while a pane waits).
  {
    let busy = true
    const early = makeManageRig({ action: 'remove', target: THIRD, busy: () => busy })
    const first = await early.flow.begin()
    check(`${tag}: a running turn refuses the action before anything is read`,
      first.kind === 'done' && early.calls.length === 0 && has(early, t('plugins-manage-busy')), early.lines.join(' | '))
    busy = false
    const late = makeManageRig({ action: 'remove', target: THIRD, busy: () => busy })
    const asked = await late.flow.begin()
    busy = true
    await late.flow.confirm()
    check(`${tag}: a turn that starts while the pane waits is caught before the write`,
      asked.kind === 'confirm' && late.calls.length === 0 && has(late, t('plugins-manage-busy')), late.lines.join(' | '))
  }

  // Nothing is guessed about the target: an unmatched one is reported with what is
  // addressable, and no service is written.
  {
    const rig = await manage('remove', 'probe-not-a-target')
    check(`${tag}: an unmatched target is reported with what is addressable`,
      rig.first.kind === 'done' && rig.calls.length === 0 &&
      has(rig, 'probe-not-a-target') && has(rig, THIRD) && has(rig, APP) && has(rig, HOST_ROW_MODULE),
      rig.lines.join(' | '))
  }

  // The binding fence: a write that lands after the session moved on is dropped.
  // The run itself is profile-level and finishes either way.
  {
    let binding = 0
    const rig = makeManageRig({ action: 'remove', target: THIRD, binding: () => binding })
    await rig.flow.begin()
    binding = 1
    await rig.flow.confirm()
    check(`${tag}: an answer that lands after the session moved on is not written`,
      rig.calls.length === 1 && rig.lines.length === 0, `${rig.calls.join(',')} · ${rig.lines.join(' | ')}`)
  }

  // What a removal left behind (decision D): reported once, deleted by nobody but
  // the person. Nothing is said when the check judged it and found nothing, and
  // "could not judge" is its own answer rather than a clean bill of health.
  {
    const withResidue = await manage('remove', THIRD, { residue: () => () => [LEFTOVER] }, true)
    check(`${tag}: a removal that left data behind says where it is`,
      has(withResidue, t('plugins-manage-residue', { paths: LEFTOVER })), withResidue.lines.join(' | '))
    const clean = await manage('remove', THIRD, { residue: () => () => [] }, true)
    check(`${tag}: a removal that left nothing says nothing about residue`,
      !has(clean, LEFTOVER) && !has(clean, t('plugins-manage-residue-unjudged', { target: THIRD })) &&
      has(clean, t('plugins-manage-removed', { target: THIRD, state: t('plugins-install-state-applied') })),
      clean.lines.join(' | '))
    const unjudged = await manage('remove', THIRD, { residue: () => undefined }, true)
    check(`${tag}: a declaration that could not be read is reported as not judged`,
      has(unjudged, t('plugins-manage-residue-unjudged', { target: THIRD })), unjudged.lines.join(' | '))
    const brokenWatch = await manage('remove', THIRD, { residue: () => () => { throw new Error('EACCES') } }, true)
    check(`${tag}: a footprint check that throws is "not judged", never "nothing left"`,
      has(brokenWatch, t('plugins-manage-residue-unjudged', { target: THIRD })), brokenWatch.lines.join(' | '))
    const unreadable = await manage('remove', THIRD, { residue: () => { throw new Error('EACCES') } }, true)
    check(`${tag}: a declaration read failure still removes the bundle and reports unjudged residue`,
      unreadable.calls.join(',') === `removeBundle:${THIRD}` &&
      has(unreadable, t('plugins-manage-removed', { target: THIRD, state: t('plugins-install-state-applied') })) &&
      has(unreadable, t('plugins-manage-residue-unjudged', { target: THIRD })), unreadable.lines.join(' | '))
    const notARemoval = await manage('disable', THIRD, { residue: () => () => [LEFTOVER] })
    check(`${tag}: only a removal looks for residue`,
      !has(notARemoval, LEFTOVER), notARemoval.lines.join(' | '))
  }
}

// ── `/plugin install` through the real Chat (C-4) ───────────────────────────
// The pane the flow asks through: gate 1's notice, gate 3's routing, and the one
// step where a person approves build scripts. The flow is the real one; only the
// service, the feed and the clock's answers are fixtures.
{
  const tag = 'install pane'
  const PLUGIN = '@probe/verify-fresh-plugin'
  const VERSION = '9.9.9'
  const accepted = { status: 'accepted', kind: 'registry', name: PLUGIN, version: VERSION, bundle: true, registry: null } as const
  const firstParty: FirstPartyFeedLoad = {
    kind: 'ok', path: '/probe/tui-profile/feed/first-party.json',
    feed: { feedVersion: 1, entries: [{ name: PLUGIN, scope: '@probe', version: VERSION }] },
  }
  const noFeed: FirstPartyFeedLoad = { kind: 'unavailable', reason: 'feed file is missing (probe)' }
  const CHANGE = { changed: true, application: 'restart-required', stage: 'install', target: PLUGIN } as const

  /**
   * One Chat with the install prop wired to a flow over `service`/`feed`.
   * `notice` is what the entry reads about the package's declarations; the
   * fixtures answer it directly (reading a real dsh-plugin.json is
   * `verify-plugin-feed`'s and `verify-plugin-negotiation`'s job).
   */
  async function mountInstallChat(options: {
    readonly feed: FirstPartyFeedLoad
    readonly notice: PluginInstallNotice
    /** What one install answers; the options it was handed are the fixture's view of `approvedBuilds`. */
    readonly install: (settings: InstallBundleOptions) => Promise<ChangeResult>
    /** Defers the service's answer to `cancelInstall`: the rollback's own clock. */
    readonly cancel?: () => Promise<PluginInstallCancellation>
    /** What the service answers for one spec; the fixture's registry answer by default. */
    readonly inspect?: (spec: string) => Promise<PluginSpecInspection>
    /** The request id of the Nth install in this Chat; one fixed id by default. */
    readonly requestId?: (index: number) => PluginInstallRequestId
    /** 窄终端与全屏是终端可见改动的必测面（AGENTS.md）：默认 inline 100 列。 */
    readonly columns?: number
    readonly fullscreen?: boolean
  }) {
    const installs: InstallBundleOptions[] = []
    const installSpecs: string[] = []
    const cancels: PluginInstallRequestId[] = []
    let inspections = 0
    const service: PluginManagerView = {
      ...manager,
      inspect: (spec: string) => {
        inspections += 1
        return options.inspect?.(spec) ?? Promise.resolve(accepted)
      },
      installBundle: (spec, settings) => {
        const installOptions = settings ?? {}
        installSpecs.push(spec)
        installs.push(installOptions)
        return options.install(installOptions)
      },
      cancelInstall: requestId => {
        cancels.push(requestId)
        return options.cancel?.() ?? Promise.resolve({ status: 'cancelled' } as const)
      },
      listBundles: () => Promise.resolve(bundles),
    }
    const { term, stdin, screen, hasText, run, render } = makeHarness(options.columns ?? 100, options.fullscreen ?? false)
    const ctx = {
      on: () => () => undefined,
      get: (name: string) => name === 'pluginManager' ? service : undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    } as never
    // The session's event feed is the channel's only way in, so the listeners are
    // kept: a case that needs `channel.working` starts a turn through them.
    const listeners = new Set<(events: readonly unknown[], meta: { replay: boolean }) => void>()
    const session = {
      ...createDshSession(ctx, { agent: makeAgent('plugin-install', 's-plugin-install') as never }),
      subscribe: (listener: (events: readonly unknown[], meta: { replay: boolean }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      submit: () => Promise.resolve({ accepted: true }),
    }
    const channel = createChannel(ctx, session as never, {
      model: 'fake-model', provider: '', cwd: process.cwd(), activity: false,
    })
    let flows = 0
    // The rig is the host here: it decides the layout AND hands it to the screen,
    // so the two cannot drift apart the way `fullscreen: false` let them (the
    // fullscreen case was rendering an inline Chat under a fullscreen label).
    const chatProps = {
      channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
      onExit: () => undefined, fullscreen: options.fullscreen ?? false, trajectorySeen: true,
      kernelEntries: kernelEntriesOf(listBackends()),
      onPluginInstall: (args: string, sink: PluginInstallSink) => {
        const parsed = parsePluginArgs(args)
        if (parsed.kind !== 'install' || parsed.spec === '') return undefined
        const index = flows
        flows += 1
        return createPluginInstallFlow({
          manager: service,
          spec: parsed.spec,
          feed: options.feed,
          noticeOf: () => options.notice,
          binding: sink.binding,
          busy: sink.busy,
          onLines: sink.onLines,
          requestId: options.requestId?.(index) ?? ('probe-pane' as PluginInstallRequestId),
        })
      },
    }
    const instance = await render(React.createElement(Chat, chatProps))
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    /** One turn event onto the bound session; `channel.working` follows it. */
    const turnEvent = (started: boolean): void => {
      const event = started
        ? { type: 'turn.start', turn: 1, origin: 'user', time: 1 }
        : { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2 }
      for (const listener of listeners) listener([event], { replay: false })
    }
    return {
      installs, installSpecs, cancels, screen, hasText,
      run,
      get inspections(): number { return inspections },
      /** What the screen was actually handed (not what the case asked for). */
      chatFullscreen: (): boolean => chatProps.fullscreen === true,
      working: (): boolean => channel.working === true,
      /** Local rows titled after one report: one per push onto the bound session. */
      reportRows: (title: string): number => channel.rows.filter(row => row.text === title).length,
      turnStart: (): void => turnEvent(true),
      turnEnd: (): void => turnEvent(false),
      async enter(): Promise<void> {
        await sleep(100) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（提交命令那次 Enter 会刷新它）
        stdin.write('\r')
      },
      async escape(): Promise<void> {
        await sleep(100) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（提交命令那次 Enter 会刷新它）
        stdin.write('\x1b')
      },
      async done(): Promise<void> { instance.unmount(); channel.releaseContributions(); term.dispose() },
    }
  }

  // A first-party package whose declaration could not be read yet: gate 1 still
  // has something to say, gate 3 does not — so the pane shows the notice and no
  // trust confirmation, and Enter installs.
  {
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: a first-party package with an unreadable declaration asks before installing`,
        await settled(() => rig.hasText('Install plugin') && rig.hasText(`To install: ${PLUGIN}@${VERSION}`)), rig.screen())
      check(`${tag}: the pane carries gate 1's notice`,
        rig.hasText('cannot be read before it lands'), rig.screen())
      check(`${tag}: a first-party package is not asked to confirm trust`,
        !rig.hasText('full trust, no sandbox'), rig.screen())
      check(`${tag}: nothing installed before the answer`, rig.installs.length === 0, String(rig.installs.length))
      await rig.enter()
      check(`${tag}: Enter installs what the pane named`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
      check(`${tag}: the request id reaches the service`, rig.installs[0]?.requestId === 'probe-pane', JSON.stringify(rig.installs[0]))
      check(`${tag}: the pane is gone once the flow is done`, !rig.hasText('Install plugin'), rig.screen())
      // A finished install is not a cancelled one: the pane's own cleanup must
      // not ask the service to stop a request it already answered.
      check(`${tag}: a finished install never asks the service to cancel`,
        rig.cancels.length === 0 &&
        !rig.hasText(t('plugins-install-cancel-not-running')) &&
        !rig.hasText(t('plugins-install-cancelled')), `${rig.cancels.length} · ${rig.screen()}`)
    } finally {
      await rig.done()
    }
  }

  // A third-party package: the trust confirmation is the pane's reason to exist,
  // and Esc before answering installs nothing — Enter installs. Run in the three
  // layouts the screen has to survive: inline at 100 and 50 columns, and
  // fullscreen. The layout is the screen's, not just the host's: `chatFullscreen`
  // reads what Chat was handed, so a case tagged fullscreen cannot quietly test
  // an inline screen again (the pane's own frame is the same either way — what
  // `fullscreen` moves lives in the side panel and the whole-screen key paths,
  // both outside this overlay — so the wiring is the only proof there is).
  for (const [fullscreen, columns] of [[false, 100], [false, 50], [true, 100]] as const) {
    const layout = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
    const rig = await mountInstallChat({
      feed: noFeed,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
      columns,
      fullscreen,
    })
    try {
      check(`${tag} ${layout}: the screen was given the layout under test`,
        rig.chatFullscreen() === fullscreen, String(rig.chatFullscreen()))
      await rig.run('/plugin install verify-fresh-plugin')
      check(`${tag} ${layout}: an unlisted package is asked to confirm trust`,
        await settled(() => rig.hasText('Install plugin') && rig.hasText('full trust, no sandbox')), rig.screen())
      check(`${tag} ${layout}: the pane names the package it is about to install`,
        rig.hasText('To install:') && rig.hasText(PLUGIN), rig.screen())
      check(`${tag} ${layout}: the trust pane says the package will not auto-update`,
        rig.hasText('will not auto-update'), rig.screen())
      check(`${tag} ${layout}: the pane keeps its key hint on screen`,
        rig.hasText('esc cancel'), rig.screen())
      await rig.escape()
      check(`${tag} ${layout}: Esc on the confirmation closes the pane`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
      check(`${tag} ${layout}: Esc on the confirmation installs nothing`,
        rig.installs.length === 0, String(rig.installs.length))
      // The positive half in the same layout: the pane's Enter is what installs.
      await rig.run('/plugin install verify-fresh-plugin')
      check(`${tag} ${layout}: the pane comes back for the answer`,
        await settled(() => rig.hasText('Install plugin')), rig.screen())
      await rig.enter()
      check(`${tag} ${layout}: Enter installs what the pane named, in this layout`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
      check(`${tag} ${layout}: the install ran once, in this layout`,
        rig.installs.length === 1 && rig.installSpecs[0] === `${PLUGIN}@${VERSION}`,
        `${rig.installs.length} · ${JSON.stringify(rig.installSpecs)}`)
    } finally {
      await rig.done()
    }
  }

  // Esc while the install is in flight: the pane's busy branch is the seam that
  // hands the run to `cancelInstall`, and the answer is reported once.
  {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => {
        resolveInstall?.({ ...CHANGE, application: 'cancelled' })
        return Promise.resolve({ status: 'cancelled' })
      },
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: the install is in flight before Esc`, await settled(() => rig.installs.length === 1), rig.screen())
      await rig.escape()
      check(`${tag}: Esc mid-install asks the service to stop that request`,
        await settled(() => rig.cancels.length === 1 && rig.cancels[0] === 'probe-pane'), JSON.stringify(rig.cancels))
      check(`${tag}: the cancellation reads as one line`,
        await settled(() => rig.screen().includes(t('plugins-install-cancelled'))), rig.screen())
      check(`${tag}: the pane closes once the service confirms the cancellation`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // Two Escs, one rollback, at the screen level: the pane is the only place the
  // cancellation can be watched from, and it must stay until the service says
  // the profile is back — closing it early hands the prompt back over work that
  // is still going on.
  {
    let resolveCancel: ((value: PluginInstallCancellation) => void) | undefined
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => new Promise<PluginInstallCancellation>(resolve => { resolveCancel = resolve }),
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: the install is in flight before the first Esc`,
        await settled(() => rig.installs.length === 1), rig.screen())
      await rig.escape()
      check(`${tag}: the first Esc hands the run to the service`,
        await settled(() => rig.cancels.length === 1), JSON.stringify(rig.cancels))
      await rig.escape()
      // 固定窗:探针 断言「状态不得改变」：第二次 Esc 唯一被允许的效果就是等待，
      // 它没有可轮询的完成条件，所以只能等一个观察窗再断言面板仍在。断言紧贴
      // 按键读屏是假绿：错误基线上 `cancel()` 立刻 done，Chat 关面板、还输入，
      // 但那次关闭要经 React → 节流渲染（16ms 帧）→ xterm 异步解析才落到屏幕，
      // 立即读到的仍是关屏之前的旧帧——缺陷在断言眼下发生。窗口要覆盖那条链，
      // 250ms 约十五帧，慢 runner 上也不会读到旧屏幕。
      await sleep(250)
      check(`${tag}: a second Esc does not close the pane over the rollback`,
        rig.hasText('Install plugin') && rig.cancels.length === 1,
        `${JSON.stringify(rig.cancels)} · ${rig.screen()}`)
      resolveCancel?.({ status: 'cancelled' })
      resolveInstall?.({ ...CHANGE, application: 'cancelled' })
      check(`${tag}: the pane closes once the rollback is back`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // The applying phase cannot be cancelled. Its immediate too-late response
  // leaves the pane busy until the original install settles, in both layouts.
  for (const fullscreen of [false, true]) {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => Promise.resolve({ status: 'too-late' }),
      fullscreen,
      columns: 50,
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: applying is in flight before Esc (fullscreen=${fullscreen})`,
        await settled(() => rig.installs.length === 1), rig.screen())
      await rig.escape()
      // 固定窗:探针 the forbidden pane close must have time to render before
      // this negative assertion; reading the pre-Esc frame would pass falsely.
      await sleep(250)
      check(`${tag}: too-late keeps the narrow pane open (fullscreen=${fullscreen})`,
        rig.cancels.length === 1 && rig.hasText('Install plugin'), rig.screen())
      resolveInstall?.(CHANGE)
      check(`${tag}: the applying result closes the pane (fullscreen=${fullscreen})`,
        await settled(() => !rig.hasText('Install plugin') && rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
    } finally {
      resolveInstall?.(CHANGE)
      await rig.done()
    }
  }

  // Build scripts: the service blocks the install, the pane asks which ones to
  // allow, and Enter retries with exactly those.
  {
    let attempt = 0
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => {
        attempt += 1
        return Promise.resolve(attempt === 1
          ? { ...CHANGE, application: 'failed', pendingBuilds: ['esbuild'] }
          : CHANGE)
      },
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: blocked build scripts are asked about in the pane`,
        await settled(() => rig.hasText('These build scripts need approval') && rig.hasText('esbuild')), rig.screen())
      check(`${tag}: the pane names the scripts it will allow`,
        await settled(() => rig.hasText('allow these scripts and retry')), rig.screen())
      await rig.enter()
      check(`${tag}: Enter retries the install with those scripts approved`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
      check(`${tag}: the retry carries the approved build scripts`,
        rig.installs.length === 2 && JSON.stringify(rig.installs[1]?.approvedBuilds) === '["esbuild"]',
        JSON.stringify(rig.installs))
    } finally {
      await rig.done()
    }
  }

  // The approval is spent the moment the service takes it: it is written into
  // the profile before pnpm runs (and echoed back as `result.approvedBuilds`),
  // and a name that is no longer pending is refused as `stale-approval`. So a
  // component that turns out to be incompatible has to be risked with an
  // approval that already landed — offering it again would refuse the retry and
  // leave the install unfinishable. The fixture enforces the service's own rule,
  // so losing this cannot pass as a green retry.
  {
    const allowed = new Set<string>()
    let attempt = 0
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: settings => {
        attempt += 1
        const approved = settings.approvedBuilds ?? []
        if (approved.some(name => allowed.has(name))) {
          return Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'stale-approval' } })
        }
        for (const name of approved) allowed.add(name)
        if (attempt === 1) {
          return Promise.resolve({
            ...CHANGE,
            application: 'failed',
            error: { code: 'operation-error', diagnostic: 'Ignored build scripts: esbuild' },
            pendingBuilds: ['esbuild'],
          })
        }
        if (attempt === 2) {
          return Promise.resolve({
            ...CHANGE,
            application: 'failed',
            approvedBuilds: [...approved],
            error: {
              code: 'incompatible-version',
              incompatible: [{
                name: 'probe-component', version: '1.0.0', runtimeVersion: '0.2.0-rc.2',
                requirements: { 'engines.dsh': '>=99.0.0' },
              }],
            },
          })
        }
        return Promise.resolve(CHANGE)
      },
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: the blocked build scripts come first`,
        await settled(() => rig.hasText('These build scripts need approval')), rig.screen())
      await rig.enter()
      check(`${tag}: the approved scripts reach the service once`,
        await settled(() => rig.installs.length === 2 &&
          JSON.stringify(rig.installs[1]?.approvedBuilds) === '["esbuild"]'), JSON.stringify(rig.installs))
      check(`${tag}: an incompatible component is reported after the approval landed`,
        await settled(() => rig.hasText('Incompatible packages:') && rig.hasText('probe-component') && rig.hasText('engines.dsh >=99.0.0')), rig.screen())
      await rig.enter()
      check(`${tag}: the retry after a risk does not resubmit the spent approval`,
        await settled(() => rig.installs.length === 3 && rig.installs[2]?.approvedBuilds === undefined),
        JSON.stringify(rig.installs))
      check(`${tag}: the install finishes once the risk is accepted`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // A bare name that hits the feed is still asked about: the feed vouches for one
  // exact artifact, and a bare name means "latest" at install time.
  {
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}`)
      check(`${tag}: a bare name that hits the feed is confirmed, not trusted`,
        await settled(() => rig.hasText('Install plugin') && rig.hasText('full trust, no sandbox')), rig.screen())
      check(`${tag}: a bare name installs nothing before the answer`,
        rig.installs.length === 0, String(rig.installs.length))
      await rig.enter()
      check(`${tag}: confirming a bare name installs the exact version that was inspected`,
        await settled(() => rig.installSpecs[0] === `${PLUGIN}@${VERSION}`), JSON.stringify(rig.installSpecs))
    } finally {
      await rig.done()
    }
  }

  // Two flows, one pane: the first flow's late answer must not answer for the
  // second. It used to close B's pane and take B's cancellation with it.
  {
    let resolveA: ((inspection: PluginSpecInspection) => void) | undefined
    let resolveB: ((result: ChangeResult) => void) | undefined
    const acceptedB = {
      status: 'accepted', kind: 'registry', name: 'probe-b', version: '1.0.0',
      bundle: true, registry: null,
    } as const
    const rig = await mountInstallChat({
      feed: noFeed,
      notice: { kind: 'unjudged' },
      inspect: spec => spec === 'probe-a'
        ? new Promise<PluginSpecInspection>(resolve => { resolveA = resolve })
        : Promise.resolve(acceptedB),
      install: () => new Promise<ChangeResult>(resolve => { resolveB = resolve }),
      requestId: index => (index === 0 ? 'probe-race-a' : 'probe-race-b') as PluginInstallRequestId,
    })
    try {
      await rig.run('/plugin install probe-a')
      check(`${tag} race: the first inspection is still in flight`,
        await settled(() => rig.hasText('Installing')), rig.screen())
      await rig.escape()
      check(`${tag} race: Esc closes the flow that asked`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
      await rig.run('/plugin install probe-b')
      check(`${tag} race: the second flow asks its own question`,
        await settled(() => rig.hasText('To install: probe-b@1.0.0')), rig.screen())
      await rig.enter()
      check(`${tag} race: the second install is in flight`, await settled(() => rig.installs.length === 1), rig.screen())
      resolveA?.({ status: 'accepted', kind: 'registry', name: 'probe-a', version: '1.0.0', bundle: true, registry: null })
      // The late answer settles the first flow only: the second keeps its pane
      // (where its cancellation lives) and never touches A's request id.
      check(`${tag} race: a late answer from the first flow leaves the second alone`,
        await settled(() => rig.hasText('Installing') && rig.cancels.length === 0), rig.screen())
      await rig.escape()
      check(`${tag} race: the second flow is still cancellable, by its own id`,
        await settled(() => JSON.stringify(rig.cancels) === JSON.stringify(['probe-race-b'])), JSON.stringify(rig.cancels))
      resolveB?.({ ...CHANGE, application: 'cancelled' })
      check(`${tag} race: the cancelled install closes the pane`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // A running turn: the install reaches no service at all, and the same command
  // works once the turn is over.
  {
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
    })
    try {
      rig.turnStart()
      check(`${tag} working: the turn is running`, await settled(() => rig.working()), String(rig.working()))
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag} working: the refusal lands before any service call`,
        await settled(() => rig.hasText(t('plugins-install-busy')))
        && rig.inspections === 0 && rig.installs.length === 0,
        `${rig.inspections} · ${rig.installs.length} · ${rig.screen()}`)
      check(`${tag} working: no pane is left behind`, !rig.hasText('Install plugin'), rig.screen())
      // The gate belongs to the install subcommand alone: the read-only report
      // still answers while the turn runs.
      await rig.run('/plugin list')
      check(`${tag} working: the diagnostics command still reports`,
        await settled(() => rig.reportRows('/plugin') === 1), `${rig.reportRows('/plugin')} · ${rig.screen()}`)
      rig.turnEnd()
      check(`${tag} working: the turn is over`, await settled(() => !rig.working()), String(rig.working()))
      await sleep(150) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（上一条命令的 Enter 刷新了它）
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag} working: the same command asks once the turn is over`,
        await settled(() => rig.hasText(`To install: ${PLUGIN}@${VERSION}`)), rig.screen())
      await rig.enter()
      check(`${tag} working: and installs`, await settled(() => rig.installs.length === 1), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // The target is foreign text: a package manifest is a local file, so its name
  // can carry newlines, ANSI and thousands of cells. The confirmation must keep
  // its own title, target and key hint inside the viewport, and must not let the
  // name become rows of its own.
  {
    const hostile = `probe\nINJECTED-ROW\n\u001b[31mRED\u001b[0m-${'宽'.repeat(1200)}`
    for (const columns of [100, 50] as const) {
      const rig = makeHarness(columns, false)
      const app = await rig.render(React.createElement(PluginInstallPane, {
        busy: false,
        step: {
          kind: 'confirm',
          artifact: { name: hostile, version: '1.0.0', kind: 'path', bundle: null, registry: null },
          trust: { kind: 'third-party', reason: 'unverifiable-source' },
          notice: { kind: 'unjudged' },
        } as never,
      }))
      try {
        await sleep(300) // 固定窗:pacing 首帧渲染完再读屏（无头终端一次节流渲染的窗口）
        const lines = rig.screen().split('\n')
        check(`${tag} ${columns} columns: the confirmation keeps its title`,
          rig.hasText('Install plugin'), rig.screen())
        check(`${tag} ${columns} columns: the target and the key hint stay readable`,
          rig.hasText('To install: probe') && rig.hasText('esc cancel'), rig.screen())
        check(`${tag} ${columns} columns: a newline in the name cannot add a row of its own`,
          !lines.some(line => line.trim() === 'INJECTED-ROW'), rig.screen())
        check(`${tag} ${columns} columns: the target stays a bounded band of rows`,
          lines.filter(line => line.includes('宽')).length <= 3,
          `${lines.filter(line => line.includes('宽')).length} · ${rig.screen()}`)
      } finally {
        app.unmount()
        rig.term.dispose()
      }
    }
  }
}

// ── `/plugin remove | enable | disable` through the real Chat (C-5) ──────────
// The pane the lifecycle flow asks through. The flow is the real one; only the
// service and the clock's answers are fixtures. The three layouts are
// the screen's job to survive, and `chatFullscreen` reads what Chat was handed so
// a case tagged fullscreen cannot quietly test an inline screen again.
{
  const tag = 'manage pane'
  const APP = COMPOSITION_PACKAGE
  const HOST = HOST_BUNDLE
  const THIRD = 'probe-managed-plugin'
  const HOST_ROW_MODULE = '@deepseek-ai/dsh-host-webserver'
  const LEFTOVER = '/probe/home/.dsh-tui/backends/probe-backend'

  const PANE_BUNDLES: BundleInfo[] = [
    {
      name: HOST, version: '0.2.0-rc.2', enabled: true, installed: false, optional: false, removable: true,
      rows: [{ rowId: 'host-webserver', moduleName: HOST_ROW_MODULE }], overrides: ['tool-web'],
    },
    {
      name: THIRD, version: '1.0.0', enabled: false, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'third-row', moduleName: THIRD }], overrides: [],
    },
    // This application, addressable like any other bundle: the refusal below is
    // gate 2's, not the host's.
    {
      name: APP, version: '0.15.0', enabled: true, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'tui-row', moduleName: APP }, { rowId: 'tui-storage', moduleName: '@deepseek-ai/dsh-storage' }],
      overrides: [],
    },
  ]
  const PANE_PLUGINS: PluginInfo[] = [
    { entryId: 'entry-host' as PluginEntryId, moduleName: HOST_ROW_MODULE, enabled: true, patchId: 'host-webserver' },
    { entryId: 'entry-third' as PluginEntryId, moduleName: THIRD, enabled: false, patchId: 'third-row' },
    { entryId: 'entry-app' as PluginEntryId, moduleName: APP, enabled: true, patchId: 'tui-row' },
    { entryId: 'entry-storage' as PluginEntryId, moduleName: '@deepseek-ai/dsh-storage', enabled: true, patchId: 'tui-storage' },
  ]
  const CHANGE = { changed: true, application: 'applied', stage: 'remove', target: THIRD } as const

  /**
   * One Chat with the manage prop wired to a flow over the fixture service. The
   * prop is the shape the real entry has, so the path from a typed command to a
   * service call is the production one minus the profile.
   */
  async function mountManageChat(options: {
    /** What the Nth write answers; the fixture's appliable change by default. */
    readonly change?: (index: number) => Promise<ChangeResult>
    /**
     * The removal's leftover watch. Judged-and-clean by default, so a case that is
     * not about residue sees only the outcome it asked for; the real entry reads a
     * package here, which the production section below drives for real.
     */
    readonly residue?: (name: string) => PluginResidueWatch | undefined
    readonly columns?: number
    readonly fullscreen?: boolean
  } = {}) {
    const calls: string[] = []
    let writes = 0
    const service: PluginManagerView = {
      ...manager,
      listBundles: () => Promise.resolve(PANE_BUNDLES),
      listPlugins: () => Promise.resolve(PANE_PLUGINS),
      removeBundle: name => { calls.push(`removeBundle:${name}`); writes += 1; return options.change?.(writes - 1) ?? Promise.resolve(CHANGE) },
      setBundleEnabled: (name, enabled) => { calls.push(`setBundleEnabled:${name}:${String(enabled)}`); writes += 1; return options.change?.(writes - 1) ?? Promise.resolve(CHANGE) },
      setPluginEnabled: (id, enabled) => { calls.push(`setPluginEnabled:${String(id)}:${String(enabled)}`); writes += 1; return options.change?.(writes - 1) ?? Promise.resolve(CHANGE) },
    }
    const { term, stdin, screen, hasText, run, render } = makeHarness(options.columns ?? 100, options.fullscreen ?? false)
    const ctx = {
      on: () => () => undefined,
      get: (name: string) => name === 'pluginManager' ? service : undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    } as never
    const session = createDshSession(ctx, { agent: makeAgent('plugin-manage', 's-plugin-manage') as never })
    const channel = createChannel(ctx, session as never, {
      model: 'fake-model', provider: '', cwd: process.cwd(), activity: false,
    })
    const chatProps = {
      channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
      onExit: () => undefined, fullscreen: options.fullscreen ?? false, trajectorySeen: true,
      kernelEntries: kernelEntriesOf(listBackends()),
      onPluginManage: (args: string, sink: PluginManageSink) => {
        const parsed = parsePluginArgs(args)
        if (parsed.kind !== 'remove' && parsed.kind !== 'enable' && parsed.kind !== 'disable') return undefined
        if (parsed.target === '') return undefined
        return createPluginManageFlow({
          manager: service,
          action: parsed.kind,
          target: parsed.target,
          binding: sink.binding,
          busy: sink.busy,
          onLines: sink.onLines,
          profileName: 'probe-profile',
          residueOf: options.residue ?? (() => () => []),
        })
      },
    }
    const instance = await render(React.createElement(Chat, chatProps))
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    return {
      calls, screen, hasText, run, term,
      chatFullscreen: (): boolean => chatProps.fullscreen === true,
      /** 提交过的命令不会自己从输入行里消失：连着下一条命令前先清空（同 A 段）。 */
      clear: async (): Promise<void> => {
        for (let index = 0; index < 60; index += 1) stdin.write('\x7f')
        // 固定窗:pacing 退格要落在下一批按键之前。
        await sleep(60)
      },
      /** Local rows titled after one report: one per push onto the bound session. */
      reportRows: (title: string): number => channel.rows.filter(row => row.text === title).length,
      async enter(): Promise<void> {
        await sleep(100) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（提交命令那次 Enter 会刷新它）
        stdin.write('\r')
      },
      async escape(): Promise<void> {
        await sleep(100) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（提交命令那次 Enter 会刷新它）
        stdin.write('\x1b')
      },
      async done(): Promise<void> { instance.unmount(); channel.releaseContributions(); term.dispose() },
    }
  }

  for (const [fullscreen, columns] of [[false, 100], [false, 50], [true, 100]] as const) {
    const layout = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
    const rig = await mountManageChat({ columns, fullscreen })
    try {
      check(`${tag} ${layout}: the screen was given the layout under test`,
        rig.chatFullscreen() === fullscreen, String(rig.chatFullscreen()))
      await rig.run(`/plugin remove ${THIRD}`)
      check(`${tag} ${layout}: removing a bundle asks through the pane`,
        await settled(() => rig.hasText(t('plugins-manage-pane-title')) && rig.hasText(`About to ${t('plugins-manage-action-remove')}: ${THIRD}`)),
        rig.screen())
      check(`${tag} ${layout}: the pane says what a removal changes`,
        rig.hasText(t('plugins-manage-remove-facts', { rows: '1', overrides: '0' })), rig.screen())
      check(`${tag} ${layout}: the pane keeps its key hint on screen`,
        rig.hasText(t('plugins-manage-key-confirm')), rig.screen())
      check(`${tag} ${layout}: nothing was written before the answer`, rig.calls.length === 0, rig.calls.join(','))
      await rig.escape()
      check(`${tag} ${layout}: Esc on the confirmation closes the pane`,
        await settled(() => !rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
      check(`${tag} ${layout}: Esc on the confirmation writes nothing`, rig.calls.length === 0, rig.calls.join(','))
      // The positive half in the same layout: the pane's Enter is what writes.
      await rig.run(`/plugin remove ${THIRD}`)
      check(`${tag} ${layout}: the pane comes back for the answer`,
        await settled(() => rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
      await rig.enter()
      check(`${tag} ${layout}: Enter removes what the pane named, in this layout`,
        await settled(() => rig.hasText(t('plugins-manage-removed', { target: THIRD, state: t('plugins-install-state-applied') }))),
        rig.screen())
      check(`${tag} ${layout}: the removal ran once, and on the bundle name`,
        rig.calls.join(',') === `removeBundle:${THIRD}`, rig.calls.join(','))
      check(`${tag} ${layout}: the pane is gone once the flow is done`,
        await settled(() => !rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
      await rig.run(`/plugin enable ${THIRD}`)
      check(`${tag} ${layout}: enabling shows the source warning and confirmation keys`,
        await settled(() => rig.hasText(t('plugins-manage-trust-facts')) && rig.hasText(t('plugins-manage-key-confirm'))), rig.screen())
      check(`${tag} ${layout}: enabling writes nothing before confirmation`, rig.calls.length === 1, rig.calls.join(','))
      await rig.enter()
      check(`${tag} ${layout}: confirmation enables exactly the named bundle`,
        await settled(() => rig.calls.join(',') === `removeBundle:${THIRD},setBundleEnabled:${THIRD}:true` &&
          !rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // Esc while the write is in flight: unlike an installation there is no
  // cancellation to hand over, so the pane just closes and the profile write
  // finishes on its own — and the answer still lands in the transcript.
  {
    let resolveWrite: ((result: ChangeResult) => void) | undefined
    const rig = await mountManageChat({
      change: () => new Promise<ChangeResult>(resolve => { resolveWrite = resolve }),
    })
    try {
      await rig.run(`/plugin remove ${THIRD}`)
      await rig.enter()
      check(`${tag}: the write is in flight before Esc`,
        await settled(() => rig.calls.length === 1 && rig.hasText(t('plugins-manage-working'))), rig.screen())
      check(`${tag}: the busy pane says what Esc will and will not do`,
        rig.hasText(t('plugins-manage-key-busy')), rig.screen())
      await rig.escape()
      check(`${tag}: Esc mid-write closes the pane, and asks the service for nothing`,
        await settled(() => !rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
      resolveWrite?.({ ...CHANGE })
      check(`${tag}: the write that outlived the pane still reports itself`,
        await settled(() => rig.hasText(t('plugins-manage-removed', { target: THIRD, state: t('plugins-install-state-applied') }))),
        rig.screen())
      check(`${tag}: nothing asked the service to cancel a write it cannot cancel`,
        rig.calls.join(',') === `removeBundle:${THIRD}`, rig.calls.join(','))
    } finally {
      await rig.done()
    }
  }

  // The fence at the screen level: the first flow's answer must not close the pane
  // a second flow opened. The two are told apart by identity, not by order.
  {
    let resolveFirst: ((result: ChangeResult) => void) | undefined
    const rig = await mountManageChat({
      change: index => index === 0
        ? new Promise<ChangeResult>(resolve => { resolveFirst = resolve })
        : Promise.resolve(CHANGE),
    })
    try {
      await rig.run(`/plugin remove ${THIRD}`)
      await rig.enter()
      check(`${tag}: the first write is in flight`,
        await settled(() => rig.calls.length === 1), rig.calls.join(','))
      await rig.escape()
      await settled(() => !rig.hasText(t('plugins-manage-pane-title')))
      // A third-party `enable` asks, so the second flow has a pane of its own to
      // lose: `disable` of the same bundle would write straight through and leave
      // nothing to protect.
      await rig.run(`/plugin enable ${THIRD}`)
      check(`${tag}: the second flow opens its own pane`,
        await settled(() => rig.hasText(t('plugins-manage-pane-title')) &&
          rig.hasText(`About to ${t('plugins-manage-action-enable')}: ${THIRD}@1.0.0`)), rig.screen())
      const pushes = rig.reportRows('/plugin')
      resolveFirst?.({ ...CHANGE })
      // 固定窗:探针 断言的是「这个迟到的回答不许改变当前这个面板」——没有可等的完成条件
      await sleep(200)
      check(`${tag}: the first flow's late answer leaves the second pane, and its question, alone`,
        rig.hasText(t('plugins-manage-pane-title')) &&
        rig.hasText(`About to ${t('plugins-manage-action-enable')}: ${THIRD}@1.0.0`) &&
        !rig.hasText(`About to ${t('plugins-manage-action-remove')}: ${THIRD}`), rig.screen())
      // Counted on the channel, not read off the screen: the transcript is the
      // whole scrollback, and the landing page plus the open pane push the older
      // lines past the viewport (they are there, just not in these 40 rows).
      check(`${tag}: …while its own outcome still reaches the transcript`,
        rig.reportRows('/plugin') === pushes + 1 &&
        findText(rig.term, THIRD) !== null, `${pushes} → ${rig.reportRows('/plugin')}`)
      await rig.enter()
      check(`${tag}: the second flow's own answer writes what it asked for`,
        await settled(() => rig.calls.join(',') === `removeBundle:${THIRD},setBundleEnabled:${THIRD}:true`), rig.calls.join(','))
    } finally {
      await rig.done()
    }
  }

  // A refusal has no pane to open: the line is the whole answer, and the screen
  // must stay usable — no overlay left behind to swallow the next command.
  {
    const rig = await mountManageChat()
    try {
      await rig.run(`/plugin disable ${APP}`)
      check(`${tag}: gate 2's refusal is a transcript line, not a pane`,
        await settled(() => rig.hasText(t('plugins-manage-refused-app-bundle', { target: APP })) &&
          !rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
      check(`${tag}: the refusal wrote nothing`, rig.calls.length === 0, rig.calls.join(','))
      await rig.clear()
      await rig.run(`/plugin remove ${APP}`)
      check(`${tag}: the next command still works after a refusal`,
        await settled(() => rig.hasText(t('plugins-manage-refused-app-bundle', { target: APP }))), rig.screen())
      await rig.clear()
      await rig.run('/plugin disable @deepseek-ai/dsh-storage')
      check(`${tag}: this application's own first-party-module row is refused the same way`,
        await settled(() => rig.hasText(t('plugins-manage-refused-app-row', { target: '@deepseek-ai/dsh-storage' })) &&
          !rig.hasText(t('plugins-manage-pane-title'))), rig.screen())
      check(`${tag}: …and that refusal wrote nothing either`, rig.calls.length === 0, rig.calls.join(','))
    } finally {
      await rig.done()
    }
  }

  // Decision D at the screen: what a removal leaves behind is reported in the
  // transcript once, and nothing is deleted for the person.
  {
    const rig = await mountManageChat({ residue: () => () => [LEFTOVER] })
    try {
      await rig.run(`/plugin remove ${THIRD}`)
      await rig.enter()
      check(`${tag}: a removal that left data behind says so in the transcript`,
        await settled(() => rig.hasText(t('plugins-manage-residue', { paths: LEFTOVER }))), rig.screen())
    } finally {
      await rig.done()
    }
  }
}

// ── The production wiring, driven for real (C-4) ─────────────────────────────
// Everything above hands the flow a fixture feed and a fixture notice. This
// section drives `createPluginInstallEntry` — the function the entry itself
// passes to Chat — so the parts that only exist in the wiring are covered too:
// the packaged feed as shipped, gate 1's declaration read from the target
// directory, and the path forms the service accepts for a `install <path>` spec.
{
  const tag = 'install entry'
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
  const acceptedRegistry = {
    status: 'accepted', kind: 'registry', name: manifest.name, version: manifest.version,
    bundle: true, registry: null,
  } as const

  function entryCtx(options: { readonly manager?: boolean; readonly baseUrl?: string } = {}) {
    const service: PluginManagerView = {
      ...manager,
      // The real service's own contract, which a fixture has to obey or it proves
      // nothing: an absolute path — bare, or behind pnpm's `file:` / `link:` — is
      // read from the directory, a relative one is refused as `invalid-spec`
      // before anything reads it, and anything else is a registry name.
      inspect: (spec: string) => {
        const path = spec.replace(/^(?:file|link):/u, '')
        if (path.startsWith('/')) {
          return Promise.resolve(path.endsWith('.tgz')
            ? { status: 'accepted', kind: 'tarball', bundle: null, registry: null } as const
            : { status: 'accepted', kind: 'path', name: manifest.name, version: manifest.version, bundle: true, registry: null } as const)
        }
        if (path.startsWith('.')) {
          return Promise.resolve({ status: 'refused', problem: 'invalid-spec', reason: 'a local path must be absolute' } as const)
        }
        return Promise.resolve(acceptedRegistry)
      },
      installBundle: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'install', target: manifest.name }),
      listBundles: () => Promise.resolve([]),
    }
    return {
      on: () => () => undefined,
      get: (name: string) => name === 'pluginManager' && options.manager !== false ? service : undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
      ...options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
    } as never
  }
  const sink = { binding: () => 0, busy: () => false, onLines: () => undefined }

  // No service: the entry hands back no flow, and the screen falls back to the
  // report (which is where the CLI route is printed).
  const noService = createPluginInstallEntry(entryCtx({ manager: false }), { profileName: 'probe', ownVersion: manifest.version })
  check(`${tag}: with no plugin service the entry offers no flow`,
    noService('install verify-fresh-plugin', sink) === undefined)
  check(`${tag}: an argument that is not an install form offers no flow`,
    createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })('list', sink) === undefined)
  check(`${tag}: a bare install offers no flow (the report answers its usage)`,
    createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })('install', sink) === undefined)

  // The real wiring, the real packaged feed, and this very package's own pin: the
  // feed vouches for the exact version the spec names (first-party) while the
  // declaration is unreadable before the install, so gate 1 still asks.
  const own = createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })(
    `install ${manifest.name}@${manifest.version}`, sink)
  check(`${tag}: the entry builds a flow for an install form`, own !== undefined)
  if (own !== undefined) {
    const step = await own.begin()
    check(`${tag}: the shipped feed vouches for the package it pins (read through the real loader)`,
      step.kind === 'confirm' && step.trust.kind === 'first-party' && step.trust.entry.name === manifest.name,
      JSON.stringify(step))
    check(`${tag}: gate 1 still asks when the declaration cannot be read yet`,
      step.kind === 'confirm' && step.notice.kind === 'unjudged', JSON.stringify(step))
    own.dispose()
  }

  // The same name without a version is a different question: "latest" is not the
  // artifact the feed pinned (`tui-profile/feed/README.md`), even though the
  // registry resolves it to the pinned version right now.
  {
    const bare = createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })(
      `install ${manifest.name}`, sink)
    const step = await bare?.begin()
    check(`${tag}: a bare name never earns the feed's trust, whatever it resolves to`,
      step?.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'version-mismatch',
      JSON.stringify(step))
    bare?.dispose()
  }

  // Gate 1 reads the target's own directory and nothing else: an old same-name
  // package the profile can resolve must not answer for a new target, and the
  // target's own declaration must be read when it has one.
  {
    const root = mkdtempSync(join(tmpdir(), 'dsh-install-shadow-'))
    const profile = join(root, 'profile')
    const target = join(root, 'new-target')
    const old = join(root, 'node_modules', '@probe', 'same-name')
    for (const dir of [profile, target, old]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'probe-profile', dependencies: {} }))
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@probe/same-name', version: '2.0.0', dsh: { bundle: {} } }))
    writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@probe/same-name', version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(old, 'dsh-plugin.json'), '{bad-old-declaration')
    const factory = createPluginInstallEntry(
      entryCtx({ baseUrl: pathToFileURL(`${profile}/`).href }),
      { profileName: 'probe', ownVersion: manifest.version },
    )
    const shadowed = factory(`install ${target}`, sink)
    const step = await shadowed?.begin()
    check(`${tag}: an old same-name package does not answer for a new target`,
      step?.kind === 'confirm' && step.notice.kind === 'undeclared', JSON.stringify(step))
    shadowed?.dispose()
    // …and the evidence is the target's own file when there is one.
    writeFileSync(join(target, 'dsh-plugin.json'), '{not-a-declaration-either')
    const declared = factory(`install ${target}`, sink)
    const declaredStep = await declared?.begin()
    check(`${tag}: the target's own declaration is the one that is judged`,
      declaredStep?.kind === 'confirm' && declaredStep.notice.kind === 'invalid', JSON.stringify(declaredStep))
    declared?.dispose()
  }

  // A `install <path>` spec in each form the service accepts: a bare absolute
  // path, and pnpm's `file:` / `link:` spellings of the same directory. They must
  // be judged alike — a prefix used to lose the declaration evidence behind it —
  // and a relative one is refused before any of this, so it never reaches here.
  {
    const root = mkdtempSync(join(tmpdir(), 'dsh-install-entry-'))
    const directory = join(root, 'probe-plugin-dir')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(root, 'probe.plugin.tgz'), '')
    const factory = createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })

    for (const [label, spec] of [
      ['a bare absolute path', directory],
      ['a file: path', `file:${directory}`],
      ['a link: path', `link:${directory}`],
    ] as const) {
      const flow = factory(`install ${spec}`, sink)
      const step = await flow?.begin()
      check(`${tag}: ${label} is judged undeclared`,
        step?.kind === 'confirm' && step.notice.kind === 'undeclared', JSON.stringify(step))
      check(`${tag}: ${label} is never first-party, whatever its manifest claims`,
        step?.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'unverifiable-source',
        JSON.stringify(step))
      flow?.dispose()
    }

    const tarball = factory(`install ${join(root, 'probe.plugin.tgz')}`, sink)
    const fileStep = await tarball?.begin()
    check(`${tag}: a spec that is not a directory stays unjudged, never "declares nothing"`,
      fileStep?.kind === 'confirm' && fileStep.notice.kind === 'unjudged', JSON.stringify(fileStep))
    tarball?.dispose()
    const missing = factory(`install ${join(root, 'no-such-directory')}`, sink)
    check(`${tag}: a spec for a directory that is not there is unjudged too`,
      (await missing?.begin())?.kind === 'confirm', 'expected a decision, not a silent install')
    missing?.dispose()
    for (const relative of ['./probe-plugin-dir', 'file:./probe-plugin-dir', 'link:./probe-plugin-dir']) {
      const flow = factory(`install ${relative}`, sink)
      check(`${tag}: ${relative} is refused as the service refuses it, not resolved here`,
        (await flow?.begin())?.kind === 'done', 'a relative path is `invalid-spec` upstream')
      flow?.dispose()
    }
  }
}

// ── The lifecycle wiring, driven for real (C-5) ──────────────────────────────
// Everything above hands the manage flow a fixture service and a fixture watch. This
// section drives `createPluginManageEntry` and `residueWatchOf` — the two functions
// the entry itself uses — so the parts that only exist in the wiring are covered:
// the argument forms, source uncertainty, and the declaration read that
// names a removed plugin's own data.
{
  const tag = 'manage entry'
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
  const DECLARATION: unknown = JSON.parse(readFileSync(new URL('../tui-profile/conformance/fixtures/valid-backend-contribution.json', import.meta.url), 'utf8'))
  const COMPONENT_ID = 'com.example.backend-plugin'
  const BACKEND_ID = 'example-agent'
  const ROW_ENTRY = 'probe-row-entry'
  const calls: string[] = []
  /**
   * The version the profile reports for this application. The feed pins the one the
   * package publishes, so a case that wants "we publish this name, but not this
   * artifact" moves this and names the same bundle again.
   */
  let ownBundleVersion = manifest.version
  /** The profile these cases act on: this application, one plugin bundle, one row. */
  const PROBE_SERVICE: PluginManagerView = {
    ...manager,
    listBundles: () => Promise.resolve([
      {
        name: manifest.name, version: ownBundleVersion, enabled: true, installed: true, optional: false, removable: true,
        rows: [{ rowId: 'tui-row', moduleName: manifest.name }], overrides: [],
      },
      {
        name: '@probe/managed-plugin', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true,
        rows: [{ rowId: 'managed-row', moduleName: '@probe/managed-plugin' }], overrides: [],
      },
    ]),
    listPlugins: () => Promise.resolve([
      { entryId: ROW_ENTRY as PluginEntryId, moduleName: '@probe/managed-plugin', enabled: true, patchId: 'managed-row' },
    ]),
    removeBundle: name => { calls.push(`removeBundle:${name}`); return Promise.resolve({ changed: true, application: 'applied', stage: 'remove', target: name }) },
    setBundleEnabled: (name, enabled) => { calls.push(`setBundleEnabled:${name}:${String(enabled)}`); return Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: name, enabled }) },
    setPluginEnabled: (id, enabled) => { calls.push(`setPluginEnabled:${String(id)}:${String(enabled)}`); return Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: String(id), enabled }) },
  }
  const sink = { binding: () => 0, busy: () => false, onLines: () => undefined }

  /** A profile whose install tree holds one declared plugin package. */
  function probeProfile(declaration: unknown | undefined, service: PluginManagerView = PROBE_SERVICE): { readonly ctx: never; readonly name: string; readonly root: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-manage-entry-'))
    const profile = join(root, 'profile')
    const installed = join(profile, 'node_modules', '@probe', 'managed-plugin')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'probe-profile', dependencies: {} }))
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@probe/managed-plugin', version: '1.0.0', dsh: { bundle: {} } }))
    if (declaration !== undefined) writeFileSync(join(installed, 'dsh-plugin.json'), JSON.stringify(declaration))
    return {
      root,
      name: '@probe/managed-plugin',
      ctx: {
        on: () => () => undefined,
        get: (name: string) => name === 'pluginManager' ? service : undefined,
        logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
        baseUrl: pathToFileURL(`${profile}/`).href,
      } as never,
    }
  }

  {
    // No service: the entry hands back no flow, and the screen falls back to the
    // report — which is where the CLI route for each form is printed.
    const bare = {
      on: () => () => undefined, get: () => undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    } as never
    const noService = createPluginManageEntry(bare, { profileName: 'probe' })
    check(`${tag}: with no plugin service the entry offers no flow`,
      noService('remove probe-managed-plugin', sink) === undefined)
  }

  {
    const { ctx } = probeProfile(DECLARATION)
    const factory = createPluginManageEntry(ctx, { profileName: 'probe' })
    for (const args of ['list', 'info probe-managed-plugin', 'install probe-managed-plugin', 'registries', 'check /tmp/x.json']) {
      check(`${tag}: "${args}" is not a lifecycle form, so the entry offers no flow`,
        factory(args, sink) === undefined)
    }
    // A bare form is a usage error the report answers; a flow here would write
    // nothing and say nothing.
    for (const sub of ['remove', 'enable', 'disable']) {
      check(`${tag}: a bare "${sub}" offers no flow (the report answers its usage)`,
        factory(sub, sink) === undefined)
      const flow = factory(`${sub} ${manifest.name}@${manifest.version}`, sink)
      check(`${tag}: "${sub}" with a target does build a flow`, flow !== undefined)
      flow?.dispose()
    }
  }

  // Even this application's exact feed identity carries no installation source.
  {
    const { ctx } = probeProfile(DECLARATION)
    calls.length = 0
    const flow = createPluginManageEntry(ctx, { profileName: 'probe' })(`enable ${manifest.name}`, sink)
    const step = await flow?.begin()
    check(`${tag}: the shipped feed's exact identity cannot bypass enable confirmation`,
      step?.kind === 'confirm' && step.question.kind === 'trust' && calls.length === 0, JSON.stringify(step))
    flow?.dispose()
    // The same bundle, with the profile reporting a version the feed does not pin:
    // "we publish this name" is not "we published this artifact" (`feed/README.md`).
    ownBundleVersion = '0.0.1'
    const stale = createPluginManageEntry(ctx, { profileName: 'probe' })(`enable ${manifest.name}`, sink)
    const staleStep = await stale?.begin()
    check(`${tag}: the same name at another version is asked about, not trusted`,
      staleStep?.kind === 'confirm' && staleStep.question.kind === 'trust', JSON.stringify(staleStep))
    stale?.dispose()
    ownBundleVersion = manifest.version
  }

  // Which identity the argument names: a bundle name is matched before any row, so
  // a name both of them carry cannot quietly become the smaller action.
  {
    const { ctx, name } = probeProfile(DECLARATION)
    const flow = createPluginManageEntry(ctx, { profileName: 'probe' })(`remove ${name}`, sink)
    const step = await flow?.begin()
    check(`${tag}: a name the profile holds as a bundle resolves to the bundle`,
      step?.kind === 'confirm' && step.target.kind === 'bundle' && step.target.rows === 1,
      JSON.stringify(step))
    flow?.dispose()
    // The same name as a row identity: the row's module is the same string, and the
    // bundle still wins — which is why the report prints entry ids too.
    calls.length = 0
    const asRow = createPluginManageEntry(ctx, { profileName: 'probe' })(`disable ${ROW_ENTRY}`, sink)
    const rowStep = await asRow?.begin()
    check(`${tag}: an entry id reaches the row the bundle name would have shadowed`,
      rowStep?.kind === 'done' && calls.join(',') === `setPluginEnabled:${ROW_ENTRY}:false`,
      `${JSON.stringify(rowStep)} · ${calls.join(',')}`)
    asRow?.dispose()
  }

  // What a removal leaves behind, read through the real reader: the declaration
  // names the plugin's identity and its backends' data directories, and both are
  // looked for where they would actually be.
  {
    const { ctx, name } = probeProfile(DECLARATION)
    const dataRoot = join(mkdtempSync(join(tmpdir(), 'dsh-manage-data-')), 'data')
    const watch = residueWatchOf(ctx, name, dataRoot)
    check(`${tag}: a declared plugin's removal is watched`, watch !== undefined)
    check(`${tag}: a removal that left nothing reports nothing`, watch?.().length === 0, JSON.stringify(watch?.()))

    // The backend's own directory, at the path the host builds for it.
    const backendDir = backendDataDir(BACKEND_ID, dataRoot)
    mkdirSync(backendDir, { recursive: true })
    check(`${tag}: a backend's data directory is found where the host would have written it`,
      watch?.().join(',') === backendDir, JSON.stringify(watch?.()))

    // …and the plugin's own footprint, through the same three sources the grant
    // matrix unions.
    rmSync(backendDir, { recursive: true, force: true })
    writeFileSync(join(dataRoot, 'effect-ledger.jsonl'),
      `${JSON.stringify({ sequence: 1, operation: 'create', pluginId: COMPONENT_ID, resource: { kind: 'storage-namespace', id: 'probe' }, result: 'applied' })}\n`)
    check(`${tag}: a plugin's ledger footprint is found without its data directory`,
      watch?.().length === 1 && watch?.()[0]?.includes(COMPONENT_ID) === true, JSON.stringify(watch?.()))

    // A bundle that ships no declaration is not evidence of a clean removal: the
    // question is unanswerable, and the flow says so rather than "nothing left".
    const undeclared = probeProfile(undefined)
    check(`${tag}: a bundle that declares nothing has no watch to hand the flow`,
      residueWatchOf(undeclared.ctx, undeclared.name, dataRoot) === undefined)
    // A declaration that names no identity either: nothing to look for, and no
    // directory invented from a contribution of another family.
    const empty = probeProfile({ id: '', contributes: { 'x-dsh-tui': [{ kind: 'Panel', id: BACKEND_ID }] } })
    check(`${tag}: a declaration that names no plugin identity has no watch either`,
      residueWatchOf(empty.ctx, empty.name, dataRoot) === undefined)
    const other = probeProfile({ id: COMPONENT_ID, contributes: { 'x-dsh-tui': [{ kind: 'Panel', id: BACKEND_ID }] } })
    mkdirSync(backendDataDir(BACKEND_ID, dataRoot), { recursive: true })
    check(`${tag}: a non-Backend contribution never names a backend data directory`,
      residueWatchOf(other.ctx, other.name, dataRoot)?.().every(path => path !== backendDataDir(BACKEND_ID, dataRoot)) === true,
      JSON.stringify(residueWatchOf(other.ctx, other.name, dataRoot)?.()))
    for (const spec of [undefined, { id: '../escape' }]) {
      const invalid = probeProfile({ id: '', contributes: { 'x-dsh-tui': [{ kind: 'Backend', id: BACKEND_ID, spec }] } })
      check(`${tag}: an invalid Backend spec never invents a data directory`,
        residueWatchOf(invalid.ctx, invalid.name, dataRoot) === undefined)
    }
  }

  // Drive the production entry across the removal itself: the declaration is
  // gone when the write finishes, and the leftover appears during that write.
  {
    const leftover = backendDataDir(BACKEND_ID)
    const service: PluginManagerView = {
      ...PROBE_SERVICE,
      removeBundle: name => {
        rmSync(join(profile.root, 'profile', 'node_modules', '@probe', 'managed-plugin'), { recursive: true })
        mkdirSync(leftover, { recursive: true })
        return Promise.resolve({ changed: true, application: 'applied', stage: 'remove', target: name })
      },
    }
    const profile = probeProfile(DECLARATION, service)
    const lines: string[] = []
    const flow = createPluginManageEntry(profile.ctx)(`remove ${profile.name}`, {
      ...sink, onLines: batch => { lines.push(...batch) },
    })
    try {
      check(`${tag}: removal waits for confirmation before touching the package`,
        (await flow?.begin())?.kind === 'confirm' && residueWatchOf(profile.ctx, profile.name) !== undefined)
      await flow?.confirm()
      check(`${tag}: removal reports data left after its declaration became unreadable`,
        residueWatchOf(profile.ctx, profile.name) === undefined &&
        lines.includes(t('plugins-manage-residue', { paths: leftover })) &&
        !lines.includes(t('plugins-manage-residue-unjudged', { target: profile.name })), lines.join(' | '))
    } finally {
      flow?.dispose()
      rmSync(leftover, { recursive: true, force: true })
      rmSync(profile.root, { recursive: true, force: true })
    }
  }
}

// ── Both async reports are fenced to the session that asked for them ───────
// `pluginsInfo` (async since C-3) and `listSubagents` answer through `pushLocal`,
// which writes whichever session is bound NOW: a report that lands after a
// `/new` or a resume would appear in the new session's transcript without the
// generation guard in Chat.
{
  const tag = 'session fence'
  const { term, stdin, screen, type, run, render } = makeHarness(100, false)
  /** A service call the test can park and then release. */
  interface Gate<T> {
    setHold(on: boolean): void
    call(): Promise<T>
    readonly waiting: number
    releaseAll(): void
  }
  function makeGate<T>(answer: T): Gate<T> {
    let hold = false
    const parked: Array<(value: T) => void> = []
    return {
      setHold: (on: boolean): void => { hold = on },
      call: (): Promise<T> => hold ? new Promise<T>(resolve => { parked.push(resolve) }) : Promise.resolve(answer),
      get waiting(): number { return parked.length },
      /** Release every parked answer — the report's is among them. */
      releaseAll: (): void => { while (parked.length > 0) parked.pop()?.(answer) },
    }
  }
  const bundleGate = makeGate(bundles)
  const childGate = makeGate([] as Array<{ mode: string; label?: string; activity: string; id: string }>)
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const slowManager: PluginManagerView = { ...manager, listBundles: bundleGate.call }
  provide('pluginManager', slowManager)
  provide('subagents', { listChildren: childGate.call })
  // `/new` needs the agents service; each handle's agent becomes the new session.
  let created = 0
  provide('agents', {
    get: () => undefined,
    create: () => {
      created += 1
      return Promise.resolve({
        agent: { ...makeAgent(`after-${created}`, `s-after-${created}`), options: {}, cancel() {}, whenIdle: () => Promise.resolve() },
        dispose: () => Promise.resolve(),
      })
    },
  })
  const channel = createChannel(ctx as never, makeAgent('before', 's-before') as never, {
    model: 'fake-model', provider: '', cwd: process.cwd(), activity: false,
  })
  const instance = await render(React.createElement(Chat, {
    channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
    onExit: () => undefined, fullscreen: false, trajectorySeen: true,
    kernelEntries: kernelEntriesOf(listBackends()),
  }))
  /** Local rows titled after one report: one per push onto the bound session. */
  const reports = (title: string): number => channel.rows.filter(row => row.text === title).length

  /** Positive control first (the same rig does push the report when nothing is
   *  held), then a `/new` between the ask and the answer. */
  const fenced = async (
    fenceTag: string,
    command: string,
    title: string,
    gate: Gate<unknown>,
  ): Promise<void> => {
    await run(command)
    check(`${fenceTag}: the report lands on the session that asked for it`,
      await settled(() => reports(title) === 1), `${reports(title)} · ${screen()}`)

    // Type first, hold after: a completion warm this keystroke run may trigger
    // is answered normally, so what gets parked is the report's own call.
    await type(command)
    gate.setHold(true)
    stdin.write('\r')
    await settle(() => gate.waiting >= 1)
    check(`${fenceTag}: the report is in flight`, gate.waiting >= 1, String(gate.waiting))

    const generation = channel.agentBindingGeneration
    check(`${fenceTag}: /new rebinds the channel`,
      (await channel.newSession()) === true && channel.agentBindingGeneration !== generation,
      `${generation} -> ${channel.agentBindingGeneration}`)
    check(`${fenceTag}: the new session starts without the old report`, reports(title) === 0, String(reports(title)))

    gate.releaseAll()
    // The whole late-answer chain is microtasks — no timers — so one macrotask
    // boundary is enough to know the guard has run (no fixed window).
    await tick()
    check(`${fenceTag}: nothing was left unanswered`, gate.waiting === 0, String(gate.waiting))
    check(`${fenceTag}: an answer that lands after the switch stays out of the new session`,
      reports(title) === 0, channel.rows.map(row => row.text).join(' | '))
  }

  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    await fenced(`${tag} /plugin`, '/plugin list', '/plugin', bundleGate)
    await fenced(`${tag} /agents`, '/agents', '/agents', childGate)
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}
console.log(`verify-plugin-manager-chat OK (${passed} checks)`)
