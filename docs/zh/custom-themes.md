<p align="center">
  <strong>简体中文</strong> | <a href="../en/custom-themes.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# 自定义主题

除了内置的 `light` / `dark` / `dark-ansi` 三套 Gentle Mist Blue 调色板，
还可以放 JSON 主题文件到 `~/.dsh-cc/themes/`，用任意 Theme 键覆盖基底色板：

```json
{
  "name": "sakura",
  "displayName": "樱花粉",
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

- **目录**：`~/.dsh-cc/themes/<名字>.json`，每个文件一个主题；文件名即主题名
  （除非文件内声明了 `name`，此时以 `name` 为准，文件名退化为加载别名）。
- **字段**：`base` 必填（`light`/`dark`/`dark-ansi`，选定被覆盖的基底色板）；
  `colors` 是 Theme 键的子集覆盖（全部键名见 `src/theme.ts` 的 `Theme` 类型）；
  `displayName` 用于选择器显示，缺省取 `name`；`name` 缺省取文件名。
- **校验规则**：颜色值接受 `#rgb` / `#rrggbb` / `#rrggbbaa`、`rgb(r,g,b)`、
  `ansi256(n)` 与 16 个 `ansi:` 命名色（与内置色板及 Ink 色彩引擎同款格式）。
  未知键、非法色值 → 跳过该键并警告（stderr），不影响文件其余部分；`base`
  非法、JSON 损坏、`colors` 不是对象 → 整个文件跳过并警告，TUI 不会崩。
- **启用**：`/theme` 打开选择器（内置在前、自定义在后，每行带 base 标注与
  三个关键色块预览），Enter 选中即**立即热切换**并写入
  `~/.dsh-cc/theme.json`；也可 `/theme <名字>` 直接切换、`/theme status`
  查看当前主题。重启后持久化选择仍生效。
- **优先级**：`CC_TUI_THEME`（环境变量，内置名或自定义名）> 持久化选择
  `~/.dsh-cc/theme.json` > OSC 11 终端背景自动检测。环境变量或持久化指向
  不存在的主题时警告并忽略，自动检测照常兜底；两者都未设置时保持原有
  自动检测行为。
