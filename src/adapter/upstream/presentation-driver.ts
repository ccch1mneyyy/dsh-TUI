/**
 * Upstream driver for the TUI presentation capability.
 *
 * Presentation is fundamentally interactive: ask/approve/confirm require a
 * human answer and cannot be safely auto-reversed without producing user-
 * visible UI. This driver therefore stays honest:
 * - detect() reports the service/method topology as `degraded` until a real
 *   reversible presentation probe exists;
 * - verifyLive() returns a degraded lifecycle and never fabricates `live`.
 * The only thin port surface mounted today is the host dialog queue; ask and
 * approve are intentionally staged and fail closed.
 */

import type { Context } from '../../dsh-adapter/types.js'
import type {
  HostPresentationPort,
  HostDialogRequest,
  HostDialogAnswer,
  HostQuestionRequest,
  HostQuestionAnswer,
  HostApprovalRequest,
  HostApprovalOutcome,
} from '../ports/presentation.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import { getHostDialogStore } from '../../dsh-adapter/dialogs.js'
import { getQuestionStore } from '../../dsh-adapter/questions.js'
import { getApprovalStore } from '../../dsh-adapter/approvals.js'

const CAPABILITY = 'host.presentation'

function serviceEvidence(id: string): DetectionEvidence {
  return { kind: 'service', id }
}

function methodEvidence(service: string, method: string): DetectionEvidence {
  return { kind: 'method', id: `${service}:${method}` }
}

function probeEvidence(id: string, detail: string): DetectionEvidence {
  return { kind: 'probe', id, detail }
}

type HostContext = Pick<Context, 'get'>

export function detectPresentationCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiDialogs')
  if (service === undefined) {
    return { state: 'unsupported', reason: 'tuiDialogs service is not mounted' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiDialogs')]
  for (const method of ['select', 'confirm', 'input'] as const) {
    if (typeof (service as unknown as Record<string, unknown>)[method] === 'function') {
      evidence.push(methodEvidence('tuiDialogs', method))
    }
  }
  return {
    state: 'degraded',
    missing: ['reversible-presentation-probe'],
    evidence: [
      ...evidence,
      probeEvidence('presentation.interactive', 'ask/approve/confirm require human interaction; no safe auto-reversible live probe in P3'),
    ],
  }
}

async function verifyPresentationLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const detection = detectPresentationCapability(ctx)
  if (detection.state === 'unsupported') {
    return [lifecycleFromDetection(CAPABILITY, detection)]
  }
  return [lifecycleFromDetection(CAPABILITY, {
    state: 'degraded',
    missing: ['reversible-presentation-probe'],
    evidence: detection.evidence ?? [],
  })]
}

function createPresentationPort(ctx: unknown): HostPresentationPort {
  const service = (ctx as HostContext | undefined)?.get?.('tuiDialogs')
  const store = service === undefined ? undefined : (() => {
    try {
      return getHostDialogStore(service as never)
    } catch {
      return undefined
    }
  })()

  return Object.freeze({
    async ask(request: HostQuestionRequest): Promise<HostQuestionAnswer> {
      const questionStore = getQuestionStore(ctx as never)
      if (questionStore === undefined) {
        throw new Error('dsh-tui: host.presentation.ask is unavailable because no QuestionStore is mounted in this composition')
      }
      const answer = await questionStore.ask({
        questions: request.questions.map(item => ({
          id: item.id,
          question: item.question,
          ...(item.options === undefined ? {} : {
            options: item.options.map(label => ({ label })),
          }),
          ...(item.multiple === true ? { multiSelect: true } : {}),
        })),
      })
      return { answers: answer.answers }
    },
    async approve(_request: HostApprovalRequest): Promise<HostApprovalOutcome> {
      // P3: approval is intentionally staged on the Host Port because a real
      // ApprovalStore.park() needs the DSH ApprovalRequest's live agent/session
      // context, which this internal Port does not carry. It is not silently
      // pretending to be a working approval path.
      const approvalStore = getApprovalStore(ctx as never)
      if (approvalStore === undefined) {
        throw new Error('dsh-tui: host.presentation.approve is unavailable because no ApprovalStore is mounted in this composition')
      }
      throw new Error('dsh-tui: host.presentation.approve is staged in P3; use the DSH approval/request waterfall which carries a live ApprovalRequest')
    },
    dialog(request: HostDialogRequest): Promise<HostDialogAnswer> {
      if (store === undefined) return Promise.resolve(undefined)
      const snapshot = {
        kind: request.kind,
        title: request.title,
        ...(request.kind === 'select' ? { options: request.options } : {}),
        ...(request.kind === 'confirm' ? {
          ...(request.message === undefined ? {} : { message: request.message }),
          confirmLabel: request.confirmLabel ?? 'OK',
          cancelLabel: request.cancelLabel ?? 'Cancel',
        } : {}),
        ...(request.kind === 'input' ? {
          ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
          initial: request.initial ?? '',
        } : {}),
      } as never
      return store.ask(snapshot, request.signal, request.timeoutMs) as Promise<HostDialogAnswer>
    },
  })
}

export const presentationDriver: UpstreamDriver = {
  id: 'dsh-tui-presentation',
  upstreamFamily: 'dsh-tui',
  capability: 'host.presentation',
  mountEffectClass: 'mutate',
  detect: detectPresentationCapability,
  verifyLive: verifyPresentationLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const ports = { presentation: createPresentationPort(context) }
    return { disposer: () => undefined, ports }
  },
}
