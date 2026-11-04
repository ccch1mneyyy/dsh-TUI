/**
 * Agent-creation and resume failure diagnostics for a Host service whose row is
 * disabled (issue #1842). Covers the pure helper, the profile-resolution branch
 * it runs in production, the localized one-line hint, and the plugin.ts wiring —
 * a removed or line-commented call, a dropped diagnostic on either boot path, or
 * a hint that stops riding `StartupOpenError` must turn this red, like
 * scripts/verify-crash-detail.ts. A live oracle also reads the installed
 * upstream package: rewording its "requires … in the Host scope" sentence turns
 * this red instead of silently disabling the diagnostic.
 * Run after build: node scripts/verify-host-service-diagnostics.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { Divider } from '../lib/types/components/design-system/Divider.js'
import {
  describeMissingHostService,
  installedVersion,
  packageNameOf,
} from '../lib/types/dsh-adapter/host-service-diagnostics.js'
import { i18nDict, setLang, t } from '../lib/types/i18n.js'
import { TerminalSizeContext } from '../lib/types/ink/components/TerminalSizeContext.js'
import { renderToScreen } from '../lib/types/ink/render-to-screen.js'
import { cellAt } from '../lib/types/ink/screen.js'
import { Box } from '../lib/types/ui.js'

const TARGET = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
const PACKAGE = '@deepseek-ai/dsh-tool-subagent'
const MESSAGE = 'tool-subagent (@deepseek-ai/dsh-tool-subagent): tool-subagent: `modelSelectionSettings` '
  + `requires ${TARGET} in the Host scope`
const ROW = { disabled: true, options: { id: 'dsh-tui-subagent-model-selection-settings', name: TARGET } }

// The trigger is an upstream English sentence, so keep a live oracle beside the
// hand-written fixture: a rewording that no longer matches the helper's regex
// must turn this red instead of silently disabling the diagnostic (#1842).
let upstream
try {
  upstream = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tool-subagent')
} catch {
  assert.fail('@deepseek-ai/dsh-tool-subagent is not installed; the live oracle needs the devDependency')
}
const upstreamMatch = /requires (\S+) in the Host scope/u.exec(readFileSync(upstream, 'utf8'))
assert.ok(upstreamMatch !== null,
  'the installed @deepseek-ai/dsh-tool-subagent no longer says "requires … in the Host scope"')
assert.equal(upstreamMatch[1], TARGET)

function context(rows, baseUrl) {
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    get: (name) => (name === 'loader' ? { entries: () => rows } : undefined),
  }
}

function liveLine(source, needle, label) {
  const line = source.split('\n').find((candidate) => candidate.includes(needle))
  assert.ok(line !== undefined, `${label}: the call is gone`)
  const trimmed = line.trimStart()
  assert.ok(!trimmed.startsWith('//') && !trimmed.startsWith('/*'), `${label}: the call is commented out`)
  return line
}

// The hint lands on a `notice` row, which MessageList renders as
// `<Box marginTop={1}><Divider title={` ${text} `} /></Box>`: one truncated line.
// Render that shape for real, so a hint that only reads well as a string cannot
// pass by ignoring where the Divider cuts it.
function noticeRow(text, columns, rows = 40) {
  const element = React.createElement(
    TerminalSizeContext.Provider,
    { value: { columns, rows } },
    React.createElement(Box, { marginTop: 1 }, React.createElement(Divider, { title: ` ${text} ` })),
  )
  const { screen, height } = renderToScreen(element, columns)
  for (let row = 0; row < height; row += 1) {
    const line = Array.from({ length: columns }, (_, col) => cellAt(screen, col, row)?.char ?? '').join('').trimEnd()
    if (line.length > 0) return line
  }
  return ''
}

// The recovery hint is a localized string on a later line of the same block, so
// anchoring on the call keeps the create and resume paths apart (both call sites
// end up with identical hint expressions).
function hintAfter(source, anchorNeedle, label) {
  const lines = source.split('\n')
  const anchor = lines.findIndex((line) => line.includes(anchorNeedle))
  assert.ok(anchor >= 0, `${label}: the call is gone`)
  const block = lines.slice(anchor, anchor + 20)
  const hint = block.find((line) => line.includes('startup-host-row-disabled-hint'))
  assert.ok(hint !== undefined, `${label}: the localized recovery hint is gone`)
  assert.ok(!hint.trimStart().startsWith('//'), `${label}: the recovery hint is commented out`)
  assert.ok(block.some((line) => line.includes('new StartupOpenError(')),
    `${label}: the hint must ride StartupOpenError, not have nowhere to land`)
  return hint
}

// A profile fixture at a version the repo's own devDependency does not have, so
// a fallback to import.meta.url cannot satisfy the assertion below. The second
// package hides `./package.json` behind an exports map, which `require.resolve`
// cannot see but `findPackageJSON` can.
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-host-service-'))
const profile = join(root, 'node_modules', PACKAGE)
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: PACKAGE, version: '0.2.1-fixture' }))
const hidden = join(root, 'node_modules', '@fixture', 'hidden')
mkdirSync(hidden, { recursive: true })
writeFileSync(join(hidden, 'package.json'), JSON.stringify({
  name: '@fixture/hidden', version: '9.9.9', exports: { '.': './index.js' },
}))
const profileBase = pathToFileURL(join(root, 'entry.js')).href

try {
  const repoVersion = installedVersion(context([]), PACKAGE)
  assert.equal(typeof repoVersion, 'string', 'repo dev dependency must resolve')
  assert.equal(installedVersion(context([], profileBase), '@fixture/hidden'), '9.9.9',
    'a package that hides ./package.json must still report its version')

  // One Loader pass per diagnosis: reading `disabled` re-evaluates the row's
  // `!!js` expression, so a second pass would run user profile code twice.
  let loaderReads = 0
  let entriesCalls = 0
  let disabledReads = 0
  const countedRow = { options: { id: 'counted-row', name: TARGET } }
  Object.defineProperty(countedRow, 'disabled', { get() { disabledReads += 1; return true } })
  const counted = {
    get: (name) => {
      if (name !== 'loader') return undefined
      loaderReads += 1
      return { entries: () => { entriesCalls += 1; return [countedRow] } }
    },
  }
  assert.ok(describeMissingHostService(counted, MESSAGE) !== undefined)
  assert.equal(loaderReads, 1, 'the loader service is resolved once per diagnosis')
  assert.equal(entriesCalls, 1, 'the loader tree is walked once per diagnosis')
  assert.equal(disabledReads, 1, 'the row condition is evaluated once per diagnosis')

  // Disabled provider: facts only, each cause with its own remedy.
  const found = describeMissingHostService(context([ROW]), MESSAGE)
  assert.ok(found !== undefined, 'a disabled provider must be explained')
  const hint = found.detail
  assert.match(hint, /"dsh-tui-subagent-model-selection-settings"/)
  assert.ok(hint.includes(`"${TARGET}"`), 'the missing specifier stays quoted')
  assert.ok(hint.includes(`${PACKAGE}@${repoVersion} is installed there`), 'the resolved version is named')
  assert.match(hint, /Align .* with the running dsh first/, 'version alignment is the primary fix')
  assert.match(hint, /If dsh's compatibility gate disabled it/)
  assert.match(hint, /re-enabling the row alone will be rejected again/,
    'the gate branch must not offer re-enabling as a working fix')
  assert.match(hint, /If the profile disabled the row itself, re-enable it only once/,
    're-enabling is conditional on the row condition no longer failing')
  assert.doesNotMatch(hint, /dsh disables rows whose declared runtime requirements/u,
    'the gate is a possibility, never the asserted cause')
  assert.match(hint, /upgrade dsh if the installed plugin is newer/)
  assert.equal(found.packageName, PACKAGE, 'the caller aligns the owning package, not the subpath')

  // Two rows can share one specifier (the patch row and the official row); both
  // must be named, or the user is sent to the wrong one.
  const both = describeMissingHostService(context([
    { disabled: true, options: { id: 'official-row', name: TARGET } },
    { disabled: true, options: { id: 'dsh-tui-subagent-model-selection-settings', name: TARGET } },
  ]), MESSAGE)?.detail
  assert.ok(both !== undefined)
  assert.match(both, /the Host rows "dsh-tui-subagent-model-selection-settings", "official-row"/,
    'every disabled row sharing the specifier is named, in a stable order')

  // The profile's own resolution wins over the repo's copy.
  const fromProfile = describeMissingHostService(context([ROW], profileBase), MESSAGE)?.detail
  assert.ok(fromProfile !== undefined)
  assert.ok(fromProfile.includes(`${PACKAGE}@0.2.1-fixture is installed there`),
    'ctx.baseUrl must be the resolution base')

  // A row the profile disabled itself reads the same; the gate stays conditional.
  const manual = describeMissingHostService(
    context([{ disabled: true, options: { id: 'custom-row', name: TARGET } }]), MESSAGE)?.detail
  assert.ok(manual !== undefined)
  assert.ok(manual.includes('the Host row "custom-row"'))
  assert.doesNotMatch(manual, /dsh disables rows whose declared runtime requirements/u)
  assert.match(manual, /re-enable it only once the condition its row checks no longer fails/)

  // An unreadable version must not claim an installation.
  const absent = describeMissingHostService(
    context([{ disabled: true, options: { id: 'absent-row', name: '@example/absent/service' } }], profileBase),
    'tool: `x` requires @example/absent/service in the Host scope',
  )?.detail
  assert.ok(absent !== undefined)
  assert.match(absent, /Its installed version could not be read/)
  assert.doesNotMatch(absent, /is installed there/u)

  // A mounted provider means the service exists; the failure has another cause.
  assert.equal(describeMissingHostService(context([
    { disabled: true, options: { id: 'stale', name: TARGET } },
    { disabled: false, options: { id: 'current', name: TARGET } },
  ]), MESSAGE), undefined)

  // Entry.disabled evaluates `!!js` expressions; a throwing one must not replace
  // the original failure with its own exception.
  const throwing = { options: { id: 'boom', name: TARGET } }
  Object.defineProperty(throwing, 'disabled', { get() { throw new Error('bad disabled expression') } })
  assert.equal(describeMissingHostService(context([throwing]), MESSAGE), undefined,
    'a throwing disabled expression must pass through, never throw')

  // Unrelated failures pass through untouched.
  assert.equal(describeMissingHostService(context([]), 'dsh-tui: boom'), undefined)
  assert.equal(describeMissingHostService(context([]), MESSAGE), undefined)
  assert.equal(describeMissingHostService({ get: () => undefined }, MESSAGE), undefined)

  // A row without an id names the specifier instead of printing undefined.
  const noId = describeMissingHostService(
    context([{ disabled: true, options: { name: '@example/absent/service' } }]),
    'tool: `x` requires @example/absent/service in the Host scope',
  )?.detail
  assert.ok(noId !== undefined)
  assert.ok(!noId.includes('undefined'))
  assert.ok(noId.includes('the Host row for "@example/absent/service"'))

  // An unnamed row beside a named one must not be listed as a second row: the
  // specifier would appear once as a row name and once in parentheses.
  const mixed = describeMissingHostService(
    context([
      { disabled: true, options: { name: '@example/absent/service' } },
      { disabled: true, options: { id: 'official-row', name: '@example/absent/service' } },
    ]),
    'tool: `x` requires @example/absent/service in the Host scope',
  )?.detail
  assert.ok(mixed !== undefined)
  assert.ok(mixed.includes('the Host row "official-row" ("@example/absent/service") is disabled'),
    'only the named row is listed when another row has no id')
  assert.ok(!mixed.includes('the Host rows "@example/absent/service"'))

  // The notice row renders its own localized hint, not the English long text: it
  // replaces the channel's /new retry · /kernel · /quit line, so dropping those
  // exits or shipping English to zh users is a visible regression. Assert the
  // rendered row instead of the dictionary string: the notice Divider truncates
  // to the terminal width, and the package name is the only unbounded part, so
  // the exits must come first and survive every width.
  const hintEntry = i18nDict['startup-host-row-disabled-hint']
  assert.ok(hintEntry?.zh !== undefined && hintEntry.en !== undefined,
    'the hint key must carry both languages')
  // A real plugin specifier can outrun any fixture (45 cells here): once it does,
  // the package is cut and only the exits are still assertable.
  const LONG_PACKAGE = '@deepseek-harness-tui/dsh-tui-subagent-plugin'
  for (const lang of ['zh', 'en']) {
    setLang(lang)
    for (const pkg of [PACKAGE, LONG_PACKAGE]) {
      const text = t('startup-host-row-disabled-hint', { pkg })
      assert.ok(text.includes(pkg), `${lang}: the hint names the package to align`)
      // 76 content cells = an 80-column terminal under the default `normal`
      // page margin (2 columns each side); 56 = 60 columns; 36 = 40 columns,
      // the narrowest supported window. Narrower rows trade the package for the
      // exits by design, and the detail's first line is truncated from the right
      // too, so only the widest row asserts the package whole.
      for (const columns of [76, 56, 36]) {
        const row = noticeRow(text, columns)
        assert.ok(row.includes('/kernel'), `${lang}@${columns}/${pkg}: /kernel stays visible`)
        assert.ok(row.includes('/quit'), `${lang}@${columns}/${pkg}: /quit stays visible`)
        if (pkg === PACKAGE && columns === 76) {
          assert.ok(row.includes(PACKAGE), `${lang}@${columns}: the package survives the divider`)
        }
      }
    }
  }

  // The first notice row carries the English detail; it is what #1842 sees in
  // the TUI. Assert the rendered prefix at the default widths so a rewording
  // that buries the row name behind the notice prefix turns red — the hint row
  // alone would not catch it.
  const detailFirstLine = found.detail.split('\n')[0]
  for (const columns of [76, 56]) {
    const row = noticeRow(t('startup-open-failed', { backend: 'DSH', err: detailFirstLine }), columns)
    assert.ok(row.includes('dsh-tui: the Host row'), `${columns}: the detail keeps its opening`)
  }

  assert.equal(packageNameOf('@a/b/c'), '@a/b')
  assert.equal(packageNameOf('plain'), 'plain')
  assert.equal(packageNameOf('plain/sub'), 'plain')

  // Wiring tripwires: the helper only matters while plugin.ts still calls it on
  // both boot paths (`agents.create` and `agents.resume`), keeps the diagnostic
  // on the thrown error, and carries the localized hint on StartupOpenError.
  // Each needle is unique to its path — a shared `${hostService}` needle
  // silently re-tested the resume line.
  const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  liveLine(plugin, 'describeMissingHostService(ctx, message)', 'agent-creation path')
  liveLine(plugin, '${hostService.detail}\\n${failure}',
    'agent-creation error append (the diagnostic precedes the cause: the /new toast shows only the first line)')
  hintAfter(plugin, 'describeMissingHostService(ctx, message)', 'agent-creation recovery hint')
  liveLine(plugin, 'describeMissingHostService(ctx, reason)', 'resume path')
  liveLine(plugin, '${hostService.detail}\\ndsh-tui: cannot resume session', 'resume error append')
  hintAfter(plugin, 'describeMissingHostService(ctx, reason)', 'resume recovery hint')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('verify-host-service-diagnostics: ok')
