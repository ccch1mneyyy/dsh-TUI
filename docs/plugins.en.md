# Plugin Development Guide (merged into spec)

[Documentation index](README.md) · [简体中文](plugins.md)

> This document has been merged with the ecosystem admission specification:
> [Plugin Admission and Development Guide](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)

The ecosystem entry points and seam stability reference below are kept here
for quick reference; the authoritative status and compatibility agreement
live in the admission & development guide.

## Ecosystem entry points

- **Interface & compatibility agreement / Plugin development guide**:
  [Terminal Interactive Ecosystem Plugin Admission and Development Guide](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)
  (admission spec, seams, contracts, verification checklist).
- **Organization**:
  [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)
  (home of community plugins and templates).
- **Template repository**:
  [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)
  (start from the template and ship a plugin in minutes).
- **Reference implementation**: `dsh-working-activity` (live working-status
  line with dual outlets: TUI prompt slot + `activity/status` session events).

## Seam stability reference

An **informal** maturity grading to help plugin authors gauge investment;
the authoritative status and compatibility agreement live in the
[admission & development guide](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md):

| Tier | Seams |
| --- | --- |
| Stable candidate (shape frozen; breaking changes go through a minor-version deprecation warning before removal) | VI settings sections · VIII full-screen scenes · X managed dialogs · XI status line · XII keyboard shortcuts · XIII entry renderers |
| Experimental (may still shift with dsh-std / admission-spec evolution) | IX decision events · toast notifications (`ctx.tuiToast`, new) |
| Upstream-tracked (stability owned by the cordis / dsh mechanisms underneath) | I session events · II official prompt slots · III bundled skills · IV themes · V system-prompt sections · VII profile composition |

Also an experimental public surface:

- `@deepseek-harness-tui/dsh-tui/api` (types-only entry).
- The `@deepseek-harness-tui/dsh-tui/test-utils` subpath and
  `ctx.tuiPluginHost.grants.corrupt` were removed in the adapter layering
  refactor (#705).
- `grants` is now the narrower `HostGrantFacade`; see that PR for migration
  details.

- The core repository remains independent; community plugins live in their own
  repos.
- The organization only maintains the listing and admission rules — it does
  not endorse or warrant the functionality, quality, or safety of community
  plugins.
- Plugin authors keep full ownership of their repositories and are responsible
  for their maintenance and security.
