/**
 * dsh-TUI private protocol registration on the shared dsh-std catalog.
 *
 * Private protocol definitions are NOT authored here. The canonical
 * dsh-ecosystem-spec definitions are loaded through `src/adapter/spec/`; this
 * module only registers public dsh-std protocols and delegates the private
 * TUI profile definitions to the spec boundary.
 */

import { ProtocolCatalog } from '@dsh-std/core'
import { ManifestDefinitionCatalog } from '@dsh-std/manifest'
import { register as registerCommand } from '@dsh-std/command'
import { register as registerMessages } from '@dsh-std/messages'
import { register as registerPresentation } from '@dsh-std/presentation'
import { register as registerStorage } from '@dsh-std/storage'
import { registerProfileProtocols } from '../spec/tui-contributions.js'

export {
  TUI_EXTENSION_API_VERSION,
  DECISION_EVENTS_COORDINATE,
  DECISION_EVENTS,
  TUI_DECISION_EVENT_NAMES,
  TUI_EXTENSION_PERMISSION_NAMES,
  decisionEventsDefinition,
  profileDefinitions,
  registerProfileProtocols,
  tuiChannelDefinition,
  TUI_CHANNEL,
  TUI_CHANNEL_FEATURES,
  TUI_CHANNEL_WIRE_REVISION,
} from '../spec/tui-contributions.js'

export interface AdmissionCatalog {
  protocols: ProtocolCatalog
  manifests: ManifestDefinitionCatalog
}

/** Build a fresh catalog. This is intentionally not exported as the
 * production entry point; production callers must use `getAdmissionCatalog()`.
 * Keeping the builder private prevents a second canonical catalog from being
 * created by product code. */
function buildAdmissionCatalog(): AdmissionCatalog {
  const protocols = new ProtocolCatalog({ name: 'dsh-tui-admission', version: '0.15' })
  const manifests = new ManifestDefinitionCatalog()
  registerCommand(protocols, manifests)
  registerStorage(protocols)
  registerMessages(protocols)
  registerPresentation(protocols)
  registerProfileProtocols(protocols)
  return { protocols, manifests }
}

let canonicalAdmissionCatalog: AdmissionCatalog | undefined

/** Process-level canonical ProtocolCatalog / admission core. Every production
 * admission, descriptor and negotiation path must share this instance. */
export function getAdmissionCatalog(): AdmissionCatalog {
  canonicalAdmissionCatalog ??= buildAdmissionCatalog()
  return canonicalAdmissionCatalog
}

/** Backward-compatible factory retained as a long-term compatibility face
 * for existing callers. It now returns the same process-level canonical
 * catalog rather than allocating a new one, so no second admission core can
 * appear in production. OWNER: dsh-tui adapter. UNTIL: no scheduled removal.
 */
export function createAdmissionCatalog(): AdmissionCatalog {
  return getAdmissionCatalog()
}
