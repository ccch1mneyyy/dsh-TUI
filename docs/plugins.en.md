# Plugin Development Guide

[Documentation index](README.md) · [中文](plugins.md)

This guide is for developers who want to build plugins and extensions in the
dsh-TUI ecosystem. `@deepseek-harness-tui/dsh-tui` is a single-package,
ESM-only TypeScript project mounted into DeepSeek Harness through Cordis.
The relationship between the core package and ecosystem plugins: **the core
owns interaction and presentation only; plugins add capabilities on top of the
existing seams**.

Ecosystem starting points:

- Plugin author guide (this document)
- Organization: [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) (home
  of community plugins and templates)
- Template repository: [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)
- Reference implementation: `dsh-working-activity` (live working-status line
  with two outlets: TUI prompt slot + session events)

## Plugin Shapes

The dsh-TUI ecosystem has three plugin shapes, in increasing difficulty:

| Shape | Example | Code required |
| --- | --- | --- |
| Static asset | Theme JSON (`~/.dsh-tui/themes/<name>.json`) | No |
| Packaged skill | `skills/<name>/SKILL.md` shipped in the package | No (Markdown only) |
| Cordis runtime plugin | `dsh-working-activity` | Yes (TypeScript) |

This guide focuses on runtime plugins (the most capable shape); static assets
are covered by [Themes](themes.en.md) and the skill seam below.

## Plugin Contract

Every runtime plugin is a Cordis plugin exporting exactly three surfaces:

```ts
export const name = 'my-plugin'          // the id Cordis rows use
export type Config = { … }               // configuration type
export const Config: Schemastery<Config> = Schema.object({ … })  // configuration schema
export function apply(ctx: Context, config: Config): void { … }  // entry point
```

- **No default export**; the package root exports only these three surfaces.
- Every config key must have a default (`Schema.…().default(…)` or a `??` fallback
  inside `apply`). A missing plugin must degrade to "nothing happens", never
  fail TUI boot.
- Clean up resources through `ctx.effect(() => () => { … })` so disposal happens
  when the fiber unloads.
- Probe optional seams with `ctx.get('service', false)` and degrade silently
  when absent — never throw.

