/**
 * Canonical admission entry.
 *
 * This is the unified Standard-plane admission surface for the first vertical
 * slice: protocol catalog creation, manifest validation, Host Descriptor
 * validation and negotiation. Plugin identity binding remains a Kernel/legacy
 * Cordis concern because it requires activation ownership.
 */

export {
  createContractIndex,
  validatePlugin,
  validateHost,
  type ContractIndex,
} from './validate.js'
export { negotiate, type GrantedPermission } from './negotiate.js'
