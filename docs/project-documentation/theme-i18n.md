# 主题系统与 i18n

本文覆盖 Gentle Mist Blue（雾蓝）主题家族（内置三色板 + 用户自定义主题）、
启动解析与 /theme 热切换，以及 en/zh 双语 i18n 系统与 /lang 热换。行号均以
审计基线 b2f4087 为准。

## 主题家族与键面

内置三色板（`src/theme.ts`）：`THEME_NAMES = ['dark', 'dark-ansi', 'light']`
（:92）。dark 深色适配、light 严格浅色卡片、dark-ansi 仅用 16 个标准 ANSI
色的 truecolor 回退（:261-269，注释 "verbatim from the leak"）。Theme 类型
共 **69 个 string 键**（程序化计数），按语义分组注释：Semantic / Diff /
Agent / Grove / Chrome / TUI V2（:13-89）。

- 未知主题名回退 `dark`（src/theme.ts:346-355）。
- 8 个 `*_FOR_SUBAGENTS_ONLY` 键与 rainbow_*/briefLabel*/clawd_*/chromeYellow/
  rate_limit_* 等在 src/ 内**无任何消费点**（grep 仅命中定义与
  FOR_SYSTEM_SPINNER 的使用）；疑似为兼容 Claude Code leak 键面而保留，
  是否有外部消费者无法从本仓库确证。
- 模块级活动主题镜像（src/theme.ts:381-398）服务非 React 渲染：markdown 内联
  代码取当前主题 permission 色（src/cc/markdown.ts:24-26）。
- ui.ts 导出主题化 Box/Text facade（src/ui.ts:2-13）：移植的 CC 组件原样用
  `color="subtle"` 式主题键。

## 启动解析链（强制 → 探测）

```text
src/plugin.ts:298-302  React.createElement(ThemeProvider, null, ...)——theme prop
  传 null，prop 路径在生产未使用（Config 无 theme 键，见下方冲突表）
  -> src/components/design-system/ThemeProvider.tsx:80-91 forced = theme ?? envThemeOverride() ??
     readThemePref()：CC_TUI_THEME（:54-57）> ~/.dsh-cc/theme.json 持久化
     选择（src/themePrefs.ts:38-44，仅 CC_TUI_THEME 未设时生效）> 探测
  -> isThemeAvailable 校验（:83-90）：无效强制名 console.warn 后继续探测
  -> OSC 11 探测（src/components/design-system/ThemeProvider.tsx:113-125）：raw 模式下 querier.send(
     oscColor(11))，400ms 超时/无应答/非 rgb -> dark，sRGB
     luma=0.299r+0.587g+0.114b > 140 -> light
  -> 子组件待主题落定后才渲染——首帧即最终调色板，无暗→亮闪变
     （:10-27 "Children render only after the theme settles"）
  -> getTheme 解析（src/theme.ts:346-355）：内置名直返；其余走
     registerCustomThemeResolver 注册的 resolveCustomTheme
     （src/components/design-system/ThemeProvider.tsx:29-32 -> src/customTheme.ts:254-289）
  -> 落定后 setActiveThemeName 镜像到模块级（src/components/design-system/ThemeProvider.tsx:151-153）
```

主题探测相关历史提交：6dc0f4b（2026-08-06，Gentle Mist Blue 双主题 + OSC 11
探测）、843fb76（2026-08-13，修复 XTVERSION 与 OSC 11 在同一 tick 竞争 raw
模式借用/释发放出的应答回显乱码）。

## /theme 与 /lang 命令

| 命令 | 形态 | 行为 | 位置 |
| --- | --- | --- | --- |
| /theme | `/theme status` | 显示当前选择 | src/screens/Chat.tsx:408-438 |
| /theme | `/theme <name>` | setTheme 直接切换 | 同上 |
| /theme | 裸 /theme | 打开 ThemePicker 选择器（无独立快捷键；Enter 确认/Esc 取消） | 同上 |
| /lang | `/lang status` | 显示当前语言（裸 /lang 同效） | src/screens/Chat.tsx:372-407 |
| /lang | `/lang en\|zh` | writeLangPref 先持久化 → setLang 热切 | 同上 |
| /lang | `/lang help` | 帮助 | 同上 |

/theme 切换链（src/components/design-system/ThemeProvider.tsx:133-144）：isThemeAvailable 校验 →
writeThemePref 先持久化到 ~/.dsh-cc/theme.json（src/themePrefs.ts:52-60）→
setActive 热切换——"persists first (a choice that cannot be saved never
silently disappears)"。

## 用户自定义主题（0.2.0，提交 33a4a07）

文件：`~/.dsh-cc/themes/<name>.json`，结构 { name?, displayName?, base,
colors }：

- base 必需（light/dark/dark-ansi），buildTheme 以 base 调色板为底叠加
  colors 覆盖（src/customTheme.ts:249-256）。
- 接受颜色形式：#rgb/#rrggbb/#rrggbbaa、rgb(r,g,b)、ansi256(n)、16 个
  ansi: 名称（src/customTheme.ts:49-73，与 src/ink/styles.ts:22-41 的 Color
  类型同型——16 个 ansi 名 + Color 联合）。
