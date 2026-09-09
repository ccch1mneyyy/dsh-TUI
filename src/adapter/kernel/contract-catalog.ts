/**
 * Kernel-facing view of the spec-derived host contract catalog.
 *
 * Upstream drivers receive the concrete contract/event catalog through this
 * Kernel module rather than importing Standard/Spec implementation files. The
 * values are still derived once in `src/adapter/spec/protocol-constants.ts`;
 * this module only re-exports them for the driver boundary.
 */

import { HOST_SUPPORTED_CONTRACTS, TUI_DECISION_EVENT_NAMES } from '../spec/protocol-constants.js'

export { HOST_SUPPORTED_CONTRACTS as KERNEL_HOST_SUPPORTED_CONTRACTS }
export { TUI_DECISION_EVENT_NAMES as KERNEL_TUI_DECISION_EVENT_NAMES }
