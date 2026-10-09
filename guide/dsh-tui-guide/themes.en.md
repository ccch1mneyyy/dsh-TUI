# Themes

[Documentation index](README.md) · [简体中文](themes.md)

## Built-in themes

dsh-TUI provides three Gentle Mist Blue palettes, plus an `auto` pseudo-theme:

| Name | Purpose |
| --- | --- |
| `auto` | Pseudo-theme: follows the system/terminal background, resolving to `light` or `dark` |
| `light` | White panels, ink body text, and mist-blue interaction color |
| `dark` | Dark-terminal adaptation with warm-gray text and soft blue accents |
| `dark-ansi` | Compatibility fallback using only the 16 ANSI colors (except the ignition pair) |

Without an explicit choice, the TUI queries the terminal background with OSC
11 and selects `light` or `dark`. It falls back to `dark` when the terminal
does not answer.

Light-theme panels, tool cards, and image previews use white (`#FFFFFF`)
surfaces by default; image previews use neutral borders. Dark palettes and
accent colors are unchanged. This does not modify the terminal's own
background or wallpaper.

`auto` turns that one-shot startup detection into a standing choice:

- A valid value for `/theme`, `DSH_TUI_THEME`, and `~/.dsh-tui/theme.json`.
- Selecting `auto` applies the last detected base immediately and re-queries
  OSC 11 in the background.
- On terminals that follow the system theme, picking `auto` again (or
  restarting) catches up after a system light/dark switch.
- `/theme status` shows which palette `auto` currently resolves to.
- `getTheme('auto')` serves that palette to every consumer.
- A user theme named `auto` is shadowed by the built-in pseudo-theme (not
  listed in the picker).

Selection precedence is:

```text
DSH_TUI_THEME
  > persisted choice in ~/.dsh-tui/theme.json
  > OSC 11 background detection
  > dark fallback
```

## Switching themes

- `/theme` opens the picker, with `auto` and the built-ins before static JSON
  and plugin themes. On terminals at least 76 columns wide a live preview sits
  beside the list: the **focused row's** palette renders a code block, a
  code-operation tool card and a diff, so moving the cursor compares syntax,
  diff and tool-card colors before Enter applies anything. Narrower terminals
  stack the preview under the list, and it yields entirely when the height
  budget is short — the list and its focused row always stay visible.
- `/theme <name>` switches directly to a built-in, static JSON, or runtime plugin theme.
- `/theme status` shows the current theme and persistence location.

Confirming a choice hot-switches immediately and writes it to
`~/.dsh-tui/theme.json`. `DSH_TUI_THEME`, when set, still wins on the next
launch.

## Custom themes

Place JSON files under `~/.dsh-tui/themes/`. Each file starts from one
built-in palette and overrides a subset of its colors:

```json
{
  "name": "sakura",
  "displayName": "Sakura",
  "base": "dark",
  "colors": {
    "accent": "#FF9EC7",
    "accentShimmer": "#FFC0D5",
    "activity": "#7DA1DE",
    "activityShimmer": "#ABC2EC",
    "mascotBody": "#D98A63",
    "inputBackground": "#000000",
    "permission": "#FFB3CC",
    "promptBorder": "#B08B99",
    "text": "#E8E6E0",
    "inactive": "#A99BA0",
    "subtle": "#8A7A80",
    "selectionBg": "#5C3A44",
    "success": "#9CC7A8",
    "error": "#E08591",
    "warning": "#E0C08A"
  }
}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `base` | Yes | `light`, `dark`, or `dark-ansi`; source for every non-overridden color |
| `colors` | Yes | Partial override of Theme color keys |
| `name` | No | Theme ID; defaults to the filename |
| `displayName` | No | Picker label; defaults to `name` |

Available color keys by purpose:

- Brand/focus/activity: `accent`, `accentShimmer`, `activity`, `activityShimmer`, `suggestion`, `remember`
- Panels/borders: `permission`, `permissionShimmer`, `promptBorder`, `promptBorderShimmer`, `bashBorder`, `planMode`, `ide`, `background`
- Body text: `text`, `inverseText`, `inactive`, `inactiveShimmer`, `subtle`
- Tool names & status dots: `toolNameMutate`, `toolNameExec`, `toolDotExec`, `toolDotRead`, `toolDotWrite`, `toolDotWeb`, `toolDotTask`
- Tool card surfaces: `toolCardBackground`, `toolCardBackgroundDim`
- Status: `autoAccept`, `success`, `error`, `warning`, `warningShimmer`, `merged`
- Diff: `diffAdded`, `diffRemoved`, `diffAddedDimmed`, `diffRemovedDimmed`, `diffAddedWord`, `diffRemovedWord`
- Diff syntax highlighting: `syntaxKeyword`, `syntaxString`, `syntaxComment`, `syntaxNumber`, `syntaxFunction`, `syntaxType`
- Diff syntax highlighting (cont.): `syntaxVariable`, `syntaxOperator`, `syntaxPunctuation`, `syntaxConstant`
- Badges/accents: `mascotBody`, `inputBackground`, `professionalBlue`, `chromeYellow`
- Animated chrome & caret: `contextBarSystem`, `contextBarPrompt`, `contextBarAssistant`
- Animated chrome & caret (cont.): `contextBarThinking`, `contextBarTools`, `ignition`, `ignitionDim`, `cursor`
- Messages & input: `userMessageBackground`, `userMessageBackgroundHover`, `messageActionsBackground`, `selectionBg`, `bashMessageBackgroundColor`
- Messages & input (cont.): `memoryBackgroundColor`, `rate_limit_fill`, `rate_limit_empty`, `fastMode`, `fastModeShimmer`, `userPromptLabel`
- Subagent messages: `subagentBullet`, `subagentDescription`, `subagentModel`, `subagentElapsed`, `subagentToolName`, `subagentStatusRunning`
- Subagent messages (cont.): `subagentStatusCompleted`, `subagentStatusFailed`

When the file declares `name`, its filename remains a loading alias. See the
`Theme` type in [`src/theme.ts`](../src/theme.ts) for every color key.

A few keys carry behavior worth knowing:

- `contextBarSystem` … `contextBarTools`: the context progress bar's five segment fills, in bar
  order (system → prompt → assistant → thinking → tools). Static JSON and plugin themes inherit
  all five from the `base` they pick; only a legacy resolver's key-less palette keeps the old ramp.
- `ignition` / `ignitionDim`: the top reasoning tier's ignition colors — the sweep waveform, the
  `❯` prefix and the tier badge all read the same pair, and `ignitionDim` is the substrate the
  wave fades into. The wave emits per-column truecolor SGR, so these two want a form with fixed
  channels (`#rgb`, `#rrggbb`, `#rrggbbaa` with the alpha ignored, or `rgb(r,g,b)`); `ansi:*` /
  `ansi256(n)` — or a missing key — falls back **per key** to the built-in pair selected by the
  palette's lightness, so the other key is unaffected.
