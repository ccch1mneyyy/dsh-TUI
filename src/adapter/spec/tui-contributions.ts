/**
 * Thin spec-plane surface for TUI-private protocol contributions.
 *
 * The private protocol definitions themselves are authored and owned by
 * tui-profile (`protocols/profile-definitions.js`). This module is the
 * single loading boundary: TUI source must import private protocol definitions
 * through this file, never directly through `#tui-profile/*` from
 * `adapter/standard` or UI code.
 */

import { DECISION_EVENTS } from '#tui-profile/profile-definitions'
export * from '#tui-profile/profile-definitions'
export {
  TUI_DECISION_EVENT_NAMES,
  TUI_EXTENSION_PERMISSION_NAMES,
} from './protocol-constants.js'
export { BACKEND_CAPABILITY_NAMES } from './backend-capabilities.js'
// The Backend contribution family (B-2). `profile-definitions` re-exports only
// the registrar, and the definition itself must come from the profile module that
// authors it — still inside the spec boundary, the one layer allowed to resolve
// `#tui-profile/*`. The import map for this specifier already exists
// (`package.json` `imports`); nothing new is mounted.
export {
  BACKEND,
  BACKEND_CONFIRMATION_POLICIES,
  BACKEND_RESERVED_IDS,
  assertBackendHandler,
  backendExtensionDefinition,
  validateBackendSpec,
} from '#tui-profile/tui-contributions'
export type {
  BackendHandler,
  BackendInstallRecipe,
  BackendSpec,
} from '#tui-profile/tui-contributions'

export const TUI_EXTENSION_API_VERSION = 'tui.dsh/v1alpha1'

/** Re-exported from tui-profile; kept as a named friendly alias. */
export const DECISION_EVENTS_COORDINATE = DECISION_EVENTS

// TUI_DECISION_EVENT_NAMES and TUI_EXTENSION_PERMISSION_NAMES are derived in
// `./protocol-constants.ts` (the only TUI-side authoring point) and re-exported
// here for the standard/product compatibility surface. No copies are authored
// in `adapter/standard` or legacy code.
