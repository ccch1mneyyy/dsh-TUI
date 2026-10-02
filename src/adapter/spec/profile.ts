/**
 * Thin spec-plane loader for the in-tree TUI Profile.
 *
 * This module owns the boundary to `tui-profile/`（本仓库自维护的准入与私有协议
 * 定义，纯文件、随代码修订）. The actual registry/profile sha pins live in the
 * Standard plane for now; the long-term direction is to keep only tui-profile
 * private definitions and conformance here.
 */

export {
  DSH_STD_REVISION,
  TUI_PROFILE_DIR,
  locateSpecDir,
  loadSpecData,
  verifyRegistry,
  verifyContractProfiles,
  registryEntries,
  digestFile,
  type SpecData,
} from '../standard/registry.js'