- 校验策略逐键 best-effort（src/customTheme.ts:137-206）：坏 JSON/非对象/坏
  base/不安全名整文件跳过；未知键与非法颜色值逐个跳过并警告 stderr；
  **colors 缺省合法**（返回空覆盖，:175-178）；每种失败模式恰好警告一次。
- isSafeThemeName 防目录穿越（:90-103）——名称输入来自 CC_TUI_THEME 与
  /theme，禁止逃出 themes 目录。
- resolveCustomTheme 带缓存 + name→file 索引（:258-289）：声明 name 与
  文件名不同的主题首次 miss 后建索引，显示名处处可解析；失败不缓存。
- listCustomThemes 按主题 name localeCompare 排序、跳过坏文件（:233-247）。
- ThemePicker 行预览（src/components/ThemePicker.tsx:12-65）：██ 双块色样，预览键
  claude/text/success；选项为三内置 + 发现的自定义主题。
- 回归：scripts/verify-themes.mjs（临时 HOME + 7 夹具、19 项断言、失败
  非零退出；未挂 CI，为手动回归脚本），`node --import tsx/esm
  scripts/verify-themes.mjs` 直跑源码。

## i18n 系统（#22，提交 283aba1）

- 扁平 dict：**215 个键**（程序化计数），每键 {zh, en} 字符串对，zh 默认
  （src/i18n.ts:30-279）；t(key, params) 做 {{name}} 占位替换，缺键渲染键名
  本身——"a typo is visible in the UI instead of silently blank"
  （src/i18n.ts:13-17,322-328）。
- 语言解析 5 级链（src/i18n.ts:5-11,372-382）：
  `CC_TUI_LANG` env → `lang` cordis.yml 键 → ~/.dsh-cc/lang.json 持久化
  /lang 选择 → OS locale（LC_ALL/LC_MESSAGES/LANG）→ zh。
- 启动落定（src/plugin.ts:40-45）：首帧渲染前 setLang（env > config.lang >
  resolveStartupLang()）——"Must settle before the first render so every
  module resolves strings in the same language"。
- 运行时热换（src/i18n.ts:305-308）：setLang 遍历 listeners；Chat 以
  useSyncExternalStore(subscribeLang, getLang) 全 UI 重渲染
  （src/screens/Chat.tsx:119-120）；src/channel.ts 等非 React 模块在调用点执行 t()。
- 持久化 ~/.dsh-cc/lang.json（src/i18n.ts:336-365）；parseLangPref 只接受
  zh/en。

## 冲突

| 项 | 两侧 |
| --- | --- |
| docs 称 colors 必需 | docs/themes.md:67 字段表 `colors` 标记"是"（必需）；src/customTheme.ts:175-178 colorsRaw === undefined 时返回合法 spec（空覆盖），仅非对象 colors 才整文件拒绝 |
| StatusMetrics 硬编码色值 | src/screens/StatusMetrics.ts:223-228 硬编码 success '78;186;101'/warning '202;138;4'/error '255;107;128' 并注释"cc-tui dark theme values (theme.ts)"；dark 主题（src/theme.ts:132-134）实为 rgb(130,184,157)/rgb(216,178,112)/rgb(218,138,147)——三组全部不一致，且无 useTheme 参与，换主题不生效 |
| ThemePicker 排序注释 | src/components/ThemePicker.tsx:46-49 注释称自定义主题 "sorted by file name"；代码按主题 name localeCompare 排序（src/customTheme.ts:246）——声明 name 与文件名不同时顺序不一致 |
| 语言链注释表述不一致 | src/plugin.ts:40-43 注释链漏 OS locale 步骤；src/index.ts:54-55 注释漏 config.lang 与 OS locale；代码实际一致走完整 5 级链（src/plugin.ts:45 resolveStartupLang = readLangPref ?? detectLocaleLang） |
| 主题描述路径按显示名拼 | src/i18n.ts:243 'theme-user-base' 按 {{name}} 拼 ~/.dsh-cc/themes/{{name}}.json；src/components/ThemePicker.tsx:56-62 传入 spec.name——声明 name 与文件名不同时（如 good.json 声明 name sakura）显示路径在磁盘上不存在（仅外观问题） |

## 未验证事项

- *_FOR_SUBAGENTS_ONLY 等无消费点键是否有外部消费者（DSH 引擎/其他插件），
  无法从本仓库确证。
- src/components/design-system/ThemeProvider.tsx 的 theme prop 路径在生产未使用（src/plugin.ts:298-302 传 null），
  疑为保留 leak API 兼容，无任何调用者。
- dark-ansi "verbatim from the leak" 的确切上游来源文件不可识别（node_modules
  未安装，lib 为构建产物不入审计）。
- /lang 切换是否影响其他已挂载 DSH 插件的 UI 文案（i18n 字典只覆盖 cc-tui
  自身，引擎层是否消费同一语言机制无证据）。
- 7b425de（消息列表虚拟化）被 git log --grep 'theme' 命中仅因提交体含回归
  统计字样 "theme 22/22"，与主题功能无关；主题提交清单应以标题明确的
  6dc0f4b/843fb76/33a4a07/283aba1 为准。

相关文档：[ink-core.md](ink-core.md)（终端能力探测/querier）、
[lifecycle.md](lifecycle.md)（启动序）、[input-commands.md](input-commands.md)
（/theme、/lang 命令入口）、[unknowns.md](unknowns.md)。
