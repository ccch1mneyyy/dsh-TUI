# Repository instructions

## Scope

This package is a vendored fork of `@earendil-works/pi-tui@0.84.2`.

- Upstream repository: `https://github.com/earendil-works/pi` (package path `packages/tui`).
- Pinned upstream commit: `086c32e74530564922d011ade23ff582c9d63116`.
- The same pin is recorded under `dsh.upstream` in `package.json`.

The initial vendor is zero-diff: `src/`, `test/`, and `native/` are byte-identical to the pinned upstream commit. The only intentional differences are packaging metadata: package name (`@deepseek-harness-tui/pi-tui`), version (`0.84.2-dsh.0`), `private: true`, the `dsh.upstream` record, a self-contained `tsconfig.build.json` (upstream inherits a monorepo-level base config that does not exist here), package-local `devDependencies` for the build toolchain, `files` including `LICENSE`, and the added `LICENSE` file.

## Maintenance rules

- This package must not carry dsh business logic.
- Only minimal fixes to generic capabilities (layout, input, rendering, etc.) are allowed.
- Each change is a minimal, rebasable commit on top of the pinned upstream base, accompanied by a minimal guard test.
- Record an upstream sync plan for every local change; prefer getting the fix merged upstream over growing local delta.

## Upgrade rules

- Before adopting a new upstream version, diff the new upstream commit against the pinned commit, then rebase the local commits one by one.
- The baseline may only be updated when `pnpm --filter @deepseek-harness-tui/pi-tui test` and the repository-root `pnpm test:tui` are both green.
- Keep an upgrade record containing: the upstream base commit, the list of local commits, and the verification results.

## Guard command

- `pnpm --filter @deepseek-harness-tui/pi-tui test`

## Local commits

| Subject | Upstream adoptability | Status |
| --- | --- | --- |
| Generic pointer event contract (`src/pointer.ts`, `Component.handlePointer`, root exports) | Yes — generic input capability | planned-in-working-tree |
| Clip-aware paint-order layout hit-test (`getHitChainAt` in `src/layout.ts`) | Yes — generic layout capability | planned-in-working-tree |
| Overlay hit regions (`OverlayHitRegion`, `compositeOverlays` recording in `src/tui.ts`) | Yes — generic overlay metadata | planned-in-working-tree |
| Pointer dispatch runtime (SGR/X10 decode, click-vs-drag, overlay dispatch, capture, hover in `src/tui-alt-screen.ts`) | Yes — generic input capability | planned-in-working-tree |
| Granular mouse option (`TuiMouseOptions { wheel, buttons }` in `src/tui-alt-screen.ts`, `mouse?: boolean \| TuiMouseOptions`) | Yes — generic input capability | planned-in-working-tree |
| SelectList pointer support (`handlePointer`: row click = focus + `onSelect`, clamped wheel step, in `src/components/select-list.ts`) | Yes — generic input capability | planned-in-working-tree |
| SettingsList pointer support (`handlePointer`: row click = focus + activate, clamped wheel step, submenu ownership, in `src/components/settings-list.ts`) | Yes — generic input capability | planned-in-working-tree |
| Editor autocomplete pointer routing (`handlePointer` forwards menu-region events to the suggestion list; a row click confirms through the keyboard Enter path, in `src/components/editor.ts`) | Yes — generic input capability | planned-in-working-tree |
| Editor click-to-caret (`handlePointer` positions the cursor from a primary click on the text rows via grapheme-aware wrap geometry; click-only, never consumed, in `src/components/editor.ts`) | Yes — generic input capability | planned-in-working-tree |
| ScrollView content metrics getters (`contentHeight` / `maxScrollTop` in `src/components/scroll-view.ts`; private field renamed `currentContentHeight`) | Yes — generic scroll capability | planned-in-working-tree |

Upstream sync plan: the pointer contract and the hit-test are generic
capabilities suitable for upstreaming, but their event semantics are coupled
to dsh parity requirements (click-vs-drag selection, modal capture blocking
pass-through). Strategy: stabilize inside the fork until the M3 stage 2
dispatch runtime is accepted, then propose the package-level pieces upstream
as PRs. If upstream lands its own pointer API first, prefer aligning to its
API shape; the local guard tests (`test/pointer-hit.test.ts`,
`test/overlay-hit-regions.test.ts`, `test/pointer-dispatch.test.ts`) are the
alignment checkpoints. The granular mouse option exists for hosts that must
disable click/selection while keeping wheel scroll (dsh's
`DSH_TUI_DISABLE_MOUSE` parity); it preserves the stage-2 contract that
`mouse: false` keeps stray-sequence legacy behavior byte-identical, and its
alignment checkpoint is `test/mouse-options.test.ts`. The list-component
pointer handlers (SelectList/SettingsList row click = Enter parity, wheel =
clamped selection step; Editor autocomplete menu routing with click
re-entering the keyboard Enter path) are the stage-4 pieces; their alignment
checkpoint is `test/pointer-components.test.ts`. The Editor click-to-caret
handler (stage 5) lives in the same file and checkpoint: it positions the
cursor on `click` only and never consumes, so terminal drag selection and
double/triple-click word/line selection are preserved by construction. The
ScrollView content metrics getters expose the layout-fed content height and
the exact clamp ceiling (`maxScrollTop = contentHeight - viewportHeight`) so
hosts can steer scroll navigation (timeline snapshot reachability) without
duplicating the layout composition rule; their alignment checkpoint is
`test/scroll-view-geometry.test.ts`.
