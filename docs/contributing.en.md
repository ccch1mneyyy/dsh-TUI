# Contributing

[Documentation index](README.md) · [简体中文](contributing.md)

Thanks for considering contributing to dsh-TUI! This guide is the shared
development contract for humans and coding agents working on `@deepseek-harness-tui/dsh-tui`.

## How To Contribute

- **Report bugs** through the bug issue form: version, terminal environment,
  and a minimal reproduction.
- **Request features** in [Discussions Ideas](https://github.com/ccch1mneyyy/dsh-TUI/discussions/new?category=ideas).
  Issues do not accept feature requests. Accepted proposals get a tracking issue,
  and its assignee owns the implementation. **Do not start writing code before the
  proposal is accepted** — OAuth, `/cost`, notifications, a plugin API and a remote
  runtime were each written in full and then closed.
  If a maintainer has not responded within 14 days, you may open a PR directly; it
  gets the `unreviewed-proposal` label and is treated as unreviewed.
- **Open a pull request** against `main`. Keep changes focused: one logical
  change per PR, with a Chinese or bilingual title and a description that
  covers motivation, what changed, and how it was verified.
  **A pull request that changes code must link an issue**: add a `Closes #<issue>`
  line to the description, or link it through the Development sidebar. The
  `issue-link` CI group checks this and fails without a link. Docs-only changes
  are exempt (same routing as the build and regression groups); for a maintainer
  release, revert, or CI hotfix that genuinely has no issue to link, apply the
  `no-issue-needed` label.
- **Run the verification matrix** below before requesting a review; CI runs
  the same commands.
- New features should include or extend a focused regression script.

### When the feature proposal flow takes effect

It applies only to pull requests opened on or after 2026-08-24. Pull requests
already open before that date follow the previous rules and need no Discussion
or tracking issue.



## Scope

This file applies to the entire repository. It is the shared development
contract for humans and coding agents working on `@deepseek-harness-tui/dsh-tui`.

`@deepseek-harness-tui/dsh-tui` is a single-package, ESM-only TypeScript project. It provides a
React terminal UI front door for DeepSeek Harness through Cordis. The package
owns the TUI, its local command surface, and a ported Ink/Yoga renderer.
DeepSeek Harness owns the agent, session, model, tool, skill, persistence,
and policy domains that the TUI consumes.

Before making a broad change, read `package.json`, the relevant README section,
and every source file being edited. Prefer the repository's existing service
boundaries and helpers over introducing parallel abstractions.

## Repository Map

- `src/index.ts`: public Cordis plugin entry point, configuration schema, and
  lazy handoff to the runtime plugin.
- `src/dsh-adapter/plugin.ts`: TTY validation, service registration, agent creation/resume,
  React tree mounting, and terminal/process teardown.
- `src/dsh-adapter/questions-answerer.ts` and `preset-resolution.ts`: isolate
  upstream prerelease dispatch for user questions and agent presets so version
  branches do not spread into bootstrap or channel actions. Note: the
  questionnaire "provider seat"
  guard (DUPLICATE_PROVIDER probe + private symbol check, #586) only applies to
  the legacy rc `registerProvider` path. On the 0.1.2 line's `user-questions/request`
  waterfall, Cordis first scope-filters requests carrying an agent; agentless
  `/auth` requests are dispatched without a scope carrier. Under the answerer
  convention, the first eligible listener that returns instead of delegating
  with `next()` claims the request. Cordis waterfall is around middleware,
  however: an outer listener can call `next()` and then observe, replace, or
  reject the downstream result, while `{ prepend: true }` inserts a listener
  at the front. Upstream offers no supported way to discover or reserve a
  verifiably exclusive claimant, so the legacy seat guard and its warning
  cannot be reproduced locally.
- `src/dsh-adapter/channel.ts`: event-to-view projection and the non-React action surface.
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
- `.agents/skills/*/SKILL.md`: project skills for repository maintainers,
  discovered by the DSH filesystem provider and excluded from the npm package.
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
  -> src/dsh-adapter/plugin.ts
  -> DSH agent/session services
  -> src/dsh-adapter/channel.ts (session events -> Channel snapshot)
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
  The `packageManager` field in the root `package.json` is the single source of
  truth for the pnpm version; both CI and corepack read it from there.
- Install a clean checkout with:

  ```sh
  git clone --recurse-submodules https://github.com/ccch1mneyyy/dsh-TUI.git
  cd dsh-TUI
  pnpm install --frozen-lockfile
  ```

  In an existing checkout, run `git submodule update --init --recursive` first.
  `vendor/dsh-std` and `dsh-auth` are workspace / `link:` dependencies, so the
  install always fails while those submodules are empty.

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
contract, and patch surface. The `prepare` lifecycle serves **source-checkout
bootstrapping only** (it fails fast when the vendored submodules are absent —
see scripts/prepare-guard.mjs); Git URL dependency installs have been triply
blocked since vendoring (#308: workspace deps / submodules / pnpm ≥11's
prepare allowlist) and are unsupported — install the registry package. Local
and CI workflows use explicit commands instead of depending on whether pnpm
implicitly runs the root lifecycle.

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
| Compaction × session-switch lifecycle (cancel before the fork snapshot, persistence-classified toast) | `node --import tsx/esm scripts/verify-compact-switch.tsx` |
| Theme loading, persistence, and runtime plugin seam | `node --import tsx/esm scripts/verify-themes.mjs`, `node --import tsx/esm scripts/verify-runtime-themes.ts` |
| Scrolling/sticky-bottom behavior | `node scripts/verify-scroll.mjs`, `node scripts/verify-resticky.mjs`, and the matching `repro-*` harness |
| Long plan-review body (`exit_plan_mode` windowing + wheel) | `node --import tsx/esm scripts/verify-plan-review-scroll.tsx` |
| Fullscreen copy-on-select | `node scripts/verify-copy-on-select.mjs` |
| Component-level mouse drag protocol (target capture, bubbling, click/selection compatibility, interrupted-session cleanup) | `node --import tsx/esm scripts/verify-drag-protocol.tsx` |
| Mouse pointer event pipeline (wheel coords/modifier bits, click/hover dispatch, out-of-bounds clamping, pointer-state reset) | `node --import tsx/esm scripts/verify-pointer-events.ts` |
| Hover event performance (complete interest boundaries, no-interest rect fast path, frame/multi-root invalidation) | `node --import tsx/esm scripts/verify-hover-coalesce.tsx` |
| Prompt-input mouse selection editing (drag/Shift+click/double-click word select, delete/replace, layered Esc, Ctrl+C copy, CJK wide cells, fold-side clamping) | `node --import tsx/esm scripts/verify-input-selection.tsx` |

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

- Keep `src/index.ts` as the small public plugin contract and `src/dsh-adapter/plugin.ts`
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
  declaration), and any related skill mapping together.
- Skill commands stay out of LOCAL_COMMANDS: user-invocable skills discovered by
  DSH are merged from the registry as dispatch commands. Names must be parseable
  kebab-case and must not collide with a local command.
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
- Treat theme names, plugin descriptors, and file contents as untrusted input.
  Preserve path containment checks, plugin ID constraints, activation cleanup,
  and all-or-nothing validation of malformed theme files.
- Keep theme additions complete across the `Theme` contract and every built-in
  palette. Runtime themes must use the `tuiThemes` seam; plugins must not rewrite
  `~/.dsh-tui/themes/` or bypass the managed extension service. Use semantic
  theme keys in components instead of isolated literal colors.

## Cross-File Change Checklist

| If you change | Keep these in sync |
| --- | --- |
| Plugin config or environment behavior | `src/index.ts`, runtime consumer, `cordis.patch.yml`, `cordis.yml`, `README.md`, `README_EN.md` |
| Slash commands or shortcuts | `src/commands.ts`, `src/screens/Chat.tsx`, help/input components, both READMEs, relevant skill mapping/tests |
| Theme contract, plugin seam, or persisted theme behavior | `src/theme.ts`, `src/themeCatalog.ts`, `src/dsh-adapter/themes.ts`, all palettes, theme provider/picker, custom-theme parser, theme verification, both READMEs, plugin docs |
| Session/channel behavior | `src/dsh-adapter/channel.ts`, affected UI projections, compiled output, focused channel/replay regression |
| Renderer/layout behavior | `src/ink/` or Yoga source, compiled output, CI regressions, focused scroll/resize/PTY probe |
| Skill discovery or presentation | DSH adapter, slash-command merge, `/skills`, and focused regressions; maintainer-only skills live in `.agents/skills/` and must stay out of npm |
| User-facing documented behavior | Chinese and English READMEs, plus config comments/help text where applicable |
| Package version or dependency | `package.json`, `pnpm-lock.yaml`, generated/published artifacts as applicable; do not churn the legacy npm lock incidentally |
| Upstream validated-line bump | `src/dsh-adapter/contract.ts`, both peer and dev ranges in `package.json`, bundled `dsh-auth/package.json` and `dsh-auth/pnpm-lock.yaml`, `pnpm-workspace.yaml`, the upstream SHA in the `alpha-compat` job of `.github/workflows/ci.yml`, the version constants in `scripts/verify-{alpha-source,patch-surface,web-coexistence,upstream-contract}`, `patch-surface.snapshot.json`, `ADAPTER.md`, `docs/user-guide.md`; steps in the upgrade section of [ADAPTER.md](../ADAPTER.md) |

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
- Release notes credit contributors. Create GitHub Releases with
  `gh release create vX.Y.Z --notes-file notes.md --generate-notes`: the
  hand-written summary comes first, and GitHub appends What's Changed (PR
  title + author + link), New Contributors, and the Full Changelog;
  `.github/release.yml` excludes bots from the generated list. In the
  hand-written summary, entries from external contributors end with
  `(#PR by @user)`; the maintainer's own entries are unmarked. Write bare
  `#123` and `@user` — GitHub renders them as links.
- Before handing off a code change, inspect `git diff --check`, the source diff,
  the generated diff, and `git status`. Report exactly which verification ran
  and any platform or credential-dependent checks that could not run.
