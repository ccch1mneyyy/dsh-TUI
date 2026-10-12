/**
 * The probe backend implementation (F-1 fixture, B-2).
 *
 * It implements the same `AgentBackend` surface claude and codex do — `detect`,
 * `open`, `catalog` — plus the module-level pool hook its manifest names as
 * `unloadExport`. What it does *not* do is import a vendor SDK, spawn anything, or
 * touch the network: the gate drives it against the real registry, the real ledger
 * and the real loader, and every fact it reports is a counter.
 */
import type { AgentBackend, BackendDetection, BackendHost, OpenTarget } from '../../../src/agent/backend.js'
import type { AgentSession } from '../../../src/agent/session.js'
import { notePoolClose, notePoolOpen } from './pool.js'

// Module evaluation IS the pool opening (D4): "never loaded" must mean "never
// imported", and the only way to observe that is a side effect here.
notePoolOpen()

/** The session surfaces a probe session serves, overridable so the gate can build
 *  the deliberately-broken variant (serving a name its declaration lacks). */
export interface ProbeOptions {
  readonly capabilities?: AgentSession['capabilities']
  readonly detection?: BackendDetection
}

function probeSession(target: OpenTarget, capabilities: AgentSession['capabilities']): AgentSession {
  const sessionId = target.kind === 'resume' ? target.sessionId : 'probe-created'
  return {
    ref: { backendId: 'probe-backend', sessionId },
    cwd: target.kind === 'create' ? target.cwd : process.cwd(),
    status: 'idle',
    capabilities,
    history: async () => [],
    subscribe: () => () => undefined,
    submit: async () => ({ accepted: true }),
    removePending: () => false,
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }),
    dispose: async () => undefined,
  } satisfies AgentSession
}

/** A fresh probe backend. `probeBackend` below is the instance the registry loads. */
export function createProbeBackend(options: ProbeOptions = {}): AgentBackend {
  const capabilities = options.capabilities ?? {}
  return {
    id: 'probe-backend',
    descriptor: { label: 'Probe Backend' },
    detect: async (_host: BackendHost) => options.detection ?? { installed: true, version: '0.1.0' },
    open: async (target: OpenTarget, _host: BackendHost) => probeSession(target, capabilities),
    catalog: {
      list: async () => [],
      info: async sessionId => ({ id: sessionId, title: 'Probe session', updatedAt: 0 }),
    },
  }
}

/** The export the manifest's `backendExport` names. */
export const probeBackend: AgentBackend = createProbeBackend()

/** The export the manifest's `unloadExport` names: closes the module-level pool.
 *  The registry calls it only for an entry it actually loaded, and exactly once
 *  per unload pass. */
export async function closeProbePool(): Promise<void> {
  notePoolClose()
}
