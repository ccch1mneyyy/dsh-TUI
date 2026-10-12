/**
 * SDK installation in real Chat: two installable backends, mouse dismissal,
 * cancellation during preflight/install, and stale results after reopening.
 * Install actions are fixtures and never run a package manager.
 * Run: node --import tsx/esm scripts/verify-sdk-install-chat.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import type { SdkInstallResult } from '../src/agent/backend.js'
import type { AgentSession } from '../src/agent/session.js'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { kernelEntriesOf }, { listBackends, registerBackend }, { findText, settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('../src/components/kernelCatalog.js'),
  import('../src/dsh-adapter/backend-registry.js'),
  import('./lib/term-test.mjs'),
])

setLang('en')
const recipes = [
  { id: 'install-alpha', label: 'Install Alpha', version: '8.8.8', specifier: '@verify/alpha@8.8.8', dir: '/tmp/sdk-alpha' },
  { id: 'install-beta', label: 'Install Beta', version: '9.9.9', specifier: '@verify/beta@9.9.9', dir: '/tmp/sdk-beta' },
] as const
for (const recipe of recipes) registerBackend({ manifest: {
  id: recipe.id,
  label: { kind: 'literal', text: recipe.label },
  shortLabel: recipe.label,
  inTree: false,
  install: { executor: 'pnpm-profile-add', specifier: recipe.specifier, version: recipe.version },
} })

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

for (const fullscreen of [false, true]) for (const columns of [100, 50]) {
  const tag = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
  const term = new XTerm({ cols: columns, rows: 40, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = 40
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
  const session: AgentSession = {
    ref: { backendId: 'claude', sessionId: '55555555-5555-4555-8555-555555555555' },
    cwd: process.cwd(), status: 'idle', capabilities: { native: {} },
    history: () => Promise.resolve([]), subscribe: () => () => undefined,
    submit: () => Promise.resolve({ accepted: true }),
    cancel: () => Promise.resolve({ stillQueued: [], outcome: 'confirmed' }), dispose: () => Promise.resolve(),
  }
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false })
  const preflights: { id: string; resolve: (ok: boolean) => void }[] = []
  const starts: { id: string; dir: string; specifier: string; resolve: (result: SdkInstallResult) => void }[] = []
  const cancelled: string[] = []
  const screen = () => viewportLines(term).join('\n')
  const hasText = (text: string) => screen().replaceAll(/\s+/gu, '').includes(text.replaceAll(/\s+/gu, ''))
  const node = React.createElement(Chat, {
    channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
    onExit: () => undefined, fullscreen, trajectorySeen: true, launchpadOnBoot: true,
    kernelEntries: kernelEntriesOf(listBackends()),
    onProbeKernels: () => Promise.resolve(Object.fromEntries(recipes.map(recipe => [recipe.id, { installed: false }]))),
    onResolveSdkInstall: id => {
      const recipe = recipes.find(recipe => recipe.id === id)
      return recipe === undefined ? undefined : {
        executor: 'pnpm-profile-add', specifier: recipe.specifier, version: recipe.version,
        resolveTarget: () => ({ kind: 'profile', dir: recipe.dir }),
        preflight: () => new Promise<boolean>(resolve => { preflights.push({ id, resolve }) }),
        start: dir => ({
          result: new Promise<SdkInstallResult>(resolve => { starts.push({ id, dir, specifier: recipe.specifier, resolve }) }),
          cancel: () => { cancelled.push(id) },
        }),
      }
    },
  })
  const instance = await ui.render(fullscreen ? <ui.AlternateScreen mouseTracking>{node}</ui.AlternateScreen> : node, {
    stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never,
    exitOnCtrlC: false, patchConsole: false,
  })
  const click = (cell: { col: number; row: number }): void => {
    stdin.write(`\x1b[<0;${cell.col + 1};${cell.row + 1}M\x1b[<0;${cell.col + 1};${cell.row + 1}m`)
  }
  const open = async (recipe: typeof recipes[number]): Promise<void> => {
    // The kernel corner remains clickable when narrow layouts hide action buttons.
    check(`${tag}: current kernel visible`, await settled(() => findText(term, '▸ Claude') !== null), screen())
    click(findText(term, '▸ Claude')!)
    check(`${tag}: picker contains ${recipe.id}`, await settled(() => screen().includes(t('kernel-picker-title')) && findText(term, recipe.label) !== null), screen())
    click(findText(term, recipe.label)!)
    check(`${tag}: ${recipe.id} resolves its own target`, await settled(() => screen().includes(recipe.version) && screen().includes(recipe.dir)), screen())
  }
  const confirm = async (): Promise<void> => {
    await sleep(100) // 固定窗:pacing modal Enter has an 80ms debounce after opening.
    stdin.write('\r')
    check(`${tag}: preflight panel opened`, await settled(() => screen().includes(t('sdk-install-checking'))), screen())
  }
  try {
    await sleep(300) // 固定窗:pacing attach keyboard handlers after the first frame.
    check(`${tag}: launchpad ready`, await settled(() => findText(term, '╭') !== null), screen())
    const blank = findText(term, '╭')!
    await open(recipes[0])
    click(blank)
    check(`${tag}: blank click closes confirmation`, await settled(() => !screen().includes(t('sdk-install-title'))), screen())
    await open(recipes[1])
    await confirm()
    const stalePreflight = preflights.at(-1)!
    click(blank)
    check(`${tag}: blank click closes preflight`, await settled(() => !screen().includes(t('sdk-install-title'))), screen())
    await open(recipes[0])
    stalePreflight.resolve(true)
    await sleep(120) // 固定窗:探针 a closed wizard's late preflight must not start an install.
    check(`${tag}: late preflight does not start either backend`, starts.length === 0 && screen().includes(recipes[0].version), screen())
    await confirm()
    preflights.at(-1)!.resolve(true)
    check(`${tag}: Alpha starts with its own recipe`, await settled(() => starts.length === 1)
      && starts[0]!.id === recipes[0].id && starts[0]!.dir === recipes[0].dir && starts[0]!.specifier === recipes[0].specifier, JSON.stringify(starts))
    click(blank)
    check(`${tag}: blank click cancels running install`, await settled(() => cancelled.join() === recipes[0].id && !screen().includes(t('sdk-install-title'))), screen())
    await open(recipes[1])
    starts[0]!.resolve({ kind: 'ok' })
    await sleep(120) // 固定窗:探针 a cancelled install's late result must not overwrite Beta's confirmation.
    check(`${tag}: late install result leaves Beta untouched`, screen().includes(recipes[1].version) && !hasText(t('sdk-install-done')), screen())
    await confirm()
    preflights.at(-1)!.resolve(true)
    check(`${tag}: Beta starts with its own recipe`, await settled(() => starts.length === 2)
      && starts[1]!.id === recipes[1].id && starts[1]!.dir === recipes[1].dir && starts[1]!.specifier === recipes[1].specifier, JSON.stringify(starts))
    starts[1]!.resolve({ kind: 'ok' })
    check(`${tag}: Beta completion is shown`, await settled(() => hasText(t('sdk-install-done'))), screen())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}
console.log(`verify-sdk-install-chat OK (${passed} checks)`)