Minimal `package.json` skeleton (full reference:
[dsh-working-activity](https://github.com/ccch1mneyyy/dsh-working-activity)):

```jsonc
{
  "name": "my-plugin",
  "type": "module",
  "main": "lib/types/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/types/index.js" } },
  "files": ["lib", "skills"],
  "engines": { "node": "^22.19 || >=24" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

TypeScript relative imports must carry the `.js` suffix (ESM); build with `tsc`
into `lib/types/`.

## Community Consensus Spec (v0.15)

dsh-TUI aligns with the community ecosystem meta-protocol
[T-Auto/dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec)
v0.15. The essentials:

- Contracts are identified by **coordinates** (`apiVersion + kind`, e.g.
  `commands.dsh/v1alpha1` + `Command`); the registry pins a `schemaHash` per
  contract, and a host declaration that disagrees with the registry is treated
  as unavailable (fail closed).
- A plugin manifest (`dsh-plugin.json`) declares `facets.host` (entry +
  apiVersion), `requires.contracts` (optional references must carry a
  fallback), `permissions`, and `subscriptions`; `provides`/`services` and
  client/worker facets are rejected outright in v0.15.
- A host publishes a **Host Descriptor** stating its contract surface, facet
  versions, and `runtime.generationId`.
- Negotiation yields five states: `compatible / compatible_degraded /
  waiting_authorization / rejected / unknown`, with priority
  `unknown > rejected > waiting_authorization > compatible_degraded >
  compatible` — a reference outside the registry is answered `unknown`, not
  `rejected` (unjudgeable is not the same as judged incompatible).

What lives in this repository:

- `ecosystem-spec/` — vendored read-only data (registry / schemas /
  conformance fixtures); the sync baseline and update flow are documented in
  that directory's README. After an upstream update, overwrite the tree and
  run `npm run verify:plugin-spec` as the drift alarm (schemaHash recompute +
  the full fixture matrix).
- `src/plugin-spec/` — a zero-dependency validation/negotiation library: a
  JSON Schema checker (the subset used by the vendored schemas),
  `validatePlugin`/`validateHost` semantic checks, the five-state `negotiate`,
  and registry/contract-profile self-checks. Proven fixture-by-fixture
  equivalent to the upstream conformance reference implementation (38 battery
  assertions).

**Boundary declaration**: plugin discovery, installation, and loading belong
to the dsh CLI (the `@deepseek-ai/dsh` Loader) — **load-time enforcement is
not in this repository**. What this repository provides is the validation
library, a diagnostics surface, and runtime degradation: a non-compliant
plugin simply does not get contract capabilities inside the TUI. The trust
model is trusted-in-process (C-070): grants are a behavioral constraint, not
a security boundary.

Current alignment status: the validation/negotiation library, vendored data,
the unified grant store, and Host Descriptor construction are in place; the
`storage.local` / `messages.observe` contract surfaces, the effect ledger,
and the `/plugins` diagnostic command follow in later batches.

The grant store (`~/.dsh-tui/extension-grants.json`) answers for all 8
registered permissions with defaults driven by the vendored permission
registry (7 default deny; `commands.invoke` defaults allow — a plugin cannot
read anything passively with it alone). The `grants` section explicitly
grants deny-default permissions; the optional `denies` section revokes
allow-default ones; unregistered permission names are always denied (even if
explicitly granted in the file); an unparseable file denies everything,
including allow-default permissions (fail closed):

```json
{
  "grants": { "my-guard": ["session.input.intercept"] },
  "denies": { "noisy": ["commands.invoke"] }
}
```

The `dsh-tui-plugin-host` row (already in cordis.patch.yml, ahead of the
extensions row) provides `ctx.tuiPluginHost`: the runtime generationId
(C-050, one UUID per activation), the unified grant store instance, Host
Descriptor construction (advertising only contracts the running code
actually provides; a drifted vendored contract file is dropped fail-closed
with a warning), and the registry self-check. Consumers always soft-probe
with `ctx.get('tuiPluginHost', false)` (#183 discipline); the service never
enters any inject list.

## Seam Overview

| Seam | Shape | Purpose |
| --- | --- | --- |
| 1 · Session events | cordis events | Observe model/session state; append log-only events |
| 2 · TUI prompt slots | official host service | Prompt-line slots in the official TUI (not provided by dsh-TUI) |
| 3 · Packaged skills | static asset | Ship SKILL.md with the package |
| 4 · Themes | static asset | JSON color schemes |
| 5 · System prompt sections | cordis service | Inject stable prompt sections |
| 6 · Settings sections | `ctx.tuiSettingsSections` | Declarative `/settings` editing cards |
| 7 · Profile composition | cordis.patch.yml | Install/config rows |
| 8 · Full-screen scenes | `ctx.tuiScenes` | Whole-terminal React pages (the `/trace` shape) |
| 9 · Decision events | cordis serial/parallel events | Intercept/rewrite input, rewind, session switches, compaction |
| 10 · Managed dialogs | `ctx.tuiDialogs` | select / confirm / input modals |
| 11 · Status line | `ctx.tuiStatus` | Keyed status-line contributions above the prompt |
| 12 · Keyboard shortcuts | `ctx.tuiShortcuts` | Register global combos |
| 13 · Entry renderers | `ctx.tuiRenderers` | Custom session events → transcript text rows |

Seams 9–13 together are the **extension surface** (dsh-tui-extensions). One
import brings the type augmentations (the four services on `Context`, the
decision events on `Events`):

```ts
import type {
  TuiInputEvent, TuiInputDecision,
  TuiRewindPromptEvent, TuiRewindPromptDecision, TuiRewindMode, TuiRewindDoneEvent,
  TuiSessionSwitchEvent, TuiSessionSwitchDecision, TuiSessionSwitchedEvent,
  TuiCompactEvent, TuiCompactDecision,
} from '@deepseek-harness-tui/dsh-tui/extensions'
```

The four services are mounted by the main package's `dsh-tui-extensions` row
(already in cordis.patch.yml) — plugins must not mount their own copy. Always
consume through `ctx.get('tuiDialogs', false)`-style soft probes: an older
profile may lack the row, and a missing optional service must degrade
silently, never block startup (the #183 principle).

Standing discipline for the whole extension surface (not repeated per seam):

- **Locals win**: a plugin shadows nothing built in — reserved shortcut
  combos, built-in event types, and built-in commands all take precedence;
  conflicting registrations are refused with a warning, never a throw.
- **Render-path strings are untrusted input**: the host strips C0/C1 control
  characters, collapses whitespace, and truncates by terminal CELL (never
  `string.length`). Scalars only — string/number/boolean values are coerced
  to strings; objects/arrays and other non-scalars are **dropped or refused**
  (they never appear on screen as `"[object Object]"`). Decision-event
  reason/notice/summary toasts go through the same sanitization. There is
  exactly one implementation — `src/dsh-adapter/sanitize.ts` — shared by
  every seam.
- **A crashing plugin never takes the TUI down**: listener/handler exceptions
  are caught, logged, and treated as "no opinion" or "skip this entry". A
  decision event still pending after ~400ms surfaces a "waiting for a plugin
  decision" parked indicator (RFC 0005 D-8), so a slow plugin never makes the
  UI look dead. The indicator stays up until the decision SETTLES (it never
  auto-expires mid-wait): as long as the flow is parked, the wait is visible.

## Seam 1: Session Events (consumed natively by dsh-TUI)

dsh-TUI's Channel projects durable session events into the transcript.
**Session events are the source of truth**: `session/event` and `agent/status`
are the standard entry points for observing model state.

```ts
ctx.on('session/event', (session, event) => {
  // event.type: 'turn/start' | 'assistant/chunk' | 'tool/call' | 'tool/result' | 'turn/end' | …
})
ctx.on('agent/status', ({ agent, status }) => { /* agent.session, status */ })
ctx.on('session/disposed', (session) => { /* clean up per-session state */ })
```

### Appending your own log-only events: two hard rules

Plugins can append their own event types with `session.append(type, payload)`
for other UIs to consume (that is how dsh-TUI consumes `activity/status`).
But two hard rules apply — violating them makes the whole session
**unresumable**:

1. **Log-only events only** (no `surfaceOp`): the model must never see them;
   they are UI state only.
2. **Register the event type**: dsh-session's strict read paths refuse logs that
   contain unknown non-ignorable event types. Since `session.append()` exposes
   no ignorable flag, the plugin must add its type to `KNOWN_SESSION_EVENT_TYPES`
   of **every reachable** dsh-session copy, exactly like
   `dsh-working-activity/src/registration.ts` does (anchors: `import.meta.url`
   and `process.argv[1]`; idempotent, never throws).

Type it with a `declare module` merge:

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'my/event': MyEventPayload
  }
}
```

> dsh-TUI's profile carries its own compatibility repair
> (`src/compat/sessionLog.ts`) that patches third-party event types, so resume
> works in the dsh-tui profile regardless; bare compositions, Web, and other
> headless consumers have no such repair — registration is still mandatory.

## Seam 2: TUI Prompt Slots (host-provided seam)

The official DSH TUI host exposes slot registration on `ctx.tuiPrompt`. When
composed:

```ts
const prompt = ctx.get('tuiPrompt', false) as TuiPromptLike | undefined
const handle = prompt?.register('my-slot', undefined)  // { set(value?), dispose() }
handle?.set('live content')  // value of ${my-slot} in the template
```

Slot names appear in the `theme.leftPrompt` template (e.g.
`'${cwd}${git/worktree}${activity}${model}…'`); when the template lacks the
slot, the plugin silently has no effect.

Note: **dsh-TUI itself does not provide the `tuiPrompt` service** — it consumes
`activity/status` events directly to render the working line (see
`src/channel.ts` and `src/components/ActivityLine.tsx`). If your plugin targets
both the official TUI and dsh-TUI, adopt `dsh-working-activity`'s **dual-outlet**
pattern: the prompt slot for the official TUI, log-only events for dsh-TUI and
other consumers.

## Seam 3: Packaged Skills

Another zero-code outlet. Put `SKILL.md` under the package's
`skills/<name>/SKILL.md` and register it through the DSH skill registry from
`apply`:

```ts
const registry = ctx.get('skills') as SkillRegistryLike | undefined
registry?.register({
  name: 'my-skill',
  description: 'one-line description (single-line scalar frontmatter)',
  content: 'SKILL.md body',
  path: 'skills/my-skill/SKILL.md',
  provider: 'my-plugin',
  source: 'bundled',
})
```

See the core package's `src/packaged-skills.ts`: single-line scalar frontmatter
(`name`, `description`); duplicate or invalid entries are skipped — **a skill
registration failure must never take down TUI boot**. Once registered, the skill
is usable through DSH's `/skill` surface.

## Seam 4: Themes (static asset, zero code)

Users drop JSON into `~/.dsh-tui/themes/<name>.json` for hot switching:

```json
{
  "name": "sakura",
  "displayName": "Sakura Pink",
  "base": "dark",
  "colors": { "claude": "#FF9EC7", "text": "#E8E6E0", "selectionBg": "#5C3A44" }
}
```

- `base` (`light`/`dark`/`dark-ansi`) is the required source for uncovered
  colors; `colors` is a partial override of the `Theme` semantic keys; the full
  key table lives in [`src/theme.ts`](../src/theme.ts).
- Theme files are treated as **untrusted input**: unknown keys and invalid
  colors are skipped with a warning, broken files are discarded whole, and names
  must not escape the theme directory — your theme plugin must honor the same
  tolerance.
- Full contract: [Themes](themes.en.md).

## Seam 5: System Prompt Section Injection

Stable prompt sections ride the `systemPrompt` service and are removed with the
plugin fiber:

```ts
ctx.inject(['systemPrompt'], (promptCtx) => {
  promptCtx.systemPrompt.section({
    name: 'my-plugin:narrate',
    order: 60,          // section ordering; avoid clashing with existing sections
    text: '…',
  })
})
```

Injected content enters every request's system prompt (counts toward
context/tokens) and **affects KV-cache stability by default** — inject only when
necessary, and keep the text fully stable.

## Seam 6: Plugin Settings Sections (tuiSettingsSections)

A plugin with a config namespace can declare an editable section on the
`/settings` screen (issue #165). The contract is **declarative**: the plugin
only describes WHICH fields are editable; rendering, staged editing,
save/discard and revision-conflict retries are all owned by the TUI host.
Storage, schema validation and layer resolution stay with the dsh settings
service (the kernel) — the TUI only presents.

```ts
import type { TuiSettingsSection } from '@deepseek-harness-tui/dsh-tui/settings-sections'

ctx.inject(['tuiSettingsSections'], (settingsCtx) => {
  const unregister = settingsCtx.tuiSettingsSections.register({
    ns: 'my-plugin',            // same namespace as ctx.settings.register
    title: 'My plugin',         // English title (also the fallback copy)
    descriptions: { zh: '我的插件' },
    fields: [
      { path: ['enabled'], label: 'Enabled', kind: 'boolean' },
      { path: ['limit'], label: 'Retry limit', kind: 'number', hint: 'Attempts before giving up' },
      { path: ['mode'], label: 'Mode', kind: 'select', options: [
        { value: 'fast', label: 'Fast' },
        { value: 'safe', label: 'Safe' },
      ] },
      // Secret fields never ride the settings document — a blank draft writes
      // nothing; a typed draft writes through the credentials seam.
      { path: ['apiKey'], label: 'API key', kind: 'text', secret: { ref: 'MY_PLUGIN_API_KEY' } },
    ],
  } satisfies TuiSettingsSection)
  ctx.effect(() => () => unregister())
})
```

Semantics (aligned with the web front door's plugin settings cards):

- Editing is **staged**: typing only changes a draft; `s` saves it as one
  revision-fenced `settings.mutate` of path ops (a conflict retries once with
  the fresh revision).
- A field's "overridden" badge reads **presence in the user layer** (equal to
  the default still counts); clearing a text field stages an `unset`, letting
  the field re-inherit the composition layer.
- `kind` currently supports `text` / `number` / `boolean` / `select`; deeply
  nested structures (dict/array editors) are not supported yet — users can
  still hand-edit `~/.dsh/settings.yaml`, and namespaces without a declared
  section render read-only with that YAML hint.
- When the namespace is not served (the plugin registered no settings
  section), the section shows as unavailable rather than failing.

## Seam 7: Profile Composition (cordis.patch.yml)

Plugins declare the rows they insert/override in the profile through their own
`cordis.patch.yml`:

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: 'my-plugin'
      config:
        myKey: myValue
```

Rules (same as the core `cordis.patch.yml`):

- An override row (`- id: …` without `insert`) **replaces the target row's whole
  `config`** — restate every key that row owns, not just the one you change.
- Rows are order-sensitive; add new rows inside `insert` and never re-mount
  service rows dsh-base already provides.
- Verify against a real profile before publishing:
  `dsh plugin --profile dsh-tui add my-plugin`, then run
  `dsh --profile dsh-tui` in a real TTY.
- Known pitfall: pnpm's isolated node_modules inside a profile does not link
  **transitive** dependencies into the profile root, which is why the core
  package re-exports its working-status plugin as the
  `@deepseek-harness-tui/dsh-tui/working-activity` subpath before mounting it.
  If your plugin is meant to be composed by other bundles, provide the same
  explicit subpath export.

## Seam 8: Plugin Full-Screen Scenes (tuiScenes)

A plugin can register a **full-screen React scene** with the TUI and open it
from its own slash command — the same "takes the whole terminal, hands it
back untouched" shape as `/trace` (the trajectory timeline) and `/settings`.
Command execution stays with dsh-commands (the `command/run`/`command/done`
pair is logged as usual); the TUI only provides the rendering surface and
keyboard ownership. Opening/closing a scene never touches the conversation
and appends no session events.

### Three steps

**1. Register the scene** (`id` is globally unique, kebab-case; duplicate or
invalid ids throw at registration):

```ts
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'

ctx.inject(['tuiScenes'], (sceneCtx) => {
  const dispose = sceneCtx.tuiScenes.register({
    id: 'my-dashboard',
    title: 'My dashboard',        // optional, for logs/debugging; the scene draws its own header
    component: MyDashboard,
  })
  ctx.effect(() => () => dispose())   // disposing the OPEN scene closes it
})
```

**2. Register the command that opens it** (execution and logging stay with
dsh-commands; the handler returns a silent `success`, leaving just the
command's own line in the transcript):

```ts
ctx.inject(['commands'], (commandCtx) => {
  const dispose = commandCtx.commands.register({
    name: 'dashboard',
    description: 'Open my dashboard',
    handler: () => {
      const opened = sceneCtx.tuiScenes.open('my-dashboard')
      return opened
        ? { kind: 'success' as const }
        : { kind: 'error' as const, text: 'dashboard scene is not registered' }
    },
  })
  ctx.effect(() => () => dispose())
})
```

**3. Write the scene component** — the props inject the host's `React` and
`ui` kit, and that is a **hard contract** (see the next section):

```tsx
// tsconfig: "jsx": "react-jsx",
//           "jsxImportSource": "@deepseek-harness-tui/dsh-tui"
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'

export function MyDashboard({ React, ui, channel, close }: TuiSceneProps) {
  // Hooks MUST come from the injected React; JSX goes through the host
  // jsx-runtime via jsxImportSource.
  const { Box, Text, useInput, useTerminalSize } = ui
  const { columns, rows } = useTerminalSize()
  // channel is reactive: subscribe to version like Chat does and the data
  // follows the session live.
  React.useSyncExternalStore(channel.subscribe, () => channel.version)
  // The scene owns the keyboard while open — conventions like Esc/q to
  // close are the scene's own job.
  useInput((input, key) => {
    if (key.escape || input === 'q') close()
  })
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Text bold>My dashboard</Text>
      <Text>{channel.rows.length} rows · {columns}×{rows}</Text>
    </Box>
  )
}
```

No JSX? `React.createElement(ui.Box, …)` is equally valid (`React` IS the
host instance, so `createElement`/`Fragment` are always safe).

### The React contract (read this — violations crash on first render)

The TUI's reconciler is **React 19**, and scene components run on the host's
React instance:

- **Hooks must come from the props-injected `React`.** A plugin importing its
  own React copy from node_modules and calling its hooks hits a dispatcher
  mismatch — invalid hook call on the very first render.
- **Elements must be created through the host runtime.** React 19's JSX
  factory emits `Symbol.for('react.transitional.element')` elements; JSX
  compiled against a plugin-bundled older React (18 and below) emits
  `Symbol.for('react.element')`, which the host reconciler rejects outright.
  So JSX authors must point tsconfig's `jsxImportSource` at
  `@deepseek-harness-tui/dsh-tui` (its `./jsx-runtime` subpath re-exports the
  host's own `react/jsx-runtime` verbatim), or stick to the injected
  `React`'s `createElement`. A plugin-owned React copy only produces legal
  elements when it is the SAME 19.x line — and its hooks remain off-limits
  regardless.

### Runtime semantics

- **Screen stack**: a plugin scene sits at the TOP of Chat's early-return
  chain — above `/settings`, the `/resume` browser, and the trajectory
  scene. Those screens stay mounted but yield the screen and the keyboard
  while a scene is open; `close()` lands back on whatever was up before.
- **Inline and fullscreen alike**: in inline mode the TUI wraps the scene in
  `<AlternateScreen>` for you (DEC 1049 enter/exit, frame churn never reaches
  scrollback); in fullscreen mode the host's alt screen is reused. Scene
  components must NOT nest another `<AlternateScreen>` themselves.
- **Async opens are safe**: handlers may be async and call `open()` after the
  command settles — the open rides the channel's version bump into a
  re-render, independent of the command's return timing.
- **Graceful degradation without the service**: probe with
  `ctx.get('tuiScenes')`; on an older patch without the `dsh-tui-scenes` row,
  `open()` warns and returns `false` and the TUI never opens a scene — a
  missing seam must never break startup (the #183 rule).
- **Lifecycle**: registration and open state do NOT reset on agent swaps
  (`/new`, `/resume`, rewind); `channel` always points at the live agent.
  Unmounting (closing) destroys the component's hook state — reopening is a
  fresh mount.

### Scene red lines

- The scene owns the WHOLE terminal while open: lay out with
  `flexGrow`/`useTerminalSize()` instead of assuming fixed dimensions, and
  never write to stdout (debug through `DSH_TUI_DEBUG`'s stderr).
- A scene is an OBSERVER of the session: read from `channel` (rows, tokens,
  working, traceEvents, …); writes (submit/steer/cancel) are available too,
  but opening/closing itself produces no session events — never append
  events from a scene; if you must emit, follow seam 1's log-only rules.
- Per-frame render cost is the scene's own budget: use
  `ui.useAnimationFrame` for motion, and keep synchronous I/O out of the
  render path.
- **Render-time exceptions are bounded**: an error thrown from the scene
  component's render/lifecycle is caught by `PluginSceneBoundary` — the
  transcript gets an error line, the scene closes itself, and the TUI keeps
  running. Errors inside effects and async callbacks are beyond the
  boundary's reach and remain the scene's own responsibility.

## Seam 9: Decision Events (tui/input · rewind · session-switch · compact)

pi-style before-events: the TUI hands plugins the decision BEFORE executing
key actions. Decision events are awaited listener-by-listener in registration
order, and the **first VALID decision wins** — unlike raw `ctx.serial`, the
host normalizes and isolates per listener:

- `undefined`/`null`/`false` means "no opinion"; the chain continues;
- **Malformed returns are not decisions** — a blank `{ text }` rewrite, a
  non-object value, an empty `modes` list, etc. are ignored with a warning
  and the chain CONTINUES (a buggy plugin can never skip a later safety
  veto);
- A throwing listener is skipped with a warning; the chain CONTINUES;
- All listeners declining means the default behavior proceeds.

The companion notification events (except `tui/rewind-done`'s summary return)
are **parallel**: after-the-fact broadcasts with no decision power.

### Contract table

| Event | Fired | Payload (all carry `sessionId`, `cwd`) | Return (first non-undefined wins) |
| --- | --- | --- | --- |
| `tui/input` | Before a user input is delivered (submit AND steer) | `text`, `delivery: 'followup'\|'steer'` | `{ text }` rewrite · `{ handled: true, notice? }` plugin took over · `{ cancel: true, reason? }` drop |
| `tui/rewind-prompt` | After a rewind target is confirmed, before any fork work | `text`, `seq` | `{ cancel: true, reason? }` veto (picker stays open) · `{ modes: TuiRewindMode[] }` extra rewind modes in the confirm pane (≤8, each needs `id`+`label`) |
| `tui/rewind-done` | Rewind finished, agent already swapped | `text`, `mode: string\|null`, `boundarySeq`, `sourceSessionId`, `childSessionId` | First non-empty `string` toasted as the summary (6s); other returns ignored |
| `tui/session-switch` | Before `/new` or `/resume` (zero side effects yet) | `kind: 'new'\|'resume'`, `targetSessionId?` | `{ cancel: true, reason? }` veto |
| `tui/session-switched` | After `/new`, `/resume`, or a rewind | `kind: 'new'\|'resume'\|'rewind'`, `sessionId`, `previousSessionId?` | Notification (parallel); returns ignored |
| `tui/compact` | Before `/compact` runs | — | `{ cancel: true, reason? }` veto |

Shared semantics:

- **Intercept subscriptions require an explicit grant (RFC 0005 D-7, default
  deny)**: a plugin subscribing to `tui/input`, `tui/rewind-prompt`,
  `tui/session-switch`, or `tui/compact` must hold the matching grant in
  `~/.dsh-tui/extension-grants.json`; otherwise the subscription never enters
  the decision chain (treated as unregistered) and a warning is logged.
  Permission names follow `domain.resource.intercept`:
  `tui/input` → `session.input.intercept`, `tui/rewind-prompt` →
  `session.rewind.intercept`, `tui/session-switch` → `session.switch.intercept`,
  `tui/compact` → `session.compact.intercept`. Notification-class events
  (`tui/rewind-done`, `tui/session-switched`) are not gated. The grants file
  is keyed by plugin name (the cordis row's `name` export):

  ```json
  { "grants": { "my-guard": ["session.input.intercept"] } }
  ```

  The file is read once when the gate is installed (BOTH the extensions row
  and the channel install it — idempotent per cordis root, first installer
  wins — so even a stale bundle patch missing the extensions row leaves the
  gate up: the channel installs it as the backstop and decision events never
  become allow-by-default); changing grants means editing the file and
  restarting. A missing file falls back to the registry defaults (intercept
  permissions default deny); an unparseable file denies everything, including
  allow-default permissions (fail closed). The file is the unified
  8-permission grant store (with a `denies` revocation section) — full
  semantics in the "Community Consensus Spec" section.
- **Ordering guarantee**: decisions and deliveries are serialized in
  submission order — a slow decision on an earlier input holds back the
  decision AND delivery of later ones, so the model always receives messages
  in the order the user submitted them. Every submission binds its origin
  session AT ENQUEUE: even when it runs only after a slow predecessor and
  the user has switched sessions by then, the stale input is dropped with a
  notice instead of reaching the new session.
- `cancel.reason` / `handled.notice` / the `tui/rewind-done` summary are
  toasted; the host supplies a localized fallback when absent (a bare
  `{ cancel: true }` / `{ handled: true }` never makes the typed line vanish
  silently). These texts are sanitized as untrusted input too (control chars
  stripped, ≤200 cells).
- A `{ text }` rewrite is trimmed; an empty result counts as "no opinion".
  The rewrite applies only BEFORE delivery — if the user switched sessions
  mid-await, the stale input is dropped with a notice (stale-drop) instead of
  leaking the old conversation's words into the new session. Same for
  `tui/session-switch` and `tui/rewind-prompt`: if another switch completed
  while the decision was parked, the stale switch/rewind request is dropped
  outright (compared by agent REFERENCE — session-id reuse cannot fool it).
- `tui/rewind-done` is dispatched DECOUPLED from the rewind result: the
  rewound message text returns to the draft immediately — a slow or
  never-settling summary listener neither delays the draft restore nor holds
  back the following `tui/session-switched`; the summary string toasts
  whenever the listener settles.
- Submit, steer, AND Ctrl+Enter (the interruptAndDeliver re-queue) all pass
  through `tui/input` — there is no send path that bypasses a plugin veto.
- `tui/rewind-prompt` modes render as a choice list in the confirm pane (the
  host's "Conversation only" entry always comes first); the picked mode id is
  echoed back in `tui/rewind-done`'s payload — the plugin performs the actual
  mode logic (e.g. restoring files) in the done listener.
- Be deliberate about slow work in decision listeners: `tui/input` sits in
  front of the delivery chain and genuinely delays sending; when you need to
  ask the user, use seam 10 (it exists for exactly this).

### Example: input guard + custom command output

```ts
import type { TuiInputEvent, TuiInputDecision } from '@deepseek-harness-tui/dsh-tui/extensions'

ctx.on('tui/input', (event: TuiInputEvent): TuiInputDecision | undefined => {
  // /my-command is handled by the plugin itself: no session, no model
  if (event.text.startsWith('/my-command')) {
    void runMyCommand(event.text.slice('/my-command'.length).trim())
    return { handled: true, notice: 'handed to my-command' }
  }
  // dangerous-phrase guard
  if (event.text.includes('rm -rf /')) {
    return { cancel: true, reason: 'my-guard: blocked by the safety policy' }
  }
  // shorthand expansion
  if (event.text === '@standup') {
    return { text: "Summarize yesterday's commits in this repo as a standup report" }
  }
  return undefined // no opinion — deliver as typed
})
```

## Seam 10: Managed Dialogs (tuiDialogs)

The `ctx.ui` equivalent from pi: plugins never touch rendering — they issue
requests and the TUI shows a modal panel above the prompt (owning the
keyboard while open), resolving the Promise with the answer. Concurrent
requests queue **FIFO**, one visible at a time.

```ts
const dialogs = ctx.get('tuiDialogs', false)

// Single choice: resolves the option id; cancel/Esc/timeout/abort → undefined
const id = await dialogs?.select({
  title: 'Pick one',
  options: [
    { id: 'fast', label: 'Fast mode' },
    { id: 'safe', label: 'Safe mode', description: 'One extra confirmation' },
  ],
  signal: abortController.signal,  // optional: external abort
  timeoutMs: 30_000,               // optional: auto-cancel (headless-embedder fuse)
})

// Confirm: resolves true/false; cancel counts as false (Esc and "No" are
// deliberately indistinguishable)
const ok = await dialogs?.confirm({
  title: 'Overwrite?',
  message: 'The target file already exists',
  confirmLabel: 'Overwrite',   // defaults fall back to the host's localized Yes/No
  cancelLabel: 'Keep',
})

// Single-line input: resolves the text; cancel → undefined
const name = await dialogs?.input({
  title: 'Give it a name',
  placeholder: 'Enter to confirm, Esc to cancel',
  initial: 'default-name',
})
```

Contract points:

- **Never throws**: malformed requests (no title, no valid options) resolve
  the cancelled value with a warning — the awaiting plugin always continues.
- Inputs are sanitized on arrival: control chars stripped, whitespace
  collapsed; title/label ≤120 cells, message ≤400, input ≤500, ≤100 options
  (truncated beyond). **Exception: a select option's `id` is not rendered** —
  it is only type/non-empty checked and returned VERBATIM. It is the opaque
  token the plugin matches against its own options; sanitizing it would hand
  back a different string for long or whitespace-carrying ids.
- Panel keys: ↑/↓ to move, Enter to confirm, Esc/Ctrl+C to cancel; `input`
  is a single-line editor inside the dialog (arrows/Home/End/backspace/
  delete), independent of the main prompt.
- Paste protection: a bracketed paste into the single-line input is flattened
  (newlines/control chars → spaces) and held to the same ≤500-cell cap as
  typed text; a paste that is all line breaks is NEVER read as Enter — the
  confirm's default focus cannot be tripped by one paste, likewise for
  select/input.
- When the service is absent (older profiles) `ctx.get` returns `undefined` —
  the plugin decides whether to skip interaction or fall back to a headless
  default; `timeoutMs` is the fuse for "service present but no TUI consumer".

Typical pairing: a decision-event listener that asks first —
`ctx.on('tui/rewind-prompt', async () => … await dialogs.select(…))` — then
returns its decision once the user answers.

## Seam 11: Status Line (tuiStatus)

Keyed status-line contributions — pi's `setStatus(key, text)`. All
contributions render as one line (joined with ` · `) above the prompt, in
first-set order:

```ts
const status = ctx.get('tuiStatus', false)
const dispose = status?.set('my-plugin', 'building 42%')   // set/update
ctx.effect(() => () => dispose?.())   // cleanup hangs on the CALLER's fiber
status?.set('my-plugin', undefined)        // clear explicitly ('' works too)
```

- Key rule: `/^[a-z][a-z0-9_-]*$/` (convention: the plugin name, or
  `plugin:sub-item`); at most 20 keys, text ≤200 cells; violations are
  refused with a warning, never a throw. Text is scalar-only
  (string/number/boolean coerced to string); a non-scalar is **refused**,
  not treated as a clear.
- **Lifecycle is the caller's responsibility** (same contract as
  tuiShortcuts/tuiScenes): the disposer returned by `set` clears the key only
  while it still holds exactly that text (a later set is unaffected by a
  stale disposer); without the `ctx.effect` scoping, an unloaded or
  hot-reloaded plugin leaves its line behind forever.
- The status line is DISPLAY-ONLY: for anything actionable use a shortcut
  (seam 12) or a scene (seam 8).

## Seam 12: Keyboard Shortcuts (tuiShortcuts)

pi's `registerShortcut`: bind a combo to a handler.

```ts
const shortcuts = ctx.get('tuiShortcuts', false)
const dispose = shortcuts?.register('ctrl+shift+p', {
  description: 'Open my panel',           // required — discoverability
  handler: () => { void openMyPanel() },
})
ctx.effect(() => () => dispose?.())       // cleanup hangs on the CALLER's fiber
```

Combo syntax: `ctrl`/`alt` (`meta`/`option` are synonyms)/`shift` plus one
character or a named key (`enter`, `esc`, `tab`, `backspace`, `delete`,
`up/down/left/right`, `home`, `end`, `pageup`, `pagedown`, `space`) — e.g.
`ctrl+shift+p`, `alt+k`, `ctrl+space`. **Exception: `escape` combos are
always refused** — the input layer sets `meta` on every Esc, so `alt+escape`
would match every bare Esc press (shadowing clear-input and the double-Esc
rewind); there is no unambiguous way to bind it.

Rules (all "refuse + warn, never throw"):

- **ctrl or alt is mandatory** — bare letters are typing, bare arrows are
  navigation.
- **Reserved combos are refused at registration**: the TUI's own bindings
  (ctrl+c/d/t/r/x/o/l/e/v/a/u/k/w, ctrl+←/→, ctrl/alt+Enter, alt+↑, Esc, Tab,
  Shift+Tab). This is the enforcement of "locals win": a collision can never
  reach the matcher. Built-ins match a MODIFIER SUBSET (`isMod && char`,
  never excluding an extra Shift), so SHIFT-SUPERSETS of reserved combos are
  refused too — `ctrl+shift+x` IS Ctrl+X on terminals that don't report
  Shift distinctly, and registering it would either shadow the built-in or
  never fire.
- Re-registering the same canonical combo is refused.
- Dispatch happens only in the PLAIN chat state: any overlay (pickers,
  approvals, questionnaires, managed dialogs, scenes, the session browser)
  owns the keyboard while open.
- Handlers are fire-and-forget: rejections are caught, toasted against the
  `description`, and logged — one bad handler never breaks the keyboard for
  everyone else.
- The returned dispose is scoped by the CALLER with its own `ctx.effect`
  (same contract as tuiScenes) — a service method cannot see the caller's
  fiber.

## Seam 13: Custom Entry Renderers (tuiRenderers)

pi's `registerMessageRenderer`: a renderer maps the log-only session events a
plugin appends through seam 1 (`session.append('my-plugin/event', payload)`)
to **plain-text rows**; the Channel then projects them into the transcript —
the live stream and replays (/resume, rewind) share the same path:

```ts
const renderers = ctx.get('tuiRenderers', false)
const dispose = renderers?.register('my-plugin/note', (payload) => {
  const note = payload as { text: string; ts: number }
  return {
    title: 'Note',                         // optional heading row
    lines: [note.text, `recorded ${new Date(note.ts).toLocaleString()}`],
  }
  // returning undefined = skip this entry (per-payload decision)
})
ctx.effect(() => () => dispose?.())
```

Rules:

- The type must look like `plugin/event` (kebab, exactly one `/`); built-in
  event types (`KNOWN_SESSION_EVENT_TYPES`) and the host-special-cased
  `agent-preset/selected` are refused — built-in projections always win.
- Renderers NEVER receive React: the full interactive surface is scenes
  (seam 8); transcript rows must be plain text — one crash on a replay path
  would corrupt the whole screen.
- A throwing renderer: that entry is skipped and the type is logged ONCE
  (sticky) — replaying a long log does not spam the warn stream.
- Output is validated and sanitized inside the renderer boundary: the title
  must be a string (anything else is dropped — a non-string would crash the
  React render path), lines are kept to scalars, control chars stripped,
  width capped by cell; at most 100 lines / 400 cells per line / 120 cells
  for the title, so a replay can never synchronously lay out an unbounded
  result.
- The two hard rules of event-type registration (log-only + registering into
  `KNOWN_SESSION_EVENT_TYPES`) remain seam 1's responsibility — a renderer
  only controls "how it displays", not "whether it may persist".

## Naming and Publishing Conventions

- **Package name**: ecosystem convention `@dsh-tui-ecosystem/<name>` (check npm
  availability before publishing); the official core keeps the
  `@deepseek-harness-tui/*` scope. Repos live at
  `github.com/dsh-tui-ecosystem/<name>`.
- **License**: MIT (same as the core).
- **Versioning**: semver; releases are tag-driven (`v*` tag, see the core
  publish workflow).
- **Node**: `^22.19 || >=24`, pure ESM.

## Quality and Security Red Lines

- Never append surface events or leak credentials; the model-visible surface
  goes through existing services only (tools, prompt sections, presets).
- Keep stdout quiet while the TUI is active: no `console.log` diagnostics; use
  stderr `DSH_TUI_DEBUG` or `DSH_TUI_RENDER_LOG`.
- Bound long-session memory: clean up per-session state on
  `session/disposed`; never accumulate without limit.
- Put user data only under the existing `~/.dsh-tui` locations; validate all
  external JSON and fall back instead of crashing.
- Treat plugin config and file content as untrusted input, especially strings
  that reach the render path (width is measured in terminal cells, never
  `string.length`).

## Verification Checklist

```sh
pnpm install --frozen-lockfile
pnpm build                       # tsc -> lib/types/
dsh plugin --profile dsh-tui add <your-package>   # install into the profile
dsh --profile dsh-tui            # manual verification in a real TTY (headless asserts are not enough)
DSH_TUI_DEBUG=1 dsh --profile dsh-tui      # when debugging is needed
```

For changes to rendering, keyboard, or terminal protocol, also run the core
package's CI regressions (see [Contributing](contributing.en.md#verification)).

## Listing and Promotion

- Once your plugin is done, submit the link so the community can find you:
  - The core repo's [`docs/links.md`](links.md) (PR to `ccch1mneyyy/dsh-TUI`)
  - The organization README's listing (PR to `dsh-tui-ecosystem`)
- State the minimum dsh-TUI version your plugin requires, and document
  compatibility as the core evolves.

Listing is link-only: it involves no code review or runtime verification, and
implies no endorsement or warranty of a plugin's functionality, quality, or
safety by dsh-TUI, the organization, or its members. Plugins are maintained by
their respective authors; evaluate a community plugin before installing it.
