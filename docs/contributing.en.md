# Contributing

[Documentation index](README.md) · [简体中文](contributing.md)

Thanks for considering contributing to dsh-TUI! This guide is the shared
development contract for humans and coding agents working on `@deepseek-harness-tui/dsh-tui`.

## How To Contribute

- **Report bugs or request features** by opening an issue with a clear
  reproduction and the terminal environment you use.
- **Open a pull request** against `main`. Keep changes focused: one logical
  change per PR, with a Chinese or bilingual title and a description that
  covers motivation, what changed, and how it was verified.
- **Run the verification matrix** below before requesting a review; CI runs
  the same commands.
- New features should include or extend a focused regression script.



## Scope

This file applies to the entire repository. It is the shared development
contract for humans and coding agents working on `@deepseek-harness-tui/dsh-tui`.

`@deepseek-harness-tui/dsh-tui` is a single-package, ESM-only TypeScript project. It provides a
React terminal UI front door for DeepSeek Harness through Cordis. The package
owns the TUI, its local command surface, packaged skills, and a ported Ink/Yoga
renderer. DeepSeek Harness owns the agent, session, model, tool, persistence,
and policy domains that the TUI consumes.

Before making a broad change, read `package.json`, the relevant README section,
and every source file being edited. Prefer the repository's existing service
boundaries and helpers over introducing parallel abstractions.

## Repository Map

- `src/index.ts`: public Cordis plugin entry point, configuration schema, and
  lazy handoff to the runtime plugin.
- `src/plugin.ts`: TTY validation, service registration, agent creation/resume,
  React tree mounting, and terminal/process teardown.
- `src/channel.ts`: event-to-view projection and the non-React action surface.
  It translates DSH session events into transcript rows and implements submit,
  steering, rewind, resume, model/preset switching, local reports, and related
  state transitions.
- `src/screens/Chat.tsx`: top-level interaction coordinator. It owns modal
  precedence, global keyboard handling, scroll/search/selection state, slash
  command dispatch, and composition of the chat screen.
- `src/screens/StatusLine.tsx` and `src/screens/StatusMetrics.ts`: terminal
  status presentation and metric derivation.
- `src/components/`: feature components. `components/design-system/` contains
  theme-aware primitives; `components/messages/` contains transcript rows;
  `components/questions/` contains the `ask_user_question` UI.
- `src/ui.ts`: preferred facade for the local renderer, themed `Box`/`Text`,
  hooks, and public TUI primitives.
- `src/ink/`: ported, low-level Ink renderer and terminal implementation.
  Treat it as sensitive infrastructure: keep changes focused and accompany
  them with renderer-specific regression coverage.
- `src/native-ts/yoga-layout/`: ported layout engine used by the renderer.
- `src/cc/`: terminal formatting and presentation helpers adapted for the
  Claude Code-style UI.
- `src/*Prefs.ts`, `src/customTheme.ts`, and `src/sessionHistory.ts`: persisted
  user preferences and local session metadata under `~/.dsh-tui`.
- `skills/*/SKILL.md`: skills shipped in the npm package and registered by
  `src/packaged-skills.ts`.
- `cordis.patch.yml`: package bundle overlay used by profile installation.
  Ordering, row IDs, disabled host rows, and insert/override semantics matter.
- `cordis.yml`: full bare-composition example for direct Cordis/DSH startup.
- `scripts/`: headless regressions, reproduction harnesses, probes, and
  diagnostics. Read each script's header before running it.
- `lib/`: ignored JavaScript, declarations, and declaration maps generated from
  `src/` and shipped to npm. `./invariant` uses the compiled
  `lib/types/dsh-adapter/invariant.js` entry as well.
- `README.md` and `README_EN.md`: Chinese and English user documentation. Keep
  behavior, configuration, shortcuts, and limitations synchronized between
  them.

## Runtime Shape

The central runtime path is:

