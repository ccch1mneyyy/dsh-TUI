/**
 * Thin spec-plane surface for TUI-private protocol contributions.
 *
 * The private protocol definitions themselves are authored and owned by
 * dsh-ecosystem-spec (`protocols/profile-definitions.js`). This module is the
 * single loading boundary: TUI source must import private protocol definitions
 * through this file, never directly through `#dsh-ecosystem-spec/*` from
 * `adapter/standard` or UI code.
 */

import { DECISION_EVENTS } from '#dsh-ecosystem-spec/profile-definitions'
export * from '#dsh-ecosystem-spec/profile-definitions'
export {
  TUI_DECISION_EVENT_NAMES,
  TUI_EXTENSION_PERMISSION_NAMES,
} from './protocol-constants.js'

export const TUI_EXTENSION_API_VERSION = 'tui.dsh/v1alpha1'

/** Re-exported from dsh-ecosystem-spec; kept as a named friendly alias. */
export const DECISION_EVENTS_COORDINATE = DECISION_EVENTS

// TUI_DECISION_EVENT_NAMES and TUI_EXTENSION_PERMISSION_NAMES are derived in
// `./protocol-constants.ts` (the only TUI-side authoring point) and re-exported
// here for the standard/product compatibility surface. No copies are authored
// in `adapter/standard` or legacy code.
