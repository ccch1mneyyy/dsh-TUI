# Plugin Development Guide (authoritative text: the TUI Profile)

[Documentation index](README.md) · [简体中文](plugins.md)

> This document has been merged with the in-repo TUI Profile (`tui-profile/`):
> [Plugin Admission and Development Guide](../tui-profile/docs/plugin-admission-and-development.md)

The ecosystem entry points and seam stability reference below are kept here
for quick reference; the authoritative status and compatibility agreement
live in the admission & development guide.

## Ecosystem entry points

- **Interface & compatibility agreement / Plugin development guide**:
  [Terminal Interactive Ecosystem Plugin Admission and Development Guide](../tui-profile/docs/plugin-admission-and-development.md)
  (admission spec, seams, contracts, verification checklist).
- **Organization**:
  [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)
  (home of community plugins and templates).
- **Template repository**:
  [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)
  (start from the template and ship a plugin in minutes).
- **Reference implementation**: `dsh-working-activity` (live working-status
  line with dual outlets: TUI prompt slot + `workingActivity` session
  projection).

## Seam stability reference

An **informal** maturity grading to help plugin authors gauge investment;
the authoritative status and compatibility agreement live in the
[admission & development guide](../tui-profile/docs/plugin-admission-and-development.md):

| Tier | Seams |
| --- | --- |
| Stable candidate (shape frozen; breaking changes go through a minor-version deprecation warning before removal) | VI settings sections · VIII full-screen scenes · X managed dialogs · XI status line · XII keyboard shortcuts · XIII entry renderers |
| Experimental (may still shift with dsh-std / the TUI Profile) | IX decision events · toast notifications (`ctx.tuiToast`, new) · **Side panels (`ctx.tuiPanels`, full panel + compact row, experimental)** |
| Upstream-tracked (stability owned by the cordis / dsh mechanisms underneath) | I session events · II official prompt slots · III bundled skills · IV themes · V system-prompt sections · VII profile composition |

Also an experimental public surface:

- `@deepseek-harness-tui/dsh-tui/api` (types-only entry).
- **Side panels (experimental, §18)**: `ctx.tuiPanels.register({ apiVersion:
  1, id, title, icon?, component | compact })` registers a right-sidebar
  panel (the host prefixes `<pluginId>:`; ≤4 panels per plugin, ≤32 globally;
  `open()` is rate-limited to once per 5s; 3 consecutive crashes disable the
  panel for the session). Of the two render slots — the full panel
  (`component`) and the compact row (`compact`, 1–3 lines) — **compact is
  descriptor-validated only this phase and not mounted yet**; `sendToChat`
  requires the `panels.chat.attach` grant (a later version) and currently
  always returns `false` with a one-time hint. Types live at
  `@deepseek-harness-tui/dsh-tui/panels` and `./api`.
- The `@deepseek-harness-tui/dsh-tui/test-utils` subpath and
  `ctx.tuiPluginHost.grants.corrupt` were removed in the adapter layering
  refactor (#705).
- **The backend contribution family (`tui.dsh/v1alpha1` `Backend`, seam XIV) is
  `alpha` and not promised**: the type surface (`BackendSpec`,
  `validateBackendSpec`, `backendAdmission`) and conformance
  (`TUI-BACKEND-001`) are usable, but the real admission wiring (bundle →
  registry → picker) is stage C work, so a third-party backend cannot pass
  admission today (W-1).
- `grants` is now the narrower `HostGrantFacade`; see that PR for migration
  details.
- On `TuiSceneProps.channel` (`ChannelUi`), `minimal` / `setMinimal()` were
  renamed to `minimalUi` / `setMinimalUi()`; the old names stay as
  **deprecated aliases** reading and writing the same Minimal UI switch, so
  existing full-screen scene plugins keep working. That switch only trims
  interface decoration and is unrelated to the kernel `minimal` agent preset
  (极简模式).
  **Removal condition (decidable): v0.13** — the rename and deprecated aliases
  first ship in v0.12.0, leaving one released minor-version deprecation window.
  At that cut, scan the scene-plugin consumption surface (this repo's `src/**`
  re-exports and every plugin on the dsh-tui-ecosystem org that reaches the
  port through `TuiSceneProps.channel`) for `.minimal` / `.setMinimal(`: zero
  callers means both aliases and the `'setMinimal': 'mutate'` row in
  `ui-policy.ts` are deleted in v0.13; any remaining caller is migrated within
  that same release rather than postponing the removal again.
- **The DSH kernel in the package's own entry** (the default since the
  standalone host, [configuration](configuration.en.md)): the screen mounts
  before the profile composes, so plugin rows activate *after* the first
  frame and every `ctx.tui*` registration reaches an already-mounted screen
  (themes, panels, status views and the rest join live). A runtime theme the
  user had chosen is applied once its plugin registers it; until then the
  first frames use the auto-detected palette. The root-capability guard is
  the same as under `dsh --profile`: a row activating after the first TUI row
  cannot use `ctx.root` capabilities (`root.plugin`, `root.effect`,
  `root.on`, …) in its apply. A plugin that waits for something in its apply
  holds the composition: start long work detached, not awaited. On a scene's
  `TuiSceneProps.channel`, `ready` is `false` (and `status` `'starting'`)
  while no session stands behind the channel, e.g. after the startup session
  failed to open (`startupFailure`).
- **Claude and Codex kernels** (light profile; accepted on Claude, not yet on
  Codex, which takes the same composition path): the entry composes this
  package's rows and the third-party bundles the profile declares, without
  `@deepseek-ai/dsh-base`, after the first frame, on the same terms as above.
  A row whose `inject` names a service only DSH's core provides (`agents`,
  `llm`, `tools`, `sessionPersistence`, …) stays pending on these kernels;
  the `tui*` services are all there.

- The core repository remains independent; community plugins live in their own
  repos.
- The organization only maintains the listing and admission rules — it does
  not endorse or warrant the functionality, quality, or safety of community
  plugins.
- Plugin authors keep full ownership of their repositories and are responsible
  for their maintenance and security.
