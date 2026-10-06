/**
 * Cost rule for every real Codex run (live tests, probes, fixture
 * recordings; docs/codex-backend-design.md D16, §10.6): the relay's
 * `gpt-5.6-terra` (fallback `gpt-6-sol`) at reasoning effort `low`, nothing
 * else, and never the user's own `~/.codex`.
 *
 * - {@link liveCodexHome} builds a throwaway CODEX_HOME whose config.toml
 *   pins the model and effort, and returns the `codex app-server` arguments
 *   that route it to the relay provider (`-c model_providers.relay.*`, the
 *   base URL from `CODEX_TEST_BASE_URL`, the key through `env_key =
 *   "CODEX_TEST_API_KEY"`). The base URL and key are read from the
 *   environment only: never printed, logged or written to any file (the
 *   provider rides argv; the key never leaves the environment).
 * - {@link assertCheapRequest} refuses (throws) a JSON-RPC request that would
 *   pick another model or effort (`thread/start`, `thread/resume`,
 *   `thread/fork`, `turn/start`, `thread/settings/update`, a collaboration
 *   mode's settings); live harnesses run every request through it.
 * - {@link pinCheapOrExit} refuses to start (exit 2) when the environment or
 *   the Codex backend's persisted `/model` / `/effort` choice
 *   (`~/.dsh-tui/backends/codex/prefs.json`) points elsewhere.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The only models a real run may use, preferred first. */
export const LIVE_MODELS = ['gpt-5.6-terra', 'gpt-6-sol']
/** The only reasoning effort a real run may use. */
export const LIVE_EFFORT = 'low'

const refuse = (label, what) => {
  throw new Error(`${label}: refusing — ${what}; real Codex runs use ${LIVE_MODELS.join(' / ')} at effort ${LIVE_EFFORT} only`)
}

/** Throw unless `model` / `effort` (when given) are the pinned ones. */
export function assertCheap(label, { model, effort } = {}) {
  if (model !== undefined && model !== null && !LIVE_MODELS.includes(model)) refuse(label, `model ${model}`)
  if (effort !== undefined && effort !== null && effort !== LIVE_EFFORT) refuse(label, `effort ${effort}`)
}

/** Throw when a request would change the model or effort to anything else. */
export function assertCheapRequest(label, method, params = {}) {
  if (!['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'thread/settings/update', 'turn/settings/update', 'review/start'].includes(method)) return
  assertCheap(`${label} ${method}`, { model: params.model, effort: params.effort ?? params.reasoningEffort })
  const settings = params.collaborationMode?.settings
  if (settings !== undefined && settings !== null) assertCheap(`${label} ${method} collaborationMode`, { model: settings.model, effort: settings.reasoning_effort })
  const config = params.config
  if (config !== undefined && config !== null) assertCheap(`${label} ${method} config`, { model: config.model, effort: config.model_reasoning_effort })
}

/** Exit 2 when the environment or the persisted backend choice is not cheap. */
export function pinCheapOrExit(label, dataDir) {
  try {
    assertCheap(label, { model: process.env.CODEX_TEST_MODEL, effort: process.env.CODEX_TEST_EFFORT })
    let persisted = {}
    try {
      persisted = JSON.parse(readFileSync(join(dataDir, 'backends', 'codex', 'prefs.json'), 'utf8'))
    } catch {
      persisted = {}
    }
    assertCheap(`${label} (backends/codex/prefs.json)`, { model: persisted.model, effort: persisted.effort })
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  if (!process.env.CODEX_TEST_BASE_URL || !process.env.CODEX_TEST_API_KEY) {
    console.error(`${label}: CODEX_TEST_BASE_URL / CODEX_TEST_API_KEY are not set (source the relay env file first)`)
    process.exit(2)
  }
  return { model: process.env.CODEX_TEST_MODEL || LIVE_MODELS[0], effort: LIVE_EFFORT }
}

/** The `codex app-server -c …` overrides that route to the relay provider
 *  (id `relay`); the key stays in `CODEX_TEST_API_KEY` (`env_key`). */
export function relayProviderArgs() {
  const baseUrl = process.env.CODEX_TEST_BASE_URL
  if (!baseUrl || !process.env.CODEX_TEST_API_KEY) throw new Error('relayProviderArgs: source the relay env file first')
  return [
    '-c', 'model_provider="relay"',
    '-c', 'model_providers.relay.name="test relay"',
    '-c', `model_providers.relay.base_url=${JSON.stringify(baseUrl)}`,
    '-c', 'model_providers.relay.env_key="CODEX_TEST_API_KEY"',
    '-c', 'model_providers.relay.wire_api="responses"',
  ]
}

/**
 * A throwaway CODEX_HOME pinned to the cheap model and effort, a throwaway
 * project directory, and the app-server arguments that route to the relay
 * (`provider: false` = no provider arguments). `extra` is appended to
 * config.toml (never a model, effort or provider).
 */
export function liveCodexHome({ model = LIVE_MODELS[0], extra = '', provider = true } = {}) {
  assertCheap('liveCodexHome', { model })
  if (/^\s*(?:model|model_reasoning_effort|model_provider)\s*=/mu.test(extra) || /model_providers/u.test(extra)) refuse('liveCodexHome', 'extra config may not set the model, effort or provider')
  const appServerArgs = provider ? relayProviderArgs() : []
  const home = mkdtempSync(join(tmpdir(), 'codex-live-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codex-live-cwd-'))
  writeFileSync(join(home, 'config.toml'), [`model = "${model}"`, `model_reasoning_effort = "${LIVE_EFFORT}"`, extra, ''].join('\n'), { mode: 0o600 })
  return {
    home,
    cwd,
    appServerArgs,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}
