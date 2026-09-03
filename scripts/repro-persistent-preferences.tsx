/**
 * Regression for persisted runtime preferences: a fresh channel must apply
 * the saved effort and permission preset, while a live permission event must
 * update the saved preset for the next fresh session.
 *
 * Run with: node --import tsx/esm scripts/repro-persistent-preferences.tsx
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { sleep } from './lib/term-test.mjs'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtui-prefs-home-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

try {
  const [{ createChannel }, { writeEffortPref }, { readPermissionPref, writePermissionPref }] = await Promise.all([
    import('../src/dsh-adapter/channel.js'),
    import('../src/effortPrefs.js'),
    import('../src/permissionPrefs.js'),
  ])
  const prefsDir = join(isolatedHome, '.dsh-tui')
  writeEffortPref('high', prefsDir)
  writePermissionPref('confirm', prefsDir)

  const root = new Context()
  const llm = new LlmRuntime(root)
  const efforts = [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  llm.registerAdapter(['deepseek-official'], {
    /** Provide the minimum adapter identity needed by the channel fixture. */
    providerInfo(provider: string) { return { id: provider, name: 'DeepSeek' } },
    /** Keep retries out of this deterministic preference regression. */
    providerRetryPolicy() { return undefined },
    /** Advertise the same effort levels as the production DeepSeek adapter. */
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning: { efforts, defaultEffort: 'max' } }
    },
    /** The test never sends a real model request. */
    async *stream(): AsyncGenerator<never> { throw new Error('not exercised') },
  } as never)

  let selectedPermission = 'workspace-write'
  let permissionSetCalls = 0
  const permissionPresets = {
    names: ['workspace-write', 'confirm'],
    /** Return the live selection used by the fake registry service. */
    current() { return selectedPermission },
    /** Return a minimal picker option for each advertised preset. */
    optionOf(name: string) { return { value: name, name } },
    /** Mirror the host setter by recording the durable preset event. */
    set(session: { events: unknown[] }, name: string) {
      selectedPermission = name
      permissionSetCalls += 1
      session.events.push({ type: 'permission/preset', data: { preset: name } })
    },
  }
  root.provide('permissionPresets', permissionPresets)

  const agentCtx = root.extend()
  const session = { id: 'fresh-session', seq: 0, events: [], header: { id: 'fresh-session', cwd: '/tmp' } }
  const agent = {
    id: 'fresh-session',
    status: 'idle',
    options: {},
    ctx: agentCtx,
    session,
    followup() {},
    steer() {},
    inbox: { remove() {} },
  } as never

  const channel = createChannel(root as never, agent, {
    model: 'deepseek-v4-flash',
    cwd: '/tmp',
    provider: 'deepseek-official',
    activity: false,
    freshSession: true,
  })
  if (selectedPermission !== 'confirm' || permissionSetCalls !== 1) {
    throw new Error(`persisted permission was not applied: ${selectedPermission} (${permissionSetCalls})`)
  }
  if (channel.reasoningEffort !== 'high') {
    throw new Error(`persisted effort was not seeded: ${String(channel.reasoningEffort)}`)
  }

  // Let applyPreferredEffort install the request-selection waterfall, then
  // prove the first fresh request receives the saved level.
  await sleep(50)
  const assembly = { variables: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
  await (agentCtx as Context).waterfall(
    'system-prompt/assemble' as never,
    assembly,
    {},
    () => Promise.resolve(assembly),
  )
  const proposed = await (agentCtx as Context).waterfall(
    'agent/request' as never,
    { turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  ) as { reasoningEffort?: string }
  if (proposed.reasoningEffort !== 'high') {
    throw new Error(`persisted effort did not reach request config: ${String(proposed.reasoningEffort)}`)
  }

  // A subsequent user-selected preset is the preference for the next fresh
  // session; this event path is the same path used by /permission.
  const nextEvent = { type: 'permission/preset', data: { preset: 'workspace-write' } }
  session.events.push(nextEvent)
  ;(root as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', session, nextEvent)
  if (readPermissionPref(prefsDir) !== 'workspace-write') {
    throw new Error('live permission selection was not persisted')
  }

  // Agent View creates fresh sessions without going through /new. Both
  // background entry points must receive the same saved permission before
  // their first prompt or binding, even when the TUI started elsewhere.
  writePermissionPref('confirm', prefsDir)
  let backgroundFollowups = 0
  const backgroundSessions: Array<{ events: Array<{ data?: { preset?: string } }> }> = []
  const backgroundAgents = {
    async create({ sessionId }: { sessionId: string }) {
      const backgroundSession = {
        id: sessionId,
        seq: 0,
        events: [],
        header: { id: sessionId, cwd: '/tmp' },
      }
      const backgroundAgent = {
        id: sessionId,
        status: 'idle',
        options: {},
        ctx: agentCtx,
        session: backgroundSession,
        followup() { backgroundFollowups += 1 },
        steer() {},
        inbox: { remove() {} },
      }
      backgroundSessions.push(backgroundSession)
      return { agent: backgroundAgent, dispose() {} }
    },
  }
  root.provide('agents', backgroundAgents)
  const dispatched = await channel.dispatchBackgroundAgent('background prompt')
  if (!dispatched.ok || backgroundFollowups !== 1 || backgroundSessions[0]?.events[0]?.data?.preset !== 'confirm') {
    throw new Error(`background dispatch failed: ${JSON.stringify(dispatched)}`)
  }
  const backgrounded = await channel.backgroundCurrent()
  if (!backgrounded.ok || backgroundSessions[1]?.events[0]?.data?.preset !== 'confirm') {
    throw new Error(`backgroundCurrent failed: ${JSON.stringify(backgrounded)}`)
  }

  // A resumed session has its own durable effort and permission facts. The
  // global preferences intentionally conflict with those facts here; a
  // resume must not call the fresh-session permission setter or replace the
  // effort reported by the session's request header.
  writePermissionPref('confirm', prefsDir)
  const resumedRoot = new Context()
  const resumedLlm = new LlmRuntime(resumedRoot)
  resumedLlm.registerAdapter(['deepseek-official'], {
    /** Provide the minimum adapter identity needed by the resume fixture. */
    providerInfo(provider: string) { return { id: provider, name: 'DeepSeek' } },
    /** Keep retries out of this deterministic resume regression. */
    providerRetryPolicy() { return undefined },
    /** Advertise the same effort levels as the production adapter. */
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning: { efforts, defaultEffort: 'max' } }
    },
    /** The test never sends a real model request. */
    async *stream(): AsyncGenerator<never> { throw new Error('not exercised') },
  } as never)
  let resumedPermissionSetCalls = 0
  const resumedSessionPermission = {
    names: ['workspace-write', 'confirm'],
    /** Read the preset durable in this resumed session, not global state. */
    current() { return 'workspace-write' },
    /** Return a minimal picker option for each advertised preset. */
    optionOf(name: string) { return { value: name, name } },
    /** A resume must never invoke this fresh-session setter. */
    set(_session: { events: unknown[] }, _name: string) { resumedPermissionSetCalls += 1 },
  }
  resumedRoot.provide('permissionPresets', resumedSessionPermission)
  const resumedAgentCtx = resumedRoot.extend()
  const resumedSession = {
    id: 'resumed-session',
    seq: 1,
    events: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'request/header', data: { header: { config: { reasoningEffort: 'max' } } } },
    ],
    header: { id: 'resumed-session', cwd: '/tmp' },
  }
  const resumedAgent = {
    id: 'resumed-session',
    status: 'idle',
    options: {},
    ctx: resumedAgentCtx,
    session: resumedSession,
    followup() {},
    steer() {},
    inbox: { remove() {} },
  } as never
  const resumedChannel = createChannel(resumedRoot as never, resumedAgent, {
    model: 'deepseek-v4-flash',
    cwd: '/tmp',
    provider: 'deepseek-official',
    activity: false,
    freshSession: false,
  })
  if (resumedPermissionSetCalls !== 0) {
    throw new Error(`resumed session applied the global permission preference (${resumedPermissionSetCalls})`)
  }
  if (resumedChannel.reasoningEffort !== 'max') {
    throw new Error(`resumed session lost its durable effort: ${String(resumedChannel.reasoningEffort)}`)
  }

  console.log('persistent preferences: effort apply, permission apply, and permission write passed')
} finally {
  rmSync(isolatedHome, { recursive: true, force: true })
}
