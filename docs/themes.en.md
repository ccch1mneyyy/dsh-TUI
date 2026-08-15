# Themes

[Documentation index](README.md) · [简体中文](themes.md)

## Built-in themes

dsh-TUI provides three Gentle Mist Blue palettes, plus an `auto` pseudo-theme:

| Name | Purpose |
| --- | --- |
| `auto` | Pseudo-theme: follows the system/terminal background, resolving to `light` or `dark` |
| `light` | Warm-white surfaces, ink body text, and mist-blue interaction color |
| `dark` | Dark-terminal adaptation with warm-gray text and soft blue accents |
| `dark-ansi` | Compatibility fallback using only the 16 ANSI colors |

Without an explicit choice, the TUI queries the terminal background with OSC
11 and selects `light` or `dark`. It falls back to `dark` when the terminal does
not answer.

`auto` turns that one-shot startup detection into a standing choice: it is a
valid value for `/theme`, `CC_TUI_THEME`, and `~/.dsh-cc/theme.json`. Selecting
`auto` applies the last detected base immediately and re-queries OSC 11 in the
background — on terminals that follow the system theme, picking `auto` again
(or restarting) catches up after a system light/dark switch. `/theme status`
shows which palette `auto` currently resolves to, and `getTheme('auto')` serves
that palette to every consumer. A user theme named `auto` is shadowed by the
built-in pseudo-theme (not listed in the picker).

Selection precedence is:

```text
DSH_TUI_THEME
  > persisted choice in ~/.dsh-tui/theme.json
  > OSC 11 background detection
  > dark fallback
```

## Switching themes

- `/theme` opens the picker, with `auto` and the built-ins before custom themes.
- `/theme <name>` switches directly.
- `/theme status` shows the current theme and persistence location.

Confirming a choice hot-switches immediately and writes it to
`~/.dsh-tui/theme.json`. `DSH_TUI_THEME`, when set, still wins on the next launch.

## Custom themes

Place JSON files under `~/.dsh-tui/themes/`. Each file starts from one built-in
palette and overrides a subset of its colors:

```json
{
  "name": "sakura",
  "displayName": "Sakura",
  "base": "dark",
  "colors": {
    "claude": "#FF9EC7",
    "claudeShimmer": "#FFC0D5",
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
| `colors` | Yes | Partial override of semantic Theme keys |
| `name` | No | Theme ID; defaults to the filename |
| `displayName` | No | Picker label; defaults to `name` |

When the file declares `name`, its filename remains a loading alias. See the
`Theme` type in [`src/theme.ts`](../src/theme.ts) for every semantic key.

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

Theme names are user input. The loader verifies that the resolved path remains
inside `~/.dsh-tui/themes/`, preventing names from escaping the theme directory.
Preserve that containment check when changing the implementation.

## Design guidance

- Use semantic keys instead of changing only `text` and `background`. Check at
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