```text
Cordis config
  -> src/index.ts
  -> src/plugin.ts
  -> DSH agent/session services
  -> src/channel.ts (session events -> Channel snapshot)
  -> src/screens/Chat.tsx
  -> src/components/*
  -> src/ui.ts
  -> src/ink/* + Yoga layout
  -> terminal ANSI output
```

Keep ownership in the layer where it belongs:

- Agent/session/tool facts come from DSH services and durable session events.
- Projection and TUI actions belong in `channel.ts`, not in presentation
  components.
- Interaction modes and key precedence belong in `Chat.tsx` or the focused
  modal/input component.
- Reusable visual behavior belongs in `components/` and theme-aware primitives.
- Terminal protocol, layout, hit-testing, selection, and frame-diff behavior
  belong in `ink/`.

Do not reimplement a DSH domain service in the TUI merely to make a screen
easier to build. Adapt the service through the channel or an existing registry
seam.

## Toolchain

- Supported Node versions are `^22.19 || >=24`; CI uses Node 24.
- CI and publishing use pnpm 11. Use pnpm as the development package manager.
- Install a clean checkout with:

  ```sh
  pnpm install --frozen-lockfile
  ```

- `pnpm-lock.yaml` is the single lockfile. npm consumers do not read a
  dependency's lockfile, so `package-lock.json` has been removed (follow-up of
  #173).
- When intentionally changing dependencies, update `pnpm-lock.yaml` with
  `pnpm add`, inspect the full lockfile diff, and avoid unrelated upgrades.
