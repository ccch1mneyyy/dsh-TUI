<p align="center">
  <a href="../zh/custom-themes.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Custom Themes

In addition to the built-in `light`, `dark`, and `dark-ansi` Gentle Mist Blue palettes, you can place
JSON theme files under `~/.dsh-cc/themes/` and override any subset of Theme keys:

```json
{
  "name": "sakura",
  "displayName": "Sakura Pink",
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

- **Directory**: `~/.dsh-cc/themes/<name>.json`, one theme per file. The filename becomes the theme
  name unless the file declares `name`, in which case the filename remains only as a loading alias.
- **Fields**: `base` is required and selects the built-in palette to override (`light`, `dark`, or
  `dark-ansi`). `colors` overrides any subset of Theme keys; see the `Theme` type in `src/theme.ts`
  for the complete list. `displayName` is shown in the picker and defaults to `name`; `name` defaults
  to the filename.
- **Validation**: colors accept `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `ansi256(n)`, and the
  16 `ansi:` named colors used by the built-in palettes and Ink color engine. Unknown keys or invalid
  colors are skipped with a warning on stderr without affecting the rest of the file. An invalid
  `base`, malformed JSON, or a non-object `colors` value skips the entire file with a warning; the
  TUI does not crash.
- **Activation**: `/theme` opens a picker with built-ins first and custom themes afterward. Each row
  shows its base and previews three key color swatches. Press Enter to **hot-switch immediately** and
  persist the choice to `~/.dsh-cc/theme.json`. You can also run `/theme <name>` directly or
  `/theme status` to inspect the current theme. The persisted selection survives restarts.
- **Precedence**: `CC_TUI_THEME` (built-in or custom name) > persisted choice in
  `~/.dsh-cc/theme.json` > OSC 11 terminal-background detection. A missing theme referenced by the
  environment variable or persisted setting produces a warning and is ignored, allowing automatic
  detection to continue as normal.
