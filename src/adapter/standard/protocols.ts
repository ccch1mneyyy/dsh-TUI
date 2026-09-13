/**
 * Canonical re-export surface for dsh-std public protocol packages.
 *
 * This is the only place in the new adapter where dsh-std runtime/type APIs
 * are re-exported for the legacy adapter layer. Consumer modules that still
 * live in `src/dsh-adapter/` during incremental migration should import from
 * here instead of importing `@dsh-std/*` directly.
 */

export { parseManifest, projectManifest } from '@dsh-std/manifest'
export { validateMessageEvent } from '@dsh-std/messages'
export {
  validateDeleteInput,
  validateDeleteOutput,
  validateGetInput,
  validateGetOutput,
  validateSetInput,
  validateSetOutput,
} from '@dsh-std/storage'