- `cursor`: the painted caret fill in the main prompt, launchpad input and picker search boxes
  during static rendering without a native cursor, plus image-token focus in the main prompt.
  Ordinary TTY text editing uses the native cursor; shape, color, blinking and animation follow terminal settings.
  The glyph on it is whichever of `text` / `inverseText`
  contrasts better with that fill (a 16-color `ansi:*` fill, or a palette whose `text`/`inverseText`
  has no parseable channels, cannot be measured and keeps `inverseText`), so a light caret can still
  carry dark ink. The built-ins leave it empty, giving the painted fallback an inverse-video block.
  A custom fill affects these painted highlights only.
- Transcript link text follows `accent`; an empty or unparseable accent keeps the old fixed blue.

## npm plugin themes

An npm plugin registers a runtime theme through the `tuiThemes` service,
without writing to `~/.dsh-tui/themes/`. Minimal example:

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.get('tuiThemes', false)?.register({
    name: 'my-plugin:night',
    base: 'dark',
    colors: { accent: '#88AAFF' },
  }, ctx)
}
```

- Use a lowercase safe ID such as `plugin-id:theme-id`.
- `auto`, built-in names, and `status` are reserved.
- Registrations are removed with the plugin activation; the returned disposer
  can remove one early.
- Plugin themes appear in the `/theme` picker and completion; their names use
  the existing `~/.dsh-tui/theme.json` persistence.
- Priority: built-ins > static JSON > same-name plugin theme.
- On an older profile without `tuiThemes`, the plugin degrades silently and
  static themes remain unaffected.

See the [Plugin Admission and Development Guide](../tui-profile/docs/plugin-admission-and-development.md)
for the full key list, legacy-key mapping, and registration contract.

## Color formats

Accepted forms:

- `#rgb`
- `#rrggbb`
- `#rrggbbaa`
- `rgb(r,g,b)`
- `ansi256(n)`
- 16-color names such as `ansi:black` and `ansi:redBright`

Colors must be concrete values. CSS variables, gradients, and arbitrary CSS
color names are not accepted.

## Validation and failure behavior

- Unknown Theme key: skip that key with a warning and keep the rest.
- Invalid color: skip that value with a warning.
- Invalid `base`, malformed JSON, or non-object `colors`: skip the whole file.
- Missing theme referenced by the environment or preference file: warn and
  continue with background detection.
- One bad theme never blocks TUI startup or other themes.

Theme names are user input. The loader verifies that the resolved path
remains inside `~/.dsh-tui/themes/`, preventing names from escaping the theme
directory. Preserve that containment check when changing the implementation.

## Design guidance

- Use color keys instead of changing only `text` and `background`. Check at
  least body, inactive, focus, selection, success, warning, error, and diff
  colors.
- Test light themes in a real light terminal and dark themes in a dark one.
- Check 16-color, 256-color, and truecolor fallback behavior.
- Verify narrow layouts, tool diffs, questionnaires, multiline input, and
  selection contrast.
- Theme files should contain display metadata and color only, never credentials
  or other user data.

When developing the theme subsystem, run:

```sh
node --import tsx/esm scripts/verify-themes.mjs
```

See [Architecture and limitations](architecture.en.md) for terminal capability
and renderer details.
