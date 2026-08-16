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