- Every `@deepseek-ai/*` framework package this package references at runtime
  or from its published types (mirroring `UPSTREAM_BLESSED_PACKAGES`, including
  `@deepseek-ai/schemastery`) is both a peer and a dev dependency: framework
  packages are host-provided and resolve at runtime to the host's own instance
  through the `$DSH_HOME/profiles/node_modules` fallback tree (see #198 —
  declaring them as runtime dependencies lands real copies inside the profile
  and splits module identity from the host). The dev declarations exist only
  so the package can type-check locally. Add new references of this kind to
  both sections at matching ranges (the verify:manifest-deps gate enforces
  it). Framework packages used only by tests/scripts (e.g. dsh-settings,
  dsh-tools, dsh-session-persistence-*) stay dev-only — do NOT declare peers
  for them. Non-host packages such as `dsh-working-activity` stay runtime
  dependencies. Historical exception, now resolved: `dsh-working-activity@0.2.4`
  and earlier pulled a real copy of `@deepseek-ai/schemastery` (plus cosmokit)
  into the profile via its runtime dependency, shadowing the fallback tree;
  0.2.5 peer-ified it (working-activity#2), so profiles no longer carry any
  framework copies. Keep the dependency range at `^0.2.6` or above (0.2.6 also
  fixes the web-side WorkingLine absent-field guard on unpatched hosts,
  working-activity#5).
- Do not expose, persist, or print credentials. Interactive startup reads
  `DEEPSEEK_API_KEY`; diagnostics may report whether it is set but must not
  reveal the complete value.

## Build And Generated Files

The normal build and type-check gate is:

```sh
pnpm build
```

This removes the complete `lib/` directory, runs `tsc -p tsconfig.json` to emit
`src/` into `lib/types/`, and then checks the adapter boundary, upstream
contract, and patch surface. The `prepare` lifecycle performs only the clean
compilation so npm Git URL installs produce a runnable package without
checked-in output. Local and CI workflows use explicit commands instead of
depending on whether pnpm implicitly runs the root lifecycle.

Rules for generated output:

- Edit `src/`, never `lib/`, to implement behavior.
- After any source change, run `pnpm build`, but do not commit generated files
  from `lib/`.
- Clean compilation removes the complete `lib/` first, so renamed or deleted
  source modules cannot leave stale output behind.
- Run `pnpm verify:package` to ensure every `main`, `types`, `bin`, and `exports`
  target is present in the npm tarball and to smoke-import the main and
  invariant entries.
- Documentation-only, workflow-only, and YAML-only changes do not require a
  rebuild unless they also alter TypeScript inputs.
- Git URL installation with `--ignore-scripts` skips `prepare` and is therefore
  unsupported. Registry packages already contain compiled output and do not
  depend on lifecycle scripts running on the consumer's machine.

`scripts/build.sh` is an alternate builder for a local DeepSeek Harness source
checkout. It locates a DSH checkout and rewires dependencies to that checkout.
It is not the default build command for this standalone repository.

## Verification

There is no root `test` or `lint` script. Do not claim that either ran. The
TypeScript build is the universal static gate, followed by focused executable
regressions.

CI runs these commands after installation:

```sh
pnpm compile                               # generate a clean runtime
test -f lib/types/index.js
pnpm verify:build                          # build gates without recompiling
pnpm verify:package                        # npm tarball and entry smoke test
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

Run all three CI regressions for changes to shared rendering, `Chat`, prompt or
question layout, tool cards, theme primitives, or the Ink core. For a narrow
change, also run the closest focused script:

| Change area | Focused verification |
| --- | --- |
| General headless screen composition | `pnpm smoke` |
| Channel submit/steer/pending behavior | `node scripts/verify-submit.mjs` |
| Prompt queue behavior | `node scripts/verify-queue.mjs` |
| Goal/todo projection and rendering | `node scripts/verify-channel-goal-todo.mjs` and `node scripts/verify-goal-todo.mjs` |
| Compaction and folded transcript rows | `node scripts/verify-compact.mjs` |
| Theme loading and persistence | `node --import tsx/esm scripts/verify-themes.mjs` |
| Scrolling/sticky-bottom behavior | `node scripts/verify-scroll.mjs`, `node scripts/verify-resticky.mjs`, and the matching `repro-*` harness |
| Fullscreen copy-on-select | `node scripts/verify-copy-on-select.mjs` |

Most focused scripts invoked with plain `node` import `lib/types/`; run
`pnpm build` first. Scripts that import TypeScript sources declare the
`node --import tsx/esm <script>` form in their header. Do not infer the input
layer from the file extension: `verify-themes.mjs`, for example, imports
`src/` through `tsx`.

Some scripts are forensic or interactive tools, not bounded tests. In
particular, heap/leak scripts, PTY probes, replay capture, performance probes,
and `scripts/run.ts` can require a specific OS, terminal, native dependency,
DSH checkout, or long-running process. Read the header and prerequisites; do
not run every file in `scripts/` as a blanket suite.

For terminal-visible changes, headless assertions are necessary but not always
sufficient. When the environment is available, manually exercise the affected
flow in both inline and fullscreen modes and at a narrow terminal width. Check
startup, resize, scrolling, input, cancellation, and clean exit. Windows
ConPTY, tmux, OSC clipboard behavior, and synchronized output have distinct
paths, so use the matching probe when changing one of them.

`pnpm tui` invokes `scripts/run.ts`, which assumes the package lives inside a
DeepSeek Harness monorepo layout with `apps/cli` and `packages/*`. It is not a
portable standalone smoke command. For an end-user integration check, install
the plugin into a DSH profile and run `dsh --profile dsh-tui` in a real TTY with
the required credentials.

## TypeScript And Style

- The package is ESM. Relative imports in TypeScript use `.js` specifiers,
  for example `import { Chat } from './screens/Chat.js'`. Preserve this rule.
- In repository-authored TypeScript, follow the prevailing style: two-space
  indentation, single quotes, no semicolons, and trailing commas in multiline
  constructs. The ported Ink files may retain their upstream tabs or quoting;
  do not mass-format them.
- Prefer `import type` for type-only dependencies.
- Do not introduce `any` merely because `tsconfig.json` relaxes
  `noImplicitAny`. Those relaxations exist to compile the ported Ink core and
  must not become the quality bar for new application code. Use `unknown` and
  narrow it, or define a small structural interface at an external seam.
- Preserve readonly data where the surrounding API uses it. Keep state
  mutations inside the channel/store implementation rather than mutating
  values from components.
- Keep exported APIs documented with concise JSDoc. Explain contracts and
  non-obvious invariants, not line-by-line mechanics.
- Avoid one-use abstractions and unrelated refactors. Inline a trivial helper
  when it has one call site and does not clarify a real invariant.
- Preserve initialization ordering around environment-sensitive imports.
  `FORCE_COLOR`, `NODE_ENV`, and terminal capability flags are often read at
  module evaluation time; moving an import above their setup can change
  behavior without a type error.

## Architectural Invariants

### Cordis Lifecycle And Configuration

- Keep `src/index.ts` as the small public plugin contract and `src/plugin.ts`
  as the runtime implementation. Preserve the lazy handoff unless the task
  intentionally changes the plugin-loading contract.
- Register resources through Cordis and clean them up through `ctx.effect` or
  the existing single exit funnel. A render failure must remain loud and
  non-zero; normal exit must restore terminal state before process exit.
- `cordis.patch.yml` is layered over `dsh-base`. Do not duplicate a service row
  that the base already mounts. Distinguish an ID override from an `insert`,
  and preserve ordering when one service depends on another.
- A profile override replaces an entire `config` block. When documentation
  shows an override, include every key that must survive the replacement.
- When adding or renaming a plugin option, update the `Config` interface and
  Schema in `src/index.ts`, its consumption in runtime code, the applicable
  rows in `cordis.patch.yml` and `cordis.yml`, and both READMEs.

### Session And Channel State

- The durable DSH session event log is the transcript source of truth. Rows are
  replayed/projected from events; do not insert optimistic assistant or tool
  facts that can diverge from persistence.
- Preserve event ordering, sequence anchors, and call-ID matching. Rewind,
  resume, folding, tool result association, and exports depend on them.
- Every observable channel mutation must use the appropriate synchronous or
  frame-coalesced emitter so `version` advances and subscribers are notified.
- Keep long-session memory bounded. Do not remove transcript folding, replay
  coalescing, virtualization, or cache limits without a measured replacement.
- Agent changes such as resume, rewind, model switch, and preset switch must
  reset all session-scoped projections together. Audit rows, goals, todos,
  titles, pending messages, metrics, and loaded context for stale state.
- Resolve agent/model/tool/preset capabilities through the mounted DSH
  services and registries. Do not guess external API shapes; inspect the
  installed package types when changing an integration.

### Interaction And Commands

- Keyboard precedence is behavior, not incidental control flow. A focused
  questionnaire or modal consumes its keys before global handlers; mouse text
  selection consumes Escape before rewind/clear behavior; the prompt owns text
  editing only when no overlay is active.
- Do not hardcode a new shortcut in one component and stop there. Update the
  relevant help UI and both README shortcut tables, and add or extend a
  regression for conflicts with existing modes.
- Local slash commands are declared in `src/commands.ts` and dispatched in
  `Chat.tsx`; registry commands are merged at runtime. When adding a command,
  update declaration, dispatch, help/documentation, the i18n description
  (`cmd-desc-<name>` in `src/i18n.ts`, zh only — en falls back to the
  declaration), and any packaged skill mapping together.
- Skill command spelling is not always the directory spelling. For example,
  the local `/pr_comments` command activates the packaged `pr-comments` skill.
  Preserve explicit mappings and host naming constraints.
- Keep `ask_user_question` serialized through `QuestionStore`; concurrent
  questions are intentionally presented FIFO and summarized after completion.

### Terminal Rendering

- Prefer themed primitives and hooks exported by `src/ui.ts`. Reach into
  `src/ink/` only for behavior that the facade intentionally does not expose.
- Terminal width is display-cell width, not JavaScript string length. Account
  for ANSI escapes, combining characters, emoji, and East Asian wide glyphs;
  use the repository's width, slicing, wrapping, and ANSI helpers.
- Keep frame output buffered and normal runs quiet. Do not add `console.log` or
  stdout diagnostics while the TUI is active. Use an opt-in stderr/debug path
  such as `DSH_TUI_DEBUG`, or the existing `DSH_TUI_RENDER_LOG` frame capture.
- Preserve raw-mode, cursor, alternate-screen, synchronized-output, mouse,
  focus, and terminal-query cleanup on success, error, interrupt, and teardown.
- Avoid render-time unbounded collections or per-token/per-frame allocations.
  Streaming sessions are long lived, and this repository has explicit
  regressions for prior OOM and scroll-performance failures.
- Layout changes must not allow transcript content to displace the input and
  status line. Exercise resize storms, long unbroken content, streaming rows,
  scrolled-up state, and sticky-bottom restoration when those paths change.
- Keep platform detection narrow. Windows Terminal/ConPTY, WSL, tmux, VS Code,
  and terminals with or without truecolor/DEC 2026 support follow different
  protocol paths.

### Preferences, Themes, And Files

- Follow the existing precedence for configurable preferences: explicit
  deployment config or environment override, then persisted user choice, then
  detected/default value. Document any change to that order.
- Persist user data beneath the existing `~/.dsh-tui` locations. Validate and
  safely parse external JSON; malformed optional state should warn or fall
  back rather than crash the TUI.
- Treat theme names and file contents as untrusted input. Preserve path
  containment checks and all-or-nothing validation of malformed theme files.
- Keep theme additions complete across the `Theme` contract and every built-in
  palette. Use semantic theme keys in components instead of isolated literal
  colors.

## Cross-File Change Checklist

| If you change | Keep these in sync |
| --- | --- |
| Plugin config or environment behavior | `src/index.ts`, runtime consumer, `cordis.patch.yml`, `cordis.yml`, `README.md`, `README_EN.md` |
| Slash commands or shortcuts | `src/commands.ts`, `src/screens/Chat.tsx`, help/input components, both READMEs, relevant skill mapping/tests |
| Theme contract or persisted theme behavior | `src/theme.ts`, all palettes, theme provider/picker, custom-theme parser, theme verification, both READMEs |
| Session/channel behavior | `src/channel.ts`, affected UI projections, compiled output, focused channel/replay regression |
| Renderer/layout behavior | `src/ink/` or Yoga source, compiled output, CI regressions, focused scroll/resize/PTY probe |
| Packaged skill | `skills/<name>/SKILL.md`, `src/packaged-skills.ts` assumptions, command prompt/mapping if exposed as a slash command |
| User-facing documented behavior | Chinese and English READMEs, plus config comments/help text where applicable |
| Package version or dependency | `package.json`, `pnpm-lock.yaml`, generated/published artifacts as applicable; do not churn the legacy npm lock incidentally |

## Git And Release Safety

- The worktree may contain another person's changes. Inspect `git status` and
  relevant diffs before editing, preserve unrelated changes, and never discard
  work you did not create.
- Do not run destructive cleanup commands such as `git reset --hard`,
  `git checkout .`, or `git clean -fd`. Do not use `git stash` to hide another
  session's work.
- Stage explicit paths only; never use `git add .` or `git add -A` in a shared
  worktree.
- Do not commit, tag, push, publish, or create a release unless the user asks.
- Publishing is tag-driven. `.github/workflows/publish.yml` requires a `v*`
  tag whose version exactly matches `package.json`, then builds, runs focused
  regressions, and publishes to npm. Treat version changes and tags as release
  operations, not routine cleanup.
- Before handing off a code change, inspect `git diff --check`, the source diff,
  the generated diff, and `git status`. Report exactly which verification ran
  and any platform or credential-dependent checks that could not run.
