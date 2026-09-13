/**
 * Upstream Driver Plane.
 *
 * This directory is the future/only allowed home for direct `@deepseek-ai/*`
 * imports. The current migration keeps legacy drivers in `src/dsh-adapter/` so
 * no behavior changes in this iteration; new drivers must land here.
 */

export type { Detection, DetectionState, DetectionEvidence } from './detection.js'
export type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
export {
  buildHostCapabilityLifecycles,
  refreshHostCapabilityLifecycles,
  detectHostDescriptorCapability,
  hostDescriptorDriver,
} from './host-descriptor-driver.js'
export {
  detectWorkspaceCapability,
  workspaceDriver,
} from './workspace-driver.js'
export {
  detectScenesCapability,
  scenesDriver,
} from './scenes-driver.js'
export {
  detectSettingsCapability,
  settingsDriver,
} from './settings-driver.js'
export {
  detectPresentationCapability,
  presentationDriver,
} from './presentation-driver.js'
export {
  detectDecisionsCapability,
  decisionsDriver,
} from './decisions-driver.js'
export {
  detectStatusCapability,
  detectShortcutsCapability,
  detectRenderersCapability,
  detectThemesCapability,
  detectToastCapability,
  detectCommandTreesCapability,
  statusDriver,
  shortcutsDriver,
  renderersDriver,
  themesDriver,
  toastDriver,
  commandTreesDriver,
} from './extensions-driver.js'
export {
  detectChannelCapability,
  verifyChannelLive,
  channelDriver,
} from './channel-driver.js'
