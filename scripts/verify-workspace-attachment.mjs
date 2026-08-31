/**
 * Regression check for durable Workspace ownership of TUI-created Sessions.
 *
 * Run after build:
 *   pnpm build && node scripts/verify-workspace-attachment.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { attachSessionToWorkspace } from '../lib/types/dsh-adapter/workspace.js'

const existingCalls = []
const existingWorkspace = {
  async attachSession(sessionId) {
    existingCalls.push(['attach', sessionId])
  },
}
const existingRegistry = {
  async resolveByPath(cwd) {
    existingCalls.push(['resolve', cwd])
    return existingWorkspace
  },
  async create() {
    throw new Error('existing workspace must not be recreated')
  },
}
assert.equal(
  await attachSessionToWorkspace(
    { get: key => key === 'workspaceRegistry' ? existingRegistry : undefined },
    '/work/existing',
    'session-existing',
  ),
  true,
)
assert.deepEqual(existingCalls, [
  ['resolve', '/work/existing'],
  ['attach', 'session-existing'],
])

const createCalls = []
const createdWorkspace = {
  async attachSession(sessionId) {
    createCalls.push(['attach', sessionId])
  },
}
const creatingRegistry = {
  async resolveByPath(cwd) {
    createCalls.push(['resolve', cwd])
    return undefined
  },
  async create(cwd) {
    createCalls.push(['create', cwd])
    return createdWorkspace
  },
}
assert.equal(
  await attachSessionToWorkspace(
    { get: key => key === 'workspaceRegistry' ? creatingRegistry : undefined },
    '/work/new',
    'session-new',
  ),
  true,
)
assert.deepEqual(createCalls, [
  ['resolve', '/work/new'],
  ['create', '/work/new'],
  ['attach', 'session-new'],
])

assert.equal(
  await attachSessionToWorkspace({ get: () => undefined }, '/work/bare', 'session-bare'),
  false,
)

// Exercise the real four-plugin stack used by the profile patch. The Session
// is live (the same state immediately after agents.create), so attachSession
// validates its immutable header and persists the Workspace account.
const actualRoot = mkdtempSync(join(tmpdir(), 'dsh-tui-workspace-'))
const actualCwd = join(actualRoot, 'project')
mkdirSync(actualCwd)
const actualHeader = {
  id: 'session-actual',
  cwd: actualCwd,
  createdAt: Date.now(),
}
const actualCtx = new Context()
const disposers = []
const rememberDisposer = value => {
  if (typeof value === 'function') disposers.push(value)
}
try {
  rememberDisposer(await actualCtx.plugin(Storage))
  rememberDisposer(await actualCtx.plugin(StorageJson, { root: join(actualRoot, 'storages') }))
  rememberDisposer(await actualCtx.plugin(StorageDomain, { backend: 'json' }))
  rememberDisposer(actualCtx.provide('sessionPersistence', {
    async list() { return [] },
  }))
  rememberDisposer(actualCtx.provide('sessions', {
    get: id => id === actualHeader.id ? { header: actualHeader } : undefined,
    list: () => [{ header: actualHeader }],
  }))
  rememberDisposer(await actualCtx.plugin(WorkspaceRegistry))

  assert.equal(
    await attachSessionToWorkspace(actualCtx, actualCwd, actualHeader.id),
    true,
  )
  const actualWorkspace = await actualCtx.workspaceRegistry.resolveByPath(actualCwd)
  assert.deepEqual(actualWorkspace?.sessionIds, [actualHeader.id])
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  rmSync(actualRoot, { recursive: true, force: true })
}

const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
const channel = readFileSync(new URL('../src/dsh-adapter/channel.ts', import.meta.url), 'utf8')
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(
  plugin,
  /await attachSessionToWorkspace\(ctx, meta\.cwd, agent\.session\.id\)/,
  'startup attaches both newly-created and resumed sessions',
)
assert.doesNotMatch(plugin, /if \(created\)/, 'startup attachment must not skip resumed legacy sessions')
assert.equal(
  [...channel.matchAll(/await attachSessionToWorkspace\(ctx, (?:state\.cwd|handle\.agent\.session\.header\.cwd \?\? state\.cwd|sourceCwd), (?:SessionId\(sessionId\)|childId|sessionId)\)/g)].length,
  9,
  'rewind, /resume, /new, model-switch, tree rewindToNode, /fork, and agent-view (adopt/background/attach) paths all attach ownership',
)
for (const id of ['storage', 'storage-json', 'storage-domain', 'workspace']) {
  assert.match(patch, new RegExp(`- id: dsh-tui-${id}\\n`), `profile patch mounts scoped dsh-tui-${id}`)
  assert.match(
    patch,
    new RegExp(`dsh-tui-${id}[\\s\\S]{0,260}entry\\.options\\.id === '${id}'`),
    `scoped dsh-tui-${id} yields to the official ${id} row`,
  )
}
assert.match(patch, /root: !!js dshHomePath\('storages'\)/)
assert.match(
  patch,
  /- id: dsh-tui\n\s+name: '@deepseek-harness-tui\/dsh-tui'\n[\s\S]{0,240}inject: \[[^\]]*\bworkspaceRegistry\b[^\]]*\]/,
  'profile waits for WorkspaceRegistry before the TUI creates its startup session',
)

console.log('verify-workspace-attachment: OK')
