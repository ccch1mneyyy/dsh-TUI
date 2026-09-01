# Changelog

All notable changes to this repository are documented here. The project follows
the dsh-tui repository convention: user-facing behavior and public API changes
are logged in Chinese, with English summaries when appropriate.

## Unreleased — adapter-v2 P4/P5/P6 (local dev-adapter-v2 branch)

### Added

- **P4 Channel Host Ports and Kernel slice**
  - Added internal `HostChannelPort` with five split surfaces:
    `projection`, `actions`, `state`, `plugins`, `transcript`.
  - Added `src/adapter/channel/*` split modules:
    `projection.ts`, `actions.ts`, `state.ts`, `plugins.ts`,
    `transcript.ts`, `host-registry.ts`.
  - Added `dsh-tui-channel` upstream driver and `channel` KernelSlice.
  - `KernelRuntime.facade()` now exposes the channel Port and applies
    per-method shadow policy through `HostFacade`.
  - Production TUI wiring registers the live Channel with the adapter kernel.
  - Honest note: this is a new Port/projection and split-module layer, not a
    physical split of the production `src/dsh-adapter/channel.ts`; the large
    live Channel implementation file remains the source of truth.
  - New gate: `npm run verify:adapter-channel`.

- **P5 DSH event projection + Channel Provider/Consumer**
  - Added `ChannelProvider` and `ChannelConsumer` for the
    `tui.dsh/v1alpha1#Channel` operation envelope
    (`open` / `subscribe` / `invoke` / `close`).
  - Extended `src/adapter/kernel/replay.ts` with `runChannelReplay()` and a
    channel section on `runReplayShadow()`.
  - Replays use recorded snapshots or a minimal real DSH
    `agent.session.events` projection; validate against the vendored
    dsh-ecosystem-spec validators and official fixture, and check monotonic
    versions, features and method→feature mappings.
  - Unknown methods fail per protocol; continuity violations fail closed;
    replay JSON is size/depth bounded and deep-frozen.
  - New gate: `npm run verify:adapter-channel-conformance`.

### Removed / changed

- **P6 adapter compat cleanup**
  - Removed `src/plugin-spec/*` legacy shims.
  - Removed `src/dsh-adapter/grants.ts` and `src/dsh-adapter/host-descriptor.ts`
    legacy re-export shims.
  - Removed the internal `admissionCompat` /
    `admissionCompatCoordinates` option and `mountedAdmissionCoordinates()`
    helper.
  - All production imports now go to the canonical `src/adapter/standard/*`
    surface.
  - `src/plugin-host.ts` remains as the canonical public plugin-host surface
    without COMPAT markers.
  - `verify:compat-removal` now verifies the actual prod migration/export
    graph (shim absence, no legacy imports, no admissionCompat references,
    canonical `./plugin-host` export) rather than marker self-certification.

### Verification

- `pnpm exec tsc -p tsconfig.json --noEmit`
- `npm run verify:build` (includes all adapter gates above)
