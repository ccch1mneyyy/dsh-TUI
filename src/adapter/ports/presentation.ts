/**
 * Internal Host Port for host presentation interactions.
 *
 * This is a TUI-internal narrow interface for asking/approving/showing
 * dialogs. It is intentionally not a protocol definition: no apiVersion,
 * no negotiation, no permission or manifest semantics, and no caller-
 * supplied owner identity. The runtime derives ownership from the active
 * Cordis activation before any such interaction is mediated.
 */

import type { HostDisposer } from './owner.js'

export interface HostQuestionItem {
  readonly id: string
  readonly question: string
  readonly options?: readonly string[]
  readonly multiple?: boolean
}

export interface HostQuestionRequest {
  readonly title: string
  readonly questions: readonly HostQuestionItem[]
}

export interface HostQuestionAnswerItem {
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface HostQuestionAnswer {
  readonly answers: readonly HostQuestionAnswerItem[]
}

export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

export interface HostApprovalRequest {
  readonly toolName: string
  readonly reason?: string
  readonly command?: string
  readonly external?: boolean
}

export interface HostDialogSelectOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface HostDialogSelectRequest {
  readonly title: string
  readonly options: readonly HostDialogSelectOption[]
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface HostDialogConfirmRequest {
  readonly title: string
  readonly message?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface HostDialogInputRequest {
  readonly title: string
  readonly placeholder?: string
  readonly initial?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type HostDialogRequest =
  | { readonly kind: 'select' } & HostDialogSelectRequest
  | { readonly kind: 'confirm' } & HostDialogConfirmRequest
  | { readonly kind: 'input' } & HostDialogInputRequest

export type HostDialogAnswer = string | boolean | undefined

/**
 * Presentation Port. The methods are intentionally async settle points for
 * host-internal UI; they do not expose the underlying DSH user-interaction
 * service or the plugin caller.
 */
export interface HostPresentationPort {
  ask(request: HostQuestionRequest): Promise<HostQuestionAnswer>
  approve(request: HostApprovalRequest): Promise<HostApprovalOutcome>
  dialog(request: HostDialogRequest): Promise<HostDialogAnswer>
}

/** Convenience alias for host-owned caller cleanup. */
export type HostPresentationDisposer = HostDisposer
