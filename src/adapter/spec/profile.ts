/**
 * Thin spec-plane loader for the pinned dsh-ecosystem-spec profile.
 *
 * This module owns the boundary to the vendored TUI admission profile. The
 * actual registry/profile sha pins live in the Standard plane for now; the
 * long-term direction is to keep only dsh-ecosystem-spec private definitions
 * and conformance here.
 */

export {
  DSH_STD_REVISION,
  ECOSYSTEM_SPEC_REVISION,
  locateSpecDir,
  loadSpecData,
  verifyRegistry,
  verifyContractProfiles,
  registryEntries,
  digestFile,
  type SpecData,
} from '../standard/registry.js'
