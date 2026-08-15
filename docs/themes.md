# 主题系统

[文档索引](README.md) · [English](themes.en.md)

## 内置主题

dsh-TUI 提供三套 Gentle Mist Blue 色板，外加一个 `auto` 伪主题：

| 名称 | 用途 |
| --- | --- |
| `auto` | 伪主题：跟随系统/终端背景，自动解析为 `light` 或 `dark` |
| `light` | 暖白背景、墨色正文、雾蓝交互色 |
| `dark` | 深色终端适配，暖灰正文与柔雾蓝强调色 |
| `dark-ansi` | 只依赖 16 色 ANSI 的兼容回退 |

未明确指定主题时，TUI 会通过 OSC 11 查询终端背景并在 `light` 与 `dark` 之间
选择；终端不响应时回退到 `dark`。

`auto` 把这次性启动检测变成常驻选择：它在 `/theme`、`CC_TUI_THEME`、
`~/.dsh-cc/theme.json` 中都是合法值。选中 `auto` 时立即应用上次检测结果，并
在后台重新查询 OSC 11——跟随系统主题的终端切换深浅色后，再次选择 `auto`（或
重启）即可跟上。`/theme status` 会显示 `auto` 当前解析到的色板。解析结果通过
`getTheme('auto')` 对所有消费方生效。注意：用户自定义主题若命名为 `auto` 会被
内置伪主题遮蔽（选择器中不列出）。

选择优先级：

```text
DSH_TUI_THEME
  > ~/.dsh-tui/theme.json 中的持久化选择
  > OSC 11 背景检测
  > dark 回退
```

## 切换主题

- `/theme`：打开主题选择器。`auto` 与内置主题在前，自定义主题在后。
- `/theme <name>`：直接切换。
- `/theme status`：显示当前主题与持久化位置。

选择器确认后立即热切换，并把选择写入 `~/.dsh-tui/theme.json`。如果设置了
`DSH_TUI_THEME`，它在下一次启动时仍然优先。

## 自定义主题

在 `~/.dsh-tui/themes/` 下放置 JSON 文件。每个文件定义一个主题，并从一个内置
色板开始覆盖：

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

字段：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `base` | 是 | `light`、`dark` 或 `dark-ansi`，作为未覆盖颜色的来源 |
| `colors` | 是 | Theme 语义键的部分覆盖 |
| `name` | 否 | 主题 ID；缺省使用文件名 |
| `displayName` | 否 | 选择器显示名称；缺省使用 `name` |

如果文件声明了 `name`，文件名仍可作为加载别名。完整语义键见
[`src/theme.ts`](../src/theme.ts) 中的 `Theme` 类型。

## 颜色格式

支持：

- `#rgb`
- `#rrggbb`
- `#rrggbbaa`
- `rgb(r,g,b)`
- `ansi256(n)`
- `ansi:black`、`ansi:redBright` 等 16 色 ANSI 名称

颜色必须是具体值，不能使用 CSS 变量、渐变或任意 CSS 颜色名。

## 校验与失败策略

- 未知 Theme 键：跳过该键并写入警告，其余颜色继续生效。
- 非法颜色：跳过该值并写入警告。
- 非法 `base`、损坏的 JSON、非对象 `colors`：跳过整个文件。
- 环境变量或偏好文件引用不存在的主题：写入警告并继续背景自动检测。
- 一个坏主题不会阻止 TUI 启动，也不会影响其他主题。

主题名来自用户输入，加载器会检查路径是否仍位于主题目录内，防止通过名称跳出
`~/.dsh-tui/themes/`。修改这部分实现时必须保留路径约束。

## 设计建议

- 使用语义键而不是只替换 `text` 与 `background`。至少检查正文、非活动文字、
  焦点、选择、成功、警告、错误和 diff 色。
- 浅色主题应在真正的浅色终端验证；深色主题同理。
- 检查 16 色、256 色和 truecolor 终端的回退表现。
- 在窄终端、工具 diff、问卷、多行输入与选区状态下检查对比度。
- 不要把密钥或其他用户数据写进主题文件；主题只应包含显示元数据和颜色。

开发主题系统时运行：

```sh
node --import tsx/esm scripts/verify-themes.mjs
```

进一步的终端能力与渲染说明见[架构与限制](architecture.md)。
