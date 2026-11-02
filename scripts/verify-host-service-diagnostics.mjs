/**
 * Agent-creation and resume failure diagnostics for a Host service whose row is
 * disabled (issue #1842). Covers the pure helper, the profile-resolution branch
 * it runs in production, and the plugin.ts wiring — a removed or commented-out
 * call, or a dropped diagnostic on either boot path, must turn this red, like
 * scripts/verify-crash-detail.ts.
 * Run after build: node scripts/verify-host-service-diagnostics.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  describeMissingHostService,
  installedVersion,
  packageNameOf,
} from '../lib/types/dsh-adapter/host-service-diagnostics.js'

const TARGET = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
const PACKAGE = '@deepseek-ai/dsh-tool-subagent'
const MESSAGE = 'tool-subagent (@deepseek-ai/dsh-tool-subagent): tool-subagent: `modelSelectionSettings` '
  + `requires ${TARGET} in the Host scope`
const ROW = { disabled: true, options: { id: 'dsh-tui-subagent-model-selection-settings', name: TARGET } }

function context(rows, baseUrl) {
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    get: (name) => (name === 'loader' ? { entries: () => rows } : undefined),
  }
}

function liveLine(source, needle, label) {
  const line = source.split('\n').find((candidate) => candidate.includes(needle))
  assert.ok(line !== undefined, `${label}: the call is gone`)
  assert.ok(!line.trimStart().startsWith('//'), `${label}: the call is commented out`)
  return line
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

  // Disabled provider: facts only, each cause with its own remedy.
  const hint = describeMissingHostService(context([ROW]), MESSAGE)
  assert.ok(hint !== undefined, 'a disabled provider must be explained')
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

  // Two rows can share one specifier (the patch row and the official row); both
  // must be named, or the user is sent to the wrong one.
  const both = describeMissingHostService(context([
    { disabled: true, options: { id: 'official-row', name: TARGET } },
    { disabled: true, options: { id: 'dsh-tui-subagent-model-selection-settings', name: TARGET } },
  ]), MESSAGE)
  assert.ok(both !== undefined)
  assert.match(both, /the Host rows "dsh-tui-subagent-model-selection-settings", "official-row"/,
    'every disabled row sharing the specifier is named, in a stable order')

  // The profile's own resolution wins over the repo's copy.
  const fromProfile = describeMissingHostService(context([ROW], profileBase), MESSAGE)
  assert.ok(fromProfile !== undefined)
  assert.ok(fromProfile.includes(`${PACKAGE}@0.2.1-fixture is installed there`),
    'ctx.baseUrl must be the resolution base')

  // A row the profile disabled itself reads the same; the gate stays conditional.
  const manual = describeMissingHostService(
    context([{ disabled: true, options: { id: 'custom-row', name: TARGET } }]), MESSAGE)
  assert.ok(manual !== undefined)
  assert.ok(manual.includes('the Host row "custom-row"'))
  assert.doesNotMatch(manual, /dsh disables rows whose declared runtime requirements/u)
  assert.match(manual, /re-enable it only once the condition its row checks no longer fails/)

  // An unreadable version must not claim an installation.
  const absent = describeMissingHostService(
    context([{ disabled: true, options: { id: 'absent-row', name: '@example/absent/service' } }], profileBase),
    'tool: `x` requires @example/absent/service in the Host scope',
  )
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
  )
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
  )
  assert.ok(mixed !== undefined)
  assert.ok(mixed.includes('the Host row "official-row" ("@example/absent/service") is disabled'),
    'only the named row is listed when another row has no id')
  assert.ok(!mixed.includes('the Host rows "@example/absent/service"'))

  assert.equal(packageNameOf('@a/b/c'), '@a/b')
  assert.equal(packageNameOf('plain'), 'plain')
  assert.equal(packageNameOf('plain/sub'), 'plain')

  // Wiring tripwires: the helper only matters while plugin.ts still calls it on
  // both boot paths (`agents.create` and `agents.resume`) and keeps the
  // diagnostic on the thrown error. Each needle is unique to its path — a
  // shared `${hostService}` needle silently re-tested the resume line.
  const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  liveLine(plugin, 'describeMissingHostService(ctx, message)', 'agent-creation path')
  const createAppend = liveLine(plugin, 'hostService === undefined ? failure :', 'agent-creation error append')
  assert.ok(createAppend.includes('${hostService}\\n${failure}'),
    'the create diagnostic must precede the cause: the /new toast shows only the first line')
  liveLine(plugin, 'describeMissingHostService(ctx, reason)', 'resume path')
  liveLine(plugin, '${reason}\\n${hostService}', 'resume error append')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('verify-host-service-diagnostics: ok')
