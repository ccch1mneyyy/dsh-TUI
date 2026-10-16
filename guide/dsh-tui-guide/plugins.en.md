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

A maturity grading to help plugin authors gauge investment; the authoritative
status and compatibility agreement live in the
[admission & development guide](../tui-profile/docs/plugin-admission-and-development.md).
**The "stable candidate" tier is part of the frozen public surface as of the first
published apiVersion (`tui.dsh/v1alpha1`)** — the four commitments are in
`tui-profile/CHANGELOG.md`'s freeze entry; the other two tiers stay a **maturity
reference**, not a promise:

| Tier | Seams |
| --- | --- |
| Stable candidate (shape frozen; breaking changes go through a minor-version deprecation warning before removal) | VI settings sections · VIII full-screen scenes · X managed dialogs · XI status line · XII keyboard shortcuts · XIII entry renderers |
| Experimental (may still shift with dsh-std / the TUI Profile) | IX decision events · toast notifications (`ctx.tuiToast`, new) · **Side panels (`ctx.tuiPanels`, full panel + compact row, experimental)** |
| Upstream-tracked (stability owned by the cordis / dsh mechanisms underneath) | I session events · II official prompt slots · III bundled skills · IV themes · V system-prompt sections · VII profile composition |

Also an experimental public surface:

- `@deepseek-harness-tui/dsh-tui/api` (types-only entry).
- **Rows inside a preset (experimental, seam VII)**: a bundle changes the `config` of a row
  inside a preset dsh-TUI registers (for example, turning off `standard`'s
  `compaction-basic` auto-compaction) with a `@deepseek-harness-tui/dsh-tui/preset-patch` row;
  see seam VII of the [admission and development guide](../tui-profile/docs/plugin-admission-and-development.md).
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
- **The backend contribution family (`tui.dsh/v1alpha1` `Backend`, seam XIV) has its
  public surface frozen with the first published apiVersion**: the type surface
  (`BackendSpec`, `validateBackendSpec`, `backendAdmission`) and conformance
  (`TUI-BACKEND-001`) are usable, and the **admission chain (manifest →
  registry → descriptor) is wired**; what is still missing is the step that
  reads a mounted bundle's declaration into the registry and the kernel picker,
  so "install a third-party backend, restart, see it in the picker" does not hold
  end to end yet.
- **Installing a package is available in the terminal itself (C-4)**: `/plugin
  install <spec>` goes through the host's `ctx.pluginManager` — a pre-install
  notice, a trust confirmation decided by provenance of the package (the judge is
  the packaged `tui-profile/feed/first-party.json`, decided offline; anything it
  cannot vouch for falls back to the confirmation), and `esc` to close the pane.
  During an install, it attempts cancellation and waits for profile writes to
  settle: the service rolls the profile back on cancellation, or finishes the
  install if applying has already made cancellation too late. Blocked build
  scripts can be approved in the pane, and an incompatible version can receive
  an **exact-version exemption**. Cancelling during exemption registration waits
  for the current write and stops subsequent grants and the retry; exemptions
  already written remain. **Known gaps**:
  provenance is only a one-vote-to-veto seam with no online check at all (the
  host service exposes no such API), and with no service the transcript reports
  the CLI command and the reason instead of **running `dsh plugin` on the user's
  behalf** (no pane opens: there is no flow to drive).
- **Lifecycle actions are available in the terminal itself (C-5)**: `/plugin remove
  <bundle>`, `/plugin enable <name|id>` and `/plugin disable <name|id>` go through the
  same host service. **A bundle and a row are two levels**: a bundle is a composition
  layer (the profile manifest's `dsh.profile.bundles`), a row is one patch entry's
  `disabled`. The argument resolves against one snapshot, a bundle name first and
  exactly, then `entryId` → `patchId` → module name; nothing that matches is reported
  with what is addressable rather than guessed at. A module name matching multiple rows
  is refused with their row IDs; use a specific ID. **Gate 2** (this application may not
  switch itself off) refuses three kinds of target hard — the bundle providing this app,
  the host layer `@deepseek-ai/dsh-base`, and this application's own rows (those loading
  a module of this package, **or inserted by its own patch**: measured, that patch inserts
  17 rows and 8 of them load a first-party `@deepseek-ai/*` module, of which the host locks
  exactly one) — with a reason line and **no service call at all**, and it does so whether or not hot
  reload is live (the host's own `stop-profile` guard only fires without HMR, and this
  profile runs `patchReload: live`). `enable` is never refused by gate 2: it is the
  repair action, and refusing it would seal off the only in-UI way back from a profile
  somebody edited by hand. The host's own lock (`management-required` / `unaddressable`)
  refuses both directions and its reason is quoted as given. **Every `enable` and `remove` requires confirmation** (a removal lists the
  rows and overrides it drops), while `disable` asks only about a row the host layer
  owns (switching one off unloads services this app injects). The host does not attest
  installed package sources: local and Git packages can claim the same name and version,
  so an exact feed match cannot waive confirmation when enabling. These actions have **no
  cancellation**: the service offers none, so `esc` only closes the pane while the write
  finishes and reports itself into the transcript (same session). **Known gaps**: a
  removal deletes no user data — `~/.dsh-tui/backends/<id>/`, grants and storage
  namespaces are **reported once** and left for the person to delete; when a package's
  declaration cannot be read, the flow says it could not judge rather than claiming the
  removal was clean.
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
