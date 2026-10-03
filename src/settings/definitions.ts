/**
 * The single definition of every dsh-tui setting: label, help text (en/zh),
 * kind, options and /settings group. The /settings page, the editable-key
 * list, and the settings.json shipped in the npm package (the website's
 * settings reference) are all built from this module, so a setting is
 * described once. Side-effect free: no runtime state, safe to import from
 * build scripts. Runtime behaviour (format/parse, dynamic labels) stays with
 * the field in dsh-adapter/plugin.ts.
 *
 * Keys are sorted; add a setting at its sorted position.
 */
import type { TuiSettingsField } from '../adapter/ports/channel-settings.js'
import { SPLASH_FONT_OPTIONS } from '../components/splashFonts.js'
import type { ShortcutActionId } from '../utils/keymap.js'

export type SettingDefinition = Pick<TuiSettingsField, 'label' | 'descriptions' | 'hint' | 'hintDescriptions' | 'kind' | 'group' | 'options'>

export const SETTING_DEFINITIONS = {
  'companion.skin': {
    label: 'Companion skin',
    descriptions: { zh: '宠物皮肤' },
    group: 'splash',
    hint: 'Look of the companion panel pet (enable the panel by adding \'companion\' to sidePanel.panels): deepy (default, the deepy whale kit), whale (the same layered pixel whale as the splash) or whaleGirl (the user-provided whale-girl sticker pack, 22 animations). Applies immediately.',
    hintDescriptions: { zh: '伙伴面板里宠物的外形（面板需在 sidePanel.panels 里加入 companion 启用）：deepy（默认，deepy 小鲸鱼素材包）、whale（与开屏同款的分层像素鲸鱼）或 whaleGirl（用户提供的鲸娘表情包，22 个动画）。立即生效。' },
    kind: 'select',
    options: [
      { value: 'deepy', label: 'Deepy', descriptions: { zh: 'Deepy 小鲸鱼' } },
      { value: 'whaleGirl', label: 'Whale girl', descriptions: { zh: '鲸娘' } },
      { value: 'whale', label: 'Whale', descriptions: { zh: '像素鲸鱼' } },
    ],
  },
  'diffLayout': {
    label: 'Diff layout',
    descriptions: { zh: 'diff 布局' },
    group: 'conversation',
    hint: 'Edit/Write tool cards: auto picks by terminal width, or force one layout.',
    hintDescriptions: { zh: 'Edit/Write 工具卡的 diff 呈现：auto 按终端宽度选择，或强制一种布局。' },
    kind: 'select',
    options: [
      { value: 'auto', label: 'Auto (by width)', descriptions: { zh: '自动（按宽度）' } },
      { value: 'split', label: 'Side-by-side', descriptions: { zh: '双栏对照' } },
      { value: 'unified', label: 'Unified', descriptions: { zh: '统一式' } },
    ],
  },
  'effortDefault': {
    label: 'Default reasoning effort',
    descriptions: { zh: '默认推理强度' },
    group: 'conversation',
    hint: 'Reasoning-effort level new sessions start on; the current session applies it to its next request too, when the model offers the tier (an unlisted level falls back to the model default). Auto = follow the cordis.yml `effort` pin, then the persisted /effort choice, then the model default.',
    hintDescriptions: { zh: '新会话起始的推理强度档位；模型提供该档位时，当前会话的下一请求也会应用（模型不提供的档位会静默回落到模型默认）。自动 = 依次跟随 cordis.yml 的 effort 配置、持久化的 /effort 选择、模型默认档。' },
    kind: 'select',
    options: [
      { value: 'auto', label: 'Auto (model default)', descriptions: { zh: '自动（模型默认）' } },
      { value: 'off', label: 'Off', descriptions: { zh: '关闭' } },
      { value: 'low', label: 'Low', descriptions: { zh: '低' } },
      { value: 'high', label: 'High', descriptions: { zh: '高' } },
      { value: 'max', label: 'Max', descriptions: { zh: '最高' } },
    ],
  },
  'expandEditor': {
    label: 'Fullscreen draft editor',
    descriptions: { zh: '全屏草稿编辑' },
    group: 'conversation',
    hint: 'On: the ⛶ affordance in the input row and the expand-editor shortcut (default Ctrl+Shift+E) expand the draft into a whole-screen editor (Enter = newline, Ctrl+Enter = send). Off: both entry points disappear. On by default.',
    hintDescriptions: { zh: '开启：输入行尾 ⛶ 按钮与全屏编辑快捷键（默认 Ctrl+Shift+E）把草稿展开成整屏编辑器（Enter 换行、Ctrl+Enter 发送）。关闭：两个入口都不显示。默认开启。' },
    kind: 'boolean',
  },
  'foldTerminalCommand': {
    label: 'Fold terminal command',
    descriptions: { zh: '折叠终端命令' },
    group: 'conversation',
    hint: 'Terminal cards (Bash/PowerShell): collapse a multi-line command header to its first line + count; Ctrl+O or a click expands it.',
    hintDescriptions: { zh: '终端卡（Bash/PowerShell）：多行命令头部折叠为首行 + 计数；Ctrl+O 或点击卡片展开。' },
    kind: 'boolean',
  },
  'fullscreen': {
    label: 'Fullscreen mode',
    descriptions: { zh: '全屏模式' },
    group: 'appearance',
    hint: 'On: app takes the whole screen (vim/less style), in-app mouse. Off: native scrollback; full-page screens keep the mouse. Restart to apply.',
    hintDescriptions: { zh: '开启：接管整个终端（同 vim/less），应用内鼠标；关闭：终端原生滚动选择；整屏页两种模式都有鼠标。重启生效。' },
    kind: 'boolean',
  },
  'imageBacking': {
    label: 'Photo image background',
    descriptions: { zh: '图片底色' },
    group: 'rendering',
    hint: "What sits behind photos and illustrations in the chat. Transparent paints only the pixels of the image itself — the terminal background or wallpaper shows through at anti-aliased edges and transparent corners; Terminal colour composites onto the terminal background first, which keeps soft edges smooth (Sixel has no partial alpha). Applies immediately.",
    hintDescriptions: { zh: '聊天里的照片/插图背后垫什么。透明：只画图片自己的像素，抗锯齿边缘和透明圆角处透出终端底色或壁纸；终端底色：先合成到终端背景色上，柔和边缘更平滑（Sixel 没有部分透明）。立即生效。' },
    kind: 'select',
    options: [
      { value: 'transparent', label: 'Transparent', descriptions: { zh: '透明（透出终端背景）' } },
      { value: 'terminal', label: 'Terminal colour', descriptions: { zh: '合成到终端底色' } },
    ],
  },
  'jobGroupFold': {
    label: 'Job card groups',
    descriptions: { zh: '后台任务分组' },
    group: 'conversation',
    hint: 'Consecutive background-job cards render as one group with a summary header. Auto folds a run of 3+ once every job settled; Always folds any run of 2+ right away; Never keeps every card (click the header to fold one run by hand, Ctrl+O to expand all).',
    hintDescriptions: { zh: '连续的后台任务卡渲染成一组并带汇总头。自动：整组落定且 3 个以上时折叠成一行；总是：2 个以上立即折叠；从不：每张卡都留着（点组头可手工折叠单组，Ctrl+O 展开全部）。' },
    kind: 'select',
    options: [
      { value: 'auto', label: 'Auto (3+ settled)', descriptions: { zh: '自动（落定 3 个以上）' } },
      { value: 'always', label: 'Always (2+)', descriptions: { zh: '总是（2 个以上）' } },
      { value: 'never', label: 'Never fold', descriptions: { zh: '从不折叠' } },
    ],
  },
  'lang': {
    label: 'Language',
    descriptions: { zh: '界面语言' },
    group: 'appearance',
    hint: 'UI language for the whole interface — applies immediately and is saved.',
    hintDescriptions: { zh: '整个界面的显示语言——立即生效并保存。' },
    kind: 'select',
    options: [
      { value: 'zh', label: '中文', descriptions: { zh: '中文' } },
      { value: 'en', label: 'English', descriptions: { zh: '英文' } },
    ],
  },
  'mathImageBacking': {
    label: 'Formula image background',
    descriptions: { zh: '公式图片底色' },
    group: 'math',
    hint: 'What sits behind a formula rendered as an image. Transparent paints only the formula and lets the terminal background (a wallpaper included) show through; Terminal colour composites it onto the terminal background first, which is calmer on busy backgrounds and keeps anti-aliased edges smooth (Sixel has no partial alpha). Applies immediately.',
    hintDescriptions: { zh: '公式渲染成图片时背后垫什么。透明：只画公式本身，终端底色或壁纸直接透出来；终端底色：先合成到终端背景色上，在花哨的背景上更稳，抗锯齿边缘也更平滑（Sixel 没有部分透明）。立即生效。' },
    kind: 'select',
    options: [
      { value: 'transparent', label: 'Transparent', descriptions: { zh: '透明（透出终端背景）' } },
      { value: 'terminal', label: 'Terminal colour', descriptions: { zh: '合成到终端底色' } },
    ],
  },
  'mathImageScale': {
    label: 'Formula image size',
    descriptions: { zh: '公式图片大小' },
    group: 'math',
    hint: 'How large a display formula is set when it renders as an image (LaTeX math → Image, both on this page). Text size matches the body text; Large and Extra large set display math bigger, which also hands the terminal more device pixels for its strokes — the only sharpness lever a terminal image has. Inline formulas are unaffected: their single row of cells caps the resolution. Applies immediately.',
    hintDescriptions: { zh: '块级公式渲染成图片时的大小（配合 LaTeX 公式的「图片」）。与正文同尺寸：和正文一样大；放大 / 更大：显示公式排得更大，终端也因此有更多像素画笔画，观感更锐利——这是终端图片唯一的清晰度杠杆。行内公式不受影响（只能占一行，像素上限被卡死）。立即生效。' },
    kind: 'select',
    options: [
      { value: 'auto', label: 'Text size', descriptions: { zh: '与正文同尺寸' } },
      { value: 'large', label: 'Large', descriptions: { zh: '放大' } },
      { value: 'xlarge', label: 'Extra large', descriptions: { zh: '更大' } },
    ],
  },
  'mathRendering': {
    label: 'LaTeX math',
    descriptions: { zh: 'LaTeX 公式' },
    group: 'math',
    hint: 'How LaTeX math in replies ($…$, \\(…\\), $$…$$, \\[…\\]) renders. Auto: the best available renderer — today Unicode text with symbols, sub/superscripts, stacked fractions and limits, matrices, cases. Image: typeset block formulas and eligible one-row inline formulas as images when the terminal has graphics — Kitty (Kitty, Ghostty, WezTerm, iTerm2…) or Sixel (Windows Terminal 1.22+, xterm, foot, WezTerm); Unicode elsewhere and for formulas that do not fit. Unicode: always Unicode text. Source: keep the TeX as written. Unsupported, still-streaming, or too-wide formulas keep their source. Applies immediately.',
    hintDescriptions: { zh: '回复中的 LaTeX 公式（$…$、\\(…\\)、$$…$$、\\[…\\]）怎么显示。自动：用当前最好的渲染方式——目前是 Unicode 文本（符号、上下标、竖排的分数与上下限、矩阵、分段函数）。图片：终端支持图形时把块级公式与能压入一行的行内公式排版成图片——Kitty（Kitty、Ghostty、WezTerm、iTerm2 等）或 Sixel（Windows Terminal 1.22+、xterm、foot、WezTerm）；其他终端与放不下的公式用 Unicode。Unicode：固定用 Unicode 文本。源码：保留原始 TeX。不支持、仍在流式输出或比终端宽的公式保留源码。立即生效。' },
    kind: 'select',
    options: [
      { value: 'auto', label: 'Auto', descriptions: { zh: '自动' } },
      { value: 'image', label: 'Image', descriptions: { zh: '图片' } },
      { value: 'unicode', label: 'Unicode', descriptions: { zh: 'Unicode' } },
      { value: 'source', label: 'Source', descriptions: { zh: '源码' } },
    ],
  },
  'mermaidDiagrams': {
    label: 'Mermaid diagrams',
    descriptions: { zh: 'Mermaid 图表' },
    group: 'rendering',
    hint: 'Render ```mermaid fences in replies as box-drawing diagrams (flowchart, sequence, state, class, ER, pie, mindmap, timeline, gitGraph). Diagrams wider than the terminal, or of an unsupported type, keep the fenced source. Applies immediately. On by default.',
    hintDescriptions: { zh: '把回复中的 ```mermaid 代码块画成字符图（flowchart、sequence、state、class、ER、pie、mindmap、timeline、gitGraph）。比终端宽或类型不支持的图保留源码。立即生效。默认开启。' },
    kind: 'boolean',
  },
  'minimal': {
    label: 'Minimal UI',
    descriptions: { zh: '极简界面' },
    group: 'appearance',
    hint: 'Interface only: hide the header splash, emoji glyphs and decorative colors, and trim the status bar to model + cwd; code highlight and tool colors stay. NOT the agent preset — the kernel\'s own `minimal` preset is a separate, model-facing choice that decides which tools the model can use (see /preset).',
    hintDescriptions: { zh: '只精简界面：隐藏开屏头部、emoji 状态符与装饰性配色，底栏只留模型与目录；代码高亮与工具配色保留。这是界面开关，不是 Agent 预设——模型能用哪些工具由内核预设决定（见 /preset）。' },
    kind: 'boolean',
  },
  'pageMargin': {
    label: 'Page margin',
    descriptions: { zh: '页边距' },
    group: 'appearance',
    hint: 'Inset the whole UI from the terminal edges. ←/→ cycles presets (none / slim / normal / roomy); Enter types a custom spec `NxM`: N columns per side, M rows top/bottom (e.g. 3x1, max 8x4; a bare `N` keeps rows at 1). Empty resets to the default `normal`. Applies immediately.',
    hintDescriptions: { zh: '让整个界面相对终端四边内缩。←/→ 循环预设（none / slim / normal / roomy）；Enter 输入自定义 `NxM`：左右各 N 列、上下各 M 行（如 3x1，上限 8x4；只填 N 则上下保持 1 行）。清空恢复默认 normal。立即生效。' },
    kind: 'text',
    options: [
      { value: 'none', label: 'None', descriptions: { zh: '无' } },
      { value: 'slim', label: 'Slim', descriptions: { zh: '窄' } },
      { value: 'normal', label: 'Normal', descriptions: { zh: '常规' } },
      { value: 'roomy', label: 'Roomy', descriptions: { zh: '宽' } },
    ],
  },
  'promptSessionLabel': {
    label: 'Session name chip',
    descriptions: { zh: '会话名标签' },
    group: 'conversation',
    hint: 'Show the session name on the prompt top border, right corner. Off by default.',
    hintDescriptions: { zh: '在输入框顶边框右上角显示会话名。默认关闭。' },
    kind: 'boolean',
  },
  'recapOnOpen': {
    label: 'Auto recap on open',
    descriptions: { zh: '打开会话时自动总结' },
    group: 'conversation',
    hint: 'On: opening/resuming a session automatically summarizes its recent activity into a dim line at the bottom of the transcript (hover/click to view or apply the suggested title). Off: use /recap manually.',
    hintDescriptions: { zh: '开启：打开/恢复会话时自动把最近活动总结成一行灰字显示在会话底部（可悬停/点击查看或应用建议标题）；关闭：手动使用 /recap。' },
    kind: 'boolean',
  },
  'scrollGutter': {
    label: 'Transcript gutter',
    descriptions: { zh: '转录边栏' },
    group: 'appearance',
    hint: 'Right gutter of the fullscreen transcript: per-turn timeline ticks, a proportional scrollbar, or nothing.',
    hintDescriptions: { zh: '全屏转录区右侧边栏：按轮次的时间线节点、比例滚动条，或留空。' },
    kind: 'select',
    options: [
      { value: 'timeline', label: 'Turn timeline', descriptions: { zh: '轮次时间线' } },
      { value: 'scrollbar', label: 'Scrollbar', descriptions: { zh: '滚动条' } },
      { value: 'hidden', label: 'Hidden', descriptions: { zh: '隐藏' } },
    ],
  },
  'sidePanel.open': {
    label: 'Side panel starts open',
    descriptions: { zh: '启动时展开侧栏' },
    group: 'side-panel',
    hint: 'Whether a session opens with the sidebar already expanded (Ctrl+B or /panel toggles it any time). Off by default, so the upgrade leaves the layout exactly as it was until asked; the in-session toggle is not persisted. Applies immediately.',
    hintDescriptions: { zh: '打开会话时侧栏是否已展开（随时可用 Ctrl+B 或 /panel 切换）。默认关闭，升级后界面与原来完全一致，除非主动开启；会话内的切换不会写回设置。立即生效。' },
    kind: 'boolean',
  },
  'sidePanel.panels': {
    label: 'Enabled panels',
    descriptions: { zh: '启用的面板' },
    group: 'side-panel',
    hint: 'Comma-separated panel ids in PanelBar order (default `todo,jobs,agents`). Ids are lowercase words (a-z, 0-9, _, -) or a `plugin:panel` namespace; a well-formed id no panel claims yet stays in the bar for a plugin that registers it later, while a malformed entry is refused. Add `companion` to enable the pet panel. Applies immediately.',
    hintDescriptions: { zh: '按标签栏顺序排列的面板 id，逗号分隔（默认 `todo,jobs,agents`）。id 为小写词组（a-z、0-9、_、-）或 `plugin:panel` 命名空间；格式合法但尚无面板认领的 id 会留在标签栏，等插件稍后注册，格式非法的输入会被直接拒绝。加上 `companion` 可启用宠物面板。立即生效。' },
    kind: 'text',
  },
  'sidePanel.ratio': {
    label: 'Chat column width',
    descriptions: { zh: '聊天列占比' },
    group: 'side-panel',
    hint: 'Chat column as a fraction of the content width: 0.1-0.95, default 0.68. Type a decimal such as `0.6`; while the panel has focus the +/- shortcuts nudge it live for the current session. Applies immediately.',
    hintDescriptions: { zh: '聊天列占内容宽度的比例：0.1-0.95，默认 0.68。输入小数如 `0.6`；面板获得焦点时可用 +/- 在会话内实时微调。立即生效。' },
    kind: 'number',
  },
  'sidePanel.splitEnabled': {
    label: 'Split layout',
    descriptions: { zh: '分栏布局' },
    group: 'side-panel',
    hint: 'Master switch of the split layout: on (default) Ctrl+B and /panel open the side column next to the chat; off makes both fall back to the fullscreen panels. Applies immediately.',
    hintDescriptions: { zh: '分栏总开关：开启（默认）时 Ctrl+B 与 /panel 在聊天右侧展开侧栏；关闭时两者都退回整屏面板。立即生效。' },
    kind: 'boolean',
  },
  'smoothStreaming': {
    label: 'Smooth streaming',
    descriptions: { zh: '流式平滑输出' },
    group: 'conversation',
    hint: 'Reveal live replies, expanded thinking, and tool-call bodies through an even ~30fps flow instead of per-burst jumps; one-shot non-streaming replies paint as a flow too. Replay/history always paints complete. On by default.',
    hintDescriptions: { zh: '把实时回复、展开的思考与工具卡正文按 ~30fps 匀速揭示，不再随供应商突发一跳一跳；一次性到达的非流式回复也会平滑打出。回放/历史内容始终完整直出。默认开启。' },
    kind: 'boolean',
  },
  'splashFont': {
    label: 'Splash font',
    descriptions: { zh: '开屏大字字体' },
    group: 'splash',
    hint: 'Big-text face on the header splash. Daily rotates by local date (default); pick a face to pin that one. Applies immediately.',
    hintDescriptions: { zh: '开屏头部的大字字面。按天轮换（默认）随本地日期换款；选某一款即固定那一款。立即生效。' },
    kind: 'select',
    options: SPLASH_FONT_OPTIONS,
  },
  'statusBar.activity': {
    label: 'Show activity summary',
    descriptions: { zh: '显示活动摘要' },
    hint: 'Show the idle working-activity summary.',
    hintDescriptions: { zh: '显示空闲时的工作活动摘要。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.cache': {
    label: 'Show cache',
    descriptions: { zh: '显示缓存' },
    hint: 'Show prompt-cache hit information.',
    hintDescriptions: { zh: '显示提示词缓存命中信息。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.compact': {
    label: 'Compact status bar',
    descriptions: { zh: '紧凑状态栏' },
    hint: 'Prefer the compact status presentation when terminal space allows.',
    hintDescriptions: { zh: '终端空间允许时优先使用紧凑状态栏布局。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.contextBar': {
    label: 'Show context progress bar',
    descriptions: { zh: '显示上下文进度条' },
    hint: 'Show the segmented context progress bar on its own footer row.',
    hintDescriptions: { zh: '在底部单独一行显示分段上下文进度条。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.contextUsage': {
    label: 'Show context usage',
    descriptions: { zh: '显示上下文用量' },
    hint: 'Show current context-window consumption.',
    hintDescriptions: { zh: '显示当前上下文窗口占用情况。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.cost': {
    label: 'Show session cost estimate',
    descriptions: { zh: '显示本会话花费估算' },
    hint: 'Show the estimated session spend (≈¥) next to the token totals. Only appears for official DeepSeek providers whose model has a known price; the estimate follows the official per-million-token rates (peak/idle hours) and is not a bill.',
    hintDescriptions: { zh: '在 Token 总量旁显示本会话花费估算（≈¥）。仅在使用 DeepSeek 官方 API key 且模型有已知单价时显示；按官方每百万 token 单价（高峰/空闲时段）估算，非账单。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.cwd': {
    label: 'Show working directory',
    descriptions: { zh: '显示工作目录' },
    hint: 'Show the session working directory.',
    hintDescriptions: { zh: '显示当前会话的工作目录。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.gitBranch': {
    label: 'Show git branch',
    descriptions: { zh: '显示 Git 分支' },
    hint: 'Show the current git branch when available.',
    hintDescriptions: { zh: '可用时显示当前 Git 分支。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.goal': {
    label: 'Show goal status',
    descriptions: { zh: '显示 Goal 状态' },
    hint: 'Show a compact goal chip (phase glyph + rounds) in the status footer while a goal exists.',
    hintDescriptions: { zh: '存在 Goal 时，在底部状态栏显示紧凑的 Goal 状态（阶段符号与轮次）。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.mode': {
    label: 'Show session mode',
    descriptions: { zh: '显示会话模式' },
    hint: 'Show the active non-default session mode.',
    hintDescriptions: { zh: '显示当前启用的非默认会话模式。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.model': {
    label: 'Show model',
    descriptions: { zh: '显示模型' },
    hint: 'Show the live model id in the status bar.',
    hintDescriptions: { zh: '在状态栏显示当前模型标识。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.sessionId': {
    label: 'Show session id',
    descriptions: { zh: '显示会话 ID' },
    hint: 'Show the short session id (# + first 8 chars) — it matches the session log filename for --resume.',
    hintDescriptions: { zh: '显示短会话 ID（# + 前 8 位）——与日志文件名对应，方便 --resume 定位。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.sessionTitle': {
    label: 'Show session title',
    descriptions: { zh: '显示会话标题' },
    hint: 'Show the current session title.',
    hintDescriptions: { zh: '显示当前会话标题。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.shortcutHint': {
    label: 'Show shortcut reminder',
    descriptions: { zh: '显示快捷键提示' },
    hint: 'Control only the idle `? for shortcuts` reminder; pressing ? and the Esc shortcut hints are unaffected.',
    hintDescriptions: { zh: '仅控制空闲时的 `? for shortcuts` 提示；按 ? 打开快捷键以及 Esc 快捷提示均不受影响。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.thinking': {
    label: 'Show thinking',
    descriptions: { zh: '显示思考' },
    hint: 'Show the live reasoning effort or thinking mode.',
    hintDescriptions: { zh: '显示当前推理强度或思考模式。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.tokens': {
    label: 'Show token totals',
    descriptions: { zh: '显示 Token 总量' },
    hint: 'Show running input and output token totals.',
    hintDescriptions: { zh: '显示累计输入与输出 Token。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.tps': {
    label: 'Show output speed',
    descriptions: { zh: '显示输出速度' },
    hint: 'Show live and recent tokens-per-second metrics.',
    hintDescriptions: { zh: '显示实时及近期每秒 Token 指标。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'statusBar.trajectory': {
    label: 'Show trajectory strip',
    descriptions: { zh: '显示轨迹条' },
    hint: 'Show the animated mini trajectory strip at the footer edge.',
    hintDescriptions: { zh: '在状态栏边缘显示动态迷你轨迹条。' },
    kind: 'boolean',
    group: 'status-bar',
  },
  'terminalImages': {
    label: 'Terminal image previews',
    descriptions: { zh: '终端图片预览' },
    group: 'rendering',
    hint: 'Preview images in supported terminals. Use /restart to apply. Sending images is unaffected.',
    hintDescriptions: { zh: '在支持的终端中预览图片。修改后用 /restart 生效；不影响向模型发送图片。' },
    kind: 'boolean',
  },
  'thinkingFold': {
    label: 'Thinking display',
    descriptions: { zh: '思考块展示' },
    group: 'conversation',
    hint: 'Preview shows 2-3 live lines; Full stays expanded until turn end. Click a streaming block to switch between preview and full.',
    hintDescriptions: { zh: '预览模式显示 2-3 行动态思考；展开模式保持至轮末。点击流式思考块可在预览与全文间切换。' },
    kind: 'select',
    options: [
      { value: 'preview', label: 'Preview (2-3 lines)', descriptions: { zh: '预览（2-3 行）' } },
      { value: 'full', label: 'Full until turn end', descriptions: { zh: '展开至轮末' } },
    ],
  },
  'toolBackground': {
    label: 'Tool background',
    descriptions: { zh: '工具卡背景' },
    group: 'appearance',
    hint: 'Choose whether tool-call cards add no, subtle, or strong background emphasis.',
    hintDescriptions: { zh: '选择工具调用卡片不添加、轻微或明显的背景强调。' },
    kind: 'select',
    options: [
      { value: 'none', label: 'None', descriptions: { zh: '无' } },
      { value: 'subtle', label: 'Subtle', descriptions: { zh: '轻微' } },
      { value: 'strong', label: 'Strong', descriptions: { zh: '明显' } },
    ],
  },
  'whale': {
    label: 'Header art',
    descriptions: { zh: '标题图形 logo' },
    group: 'splash',
    hint: 'Show the header splash art — the pixel whale, or the maid portrait when the setting below is on. Off leaves a text-only header.',
    hintDescriptions: { zh: '开屏头部显示图形 logo：像素鲸鱼（打开下方「女仆娘立绘」时显示女仆娘）。关闭则只留文字标题。' },
    kind: 'boolean',
  },
  'whaleGirl': {
    label: 'Maid portrait',
    descriptions: { zh: '女仆娘立绘' },
    group: 'splash',
    hint: 'Swap the header splash\'s pixel whale for the author-designed maid portrait, rendered FIRST as a real raster through the terminal image protocols (Kitty/Sixel); terminals without graphics support fall back to the character-art maid.',
    hintDescriptions: { zh: '把开屏头部的像素鲸鱼换成项目作者绘制的女仆娘立绘，最优先走终端图像协议（Kitty/Sixel）的真图渲染；终端不支持时回落到字符画版女仆娘。' },
    kind: 'boolean',
  },
  'whaleIdle': {
    label: 'Welcome whale idle',
    descriptions: { zh: '鲸鱼娘闲置动画（欢迎期）' },
    group: 'splash',
    hint: 'Welcome-phase idle behaviors: after the intro the whale flutters its fins, thumps its tail, and dozes off when idle; clicking wakes a dozing whale and pops a heart. The first agent turn freezes it to the static standard frame.',
    hintDescriptions: { zh: '欢迎期闲置行为：开屏后鲸鱼娘摆鱼鳍、偶尔拍尾巴，空闲会睡着冒 Z；点击唤醒睡着的鲸鱼娘并冒爱心。开始第一个任务后定格为静态标准帧。' },
    kind: 'boolean',
  },
} satisfies Record<string, SettingDefinition>

export type SettingKey = keyof typeof SETTING_DEFINITIONS

/**
 * Topic groups for /settings, in root-page order. Two presentations share
 * this list: 'inline' groups render their fields directly on the root page
 * under a small header (shallow topics — hiding a handful of fields behind
 * a navigation row costs more clicks than the ordering buys), 'page' groups
 * render one navigation row and keep their fields a level down (deep,
 * cohesive domains: the formula trio, the status-bar block, the shortcut
 * remaps). Every built-in setting names one of these (verified by
 * scripts/verify-settings-definitions.ts); a field without a group would
 * render on the root under "general". */
export const SETTING_GROUPS = [
  { id: 'appearance', mode: 'inline', title: 'Appearance', descriptions: { zh: '外观与布局' } },
  { id: 'splash', mode: 'inline', title: 'Splash', descriptions: { zh: '开屏与吉祥物' } },
  { id: 'conversation', mode: 'inline', title: 'Conversation', descriptions: { zh: '对话与输入' } },
  { id: 'rendering', mode: 'inline', title: 'Rendering', descriptions: { zh: '图表与图片' } },
  { id: 'math', mode: 'page', title: 'Formula', descriptions: { zh: '公式设置' } },
  { id: 'status-bar', mode: 'page', title: 'Status bar', descriptions: { zh: '底栏设置' } },
  { id: 'side-panel', mode: 'page', title: 'Side panel', descriptions: { zh: '侧栏' } },
  { id: 'shortcuts', mode: 'page', title: 'Shortcuts', descriptions: { zh: '快捷键' } },
] as const

/**
 * Top-level Config keys the settings service may edit at runtime: every
 * defined setting's root, plus the shortcut remaps. Keys without a Config
 * schema field (state read straight from the settings namespace) are
 * ignored by editableConfig.
 */
export const EDITABLE_CONFIG_KEYS: readonly string[] = [
  ...new Set([...Object.keys(SETTING_DEFINITIONS).map(key => key.split('.')[0]!), 'shortcuts']),
]

/** The static part of a /settings field for `key` (path included). */
export function settingField(key: SettingKey): SettingDefinition & { path: readonly string[] } {
  return { path: key.split('.'), ...SETTING_DEFINITIONS[key] }
}

/**
 * Shortcut remap fields (`shortcuts.<action>`): one per SHORTCUT_ACTIONS
 * entry; the help text names the platform's default combos.
 */
export const SHORTCUT_FIELD_META: Record<ShortcutActionId, { label: string; zh: string; hintEn: (defaults: string) => string; hintZh: (defaults: string) => string }> = {
  paste: {
    label: 'Paste shortcut',
    zh: '粘贴快捷键',
    hintEn: d => `Clipboard paste (text, file paths, images). Default: ${d}. Alt+V works where the terminal eats Ctrl+V.`,
    hintZh: d => `剪贴板粘贴（文本、文件路径、图片）。默认 ${d}。终端吞掉 Ctrl+V 时可用 Alt+V。`,
  },
  history: {
    label: 'History search shortcut',
    zh: '历史搜索快捷键',
    hintEn: d => `Open the prompt-history search. Default: ${d}.`,
    hintZh: d => `打开输入历史搜索。默认 ${d}。`,
  },
  editor: {
    label: 'External editor shortcut',
    zh: '外部编辑器快捷键',
    hintEn: d => `Edit the draft in $VISUAL/$EDITOR. Default: ${d}.`,
    hintZh: d => `在 $VISUAL/$EDITOR 外部编辑器中编辑草稿。默认 ${d}。`,
  },
  transcript: {
    label: 'Transcript mode shortcut',
    zh: '转录模式快捷键',
    hintEn: d => `Toggle expanded transcript mode. Default: ${d}.`,
    hintZh: d => `切换展开转录模式。默认 ${d}。`,
  },
  trajectory: {
    label: 'Trajectory scene shortcut',
    zh: '轨迹场景快捷键',
    hintEn: d => `Open the trajectory scene. Default: ${d}.`,
    hintZh: d => `打开轨迹场景。默认 ${d}。`,
  },
  dashboard: {
    label: 'Subagent dashboard shortcut',
    zh: '子代理面板快捷键',
    hintEn: d => `Open the subagent dashboard. Default: ${d}.`,
    hintZh: d => `打开子代理面板。默认 ${d}。`,
  },
  contextPanel: {
    label: 'Loaded-context panel shortcut',
    zh: '加载上下文面板快捷键',
    hintEn: d => `Toggle the startup loaded-context panel. Default: ${d}.`,
    hintZh: d => `切换启动时的已加载上下文面板。默认 ${d}。`,
  },
  continue: {
    label: 'Continue last session shortcut',
    zh: '继续上次会话快捷键',
    hintEn: d => `On the launchpad, resume the most recent session. Default: ${d}. Only bound while the launchpad is up.`,
    hintZh: d => `在启动页上继续最近一条会话。默认 ${d}。仅在启动页生效。`,
  },
  showAll: {
    label: 'Show-all shortcut',
    zh: '显示全部消息快捷键',
    hintEn: d => `Toggle show-all-messages. Default: ${d}.`,
    hintZh: d => `切换显示全部消息。默认 ${d}。`,
  },
  redraw: {
    label: 'Redraw shortcut',
    zh: '终端重绘快捷键',
    hintEn: d => `Clear and repaint the terminal. Default: ${d}.`,
    hintZh: d => `清空并重绘终端。默认 ${d}。`,
  },
  goalDetails: {
    label: 'Goal details shortcut',
    zh: '目标全文快捷键',
    hintEn: d => `Open the full goal text with wrapping and scrolling. Default: ${d}.`,
    hintZh: d => `打开自动换行、可滚动的目标全文。默认 ${d}。`,
  },
  todoFold: {
    label: 'Todo fold shortcut',
    zh: '待办折叠快捷键',
    hintEn: d => `Fold/unfold the goal/todo panel. Default: ${d}.`,
    hintZh: d => `折叠/展开目标与待办面板。默认 ${d}。`,
  },
  questionFold: {
    label: 'Question panel fold shortcut',
    zh: '提问面板折叠快捷键',
    hintEn: d => `Fold/unfold the pending question panel. Default: ${d}.`,
    hintZh: d => `折叠/展开等待回答的提问面板。默认 ${d}。`,
  },
  expandEditor: {
    label: 'Fullscreen editor shortcut',
    zh: '全屏草稿编辑快捷键',
    hintEn: d => `Toggle the fullscreen draft editor (Enter inserts a newline, Ctrl+Enter sends). Default: ${d}.`,
    hintZh: d => `切换全屏草稿编辑器（Enter 换行、Ctrl+Enter 发送）。默认 ${d}。`,
  },
  star: {
    label: 'One-key star shortcut',
    zh: '一键 star 快捷键',
    hintEn: d => `Star the project via the gh CLI (same action as /star and the splash line's click). Default: ${d}.`,
    hintZh: d => `用 gh 给项目点 star（与 /star、开屏标语点击同一个动作）。默认 ${d}。`,
  },
  undo: {
    label: 'Draft undo shortcut',
    zh: '草稿撤销快捷键',
    hintEn: d => `Undo the prompt draft one word-level step at a time (text, caret and images together). Draft-only: submitted or history-recalled text is out of scope (Esc Esc rewinds turns, Ctrl+R recalls history). Default: ${d}.`,
    hintZh: d => `按词撤销输入框草稿（文本、光标、图片一起回退）。只作用于草稿：提交或用历史召回后不可撤销；与 Esc Esc 回溯、Ctrl+R 历史召回不是一回事。默认 ${d}。`,
  },
  sidePanel: {
    label: 'Side panel shortcut',
    zh: '侧栏快捷键',
    hintEn: d => `Smart three-state sidebar toggle: closed → open+focus → focus chat → closed. Default: ${d}. tmux users should remap it (the prefix eats Ctrl+B).`,
    hintZh: d => `侧栏智能三态：关闭 → 打开并聚焦 → 焦点回聊天 → 关闭。默认 ${d}。tmux 用户请改键（前缀会吞掉它）。`,
  },
  sidePanelZoom: {
    label: 'Side panel zoom shortcut',
    zh: '侧栏缩放快捷键',
    hintEn: d => `Zoom the active side panel (chat keeps its minimum width). Default: ${d}.`,
    hintZh: d => `缩放当前侧栏面板（聊天列保留最小宽度）。默认 ${d}。`,
  },
}
