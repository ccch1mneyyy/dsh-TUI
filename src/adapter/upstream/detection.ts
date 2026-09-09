/**
 * Structured upstream capability detection.
 *
 * This is the only shape a driver may return from detect(). It is deliberately
 * not a boolean: the kernel needs to know *why* a capability is unavailable or
 * only partially available so diagnostics and Host Descriptor publication stay
 * honest.
 */

export interface DetectionEvidence {
  readonly kind: 'service' | 'method' | 'version' | 'contract' | 'probe'
  readonly id: string
  readonly detail?: string
}

export type Detection =
  | {
      readonly state: 'supported'
      readonly evidence: readonly DetectionEvidence[]
    }
  | {
      readonly state: 'unsupported'
      readonly reason: string
    }
  | {
      readonly state: 'degraded'
      readonly missing: readonly string[]
      readonly evidence?: readonly DetectionEvidence[]
    }

export type DetectionState = Detection['state']
