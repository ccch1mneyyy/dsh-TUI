/**
 * 精简 Tips 池 —— 启动首屏轮换（LogoV2）与 `/tips` 命令面板共用。
 *
 * 设计约定：
 * - 每条 tip 一句话，中文 ≤ 约 60 字符、英文 ≤ 约 100 字符，首屏单行可读
 *   （窄终端自动截断）；
 * - 文案只讲"用户能立刻用上"的操作，不讲实现细节；
 * - id 稳定（面板按 id 去重/排序），group 用于 `/tips` 面板分组展示；
 * - 与 docs/user-guide.md 同源：文档是详版，这里是精版，覆盖全部功能面。
 */

export type TipGroup = 'keys' | 'commands' | 'workflow' | 'display' | 'pitfalls'

export interface Tip {
  id: string
  group: TipGroup
  zh: string
  en: string
}

export const TIP_GROUP_LABELS: Record<TipGroup, { zh: string; en: string }> = {
  keys: { zh: '快捷键', en: 'Shortcuts' },
  commands: { zh: '命令', en: 'Commands' },
  workflow: { zh: '工作流', en: 'Workflow' },
  display: { zh: '界面与个性化', en: 'Display' },
  pitfalls: { zh: '避坑', en: 'Gotchas' },
}

export const TIPS: readonly Tip[] = [
  // ── 快捷键 ────────────────────────────────────────────────
  {
    id: 'keys-rewind',
    group: 'keys',
    zh: '空输入双击 Esc = 时间回溯，可改完重发',
    en: 'Double-Esc on empty input rewinds time; edit and resend',
  },
  {
    id: 'keys-esc-levels',
    group: 'keys',
    zh: 'Esc 逐层关闭：帮助 → 命令/文件菜单 → 清空输入',
    en: 'Esc closes layers: help → command/file menus → clear input',
  },
  {
    id: 'keys-ctrl-o',
    group: 'keys',
    zh: 'Ctrl+O 展开/收起思考全文与工具详情',
    en: 'Ctrl+O expands thinking text and tool details',
  },
  {
    id: 'keys-ctrl-r',
    group: 'keys',
    zh: 'Ctrl+R 搜索输入历史，重复按跳下一匹配',
    en: 'Ctrl+R searches input history; press again for next match',
  },
  {
    id: 'keys-ctrl-t',
    group: 'keys',
    zh: 'Ctrl+T 打开会话轨迹场景（同 /trace）',
    en: 'Ctrl+T opens the session trajectory scene (same as /trace)',
  },
  {
    id: 'keys-traj-fail',
    group: 'keys',
    zh: '轨迹里 [ / ] 跳上/下一个失败点，{ / } 跳轮次',
    en: 'In trajectory: [ / ] jump failures, { / } jump turns',
  },
  {
    id: 'keys-traj-query',
    group: 'keys',
    zh: '轨迹按 / 查询：tool:kind:err:>10s tok>1k 等字段',
    en: 'In trajectory, / queries fields like tool:, err:, >10s, tok>1k',
  },
  {
    id: 'keys-ctrl-g',
    group: 'keys',
    zh: 'Ctrl+G 用 $VISUAL/$EDITOR 编辑器编辑当前输入',
    en: 'Ctrl+G edits your input in the $VISUAL/$EDITOR editor',
  },
  {
    id: 'keys-vim',
    group: 'keys',
    zh: '/vim 开启输入框 vim 编辑：Esc 切 normal，i/a/o 回 insert',
    en: '/vim enables vim editing: Esc to normal, i/a/o back to insert',
  },
  {
    id: 'keys-ctrl-enter',
    group: 'keys',
    zh: 'Ctrl+Enter 打断当前回合并立即发送',
    en: 'Ctrl+Enter interrupts the turn and sends immediately',
  },
  {
    id: 'keys-shift-enter',
    group: 'keys',
    zh: 'Shift+Enter 换行；终端不认修饰键时用 Ctrl+J',
    en: 'Shift+Enter inserts a newline; Ctrl+J works when modifiers are lost',
  },
  {
    id: 'keys-ctrl-e',
    group: 'keys',
    zh: 'Ctrl+E：输入框到行尾；转录中展开隐藏旧消息',
    en: 'Ctrl+E: line end in input; reveals old messages in transcript',
  },
  {
    id: 'keys-ctrl-l',
    group: 'keys',
    zh: 'Ctrl+L 清屏并强制重绘，画面花了按它',
    en: 'Ctrl+L clears and force-redraws a garbled screen',
  },
  {
    id: 'keys-ctrl-p',
    group: 'keys',
    zh: 'Ctrl+P 切换启动时的上下文加载面板',
    en: 'Ctrl+P toggles the startup loaded-context panel',
  },
  {
    id: 'keys-home-end',
    group: 'keys',
    zh: 'Home/End 到行首/行尾，Ctrl+E 到行尾',
    en: 'Home/End jump to line start/end; Ctrl+E to line end',
  },
  {
    id: 'keys-ctrl-a',
    group: 'keys',
    zh: 'Ctrl+A 子代理面板：Enter 看详情 · X 中断 · Esc 关',
    en: 'Ctrl+A opens the subagent dashboard; Enter details, X interrupt, Esc close',
  },
  {
    id: 'keys-edit-keys',
    group: 'keys',
    zh: 'Ctrl+U/K/W 快速删行首/行尾/前一词',
    en: 'Ctrl+U/K/W delete to line start, end, or previous word',
  },
  {
    id: 'keys-shift-tab',
    group: 'keys',
    zh: 'Shift+Tab 循环会话模式：默认→计划→完全访问',
    en: 'Shift+Tab cycles modes: default → plan → full access',
  },
  {
    id: 'keys-shift-up',
    group: 'keys',
    zh: 'Shift+↑ 进入消息选择模式，Enter 展开单条',
    en: 'Shift+↑ enters message selection; Enter expands one row',
  },
  {
    id: 'keys-help',
    group: 'keys',
    zh: '按 ? 随时查看快捷键菜单（输入框为空时）',
    en: 'Press ? anytime for the shortcut menu (empty input)',
  },
  {
    id: 'keys-paste',
    group: 'keys',
    zh: 'Ctrl+V 或 Alt+V 粘贴文本、文件路径或图片附件；/settings 可改快捷键',
    en: 'Ctrl+V or Alt+V pastes text, file paths, or image attachments; remappable in /settings',
  },
  {
    id: 'keys-slash-search',
    group: 'keys',
    zh: '转录态按 / 全文搜索，n / N 前后跳转',
    en: 'In transcript mode, / searches; n / N jump between hits',
  },
  {
    id: 'keys-mouse-click',
    group: 'keys',
    zh: '工具卡/thinking/摘要点击展开，子代理卡点击看详情；输入框点击定位光标',
    en: 'Click tool/thinking/summary rows to fold; subagent cards open detail; click input to move caret',
  },
  {
    id: 'keys-mouse-scenes',
    group: 'keys',
    zh: '轨迹与 /settings 支持鼠标：行点击跳转/编辑，滚轮移动光标或焦点',
    en: 'Trajectory and /settings take the mouse: row clicks jump/edit, the wheel moves cursor or focus',
  },

  // ── 命令 ──────────────────────────────────────────────────
  {
    id: 'cmd-new-resume',
    group: 'commands',
    zh: '/new 新会话；/resume 恢复历史会话',
    en: '/new starts a session; /resume brings back old ones',
  },
  {
    id: 'cmd-resume-search',
    group: 'commands',
    zh: '/resume 顶部可选工作目录，← 切目录，打字搜索当前层',
    en: '/resume has a directory selector; ← switches scope, typing searches the active list',
  },
  {
    id: 'cmd-rename',
    group: 'commands',
    zh: '/rename <标题> 给会话起个好名字',
    en: '/rename <title> gives the session a proper name',
  },
  {
    id: 'cmd-clear',
    group: 'commands',
    zh: '/clear 只清视图不动会话日志，放心用',
    en: '/clear wipes the view, not the log',
  },
  {
    id: 'cmd-compact',
    group: 'commands',
    zh: '/compact 压缩上下文，长会话救星',
    en: '/compact condenses context — a lifesaver for long sessions',
  },
  {
    id: 'cmd-export',
    group: 'commands',
    zh: '/export 把完整会话导出为 Markdown（含思考）',
    en: '/export saves the full session as Markdown (thinking included)',
  },
  {
    id: 'cmd-btw',
    group: 'commands',
    zh: '/btw 侧问：不打断主回合、不留历史',
    en: '/btw asks aside: no interruption, no history',
  },
  {
    id: 'cmd-recap',
    group: 'commands',
    zh: '/recap 总结近期活动并建议标题，a 键应用',
    en: '/recap summarizes recent activity and suggests a title; a applies it',
  },
  {
    id: 'cmd-jobs',
    group: 'commands',
    zh: '/jobs 面板实时跟踪后台任务：状态、运行时长、退出码，k 键停止',
    en: '/jobs tracks background jobs live: status, elapsed time, exit code; k kills',
  },
  {
    id: 'cmd-status',
    group: 'commands',
    zh: '/status 看模型、分支、token 与上下文占用',
    en: '/status shows model, branch, tokens, and context usage',
  },
  {
    id: 'cmd-cost',
    group: 'commands',
    zh: '/cost 看 token 用量与缓存命中率',
    en: '/cost shows token usage and cache hit rate',
  },
  {
    id: 'cmd-balance',
    group: 'commands',
    zh: '/balance 查 DeepSeek 官方余额，点击行可刷新',
    en: '/balance shows your DeepSeek balance; click the row to refresh',
  },
  {
    id: 'cmd-context',
    group: 'commands',
    zh: '/context 查看已加载的上下文明细',
    en: '/context lists the loaded context in detail',
  },
  {
    id: 'cmd-doctor',
    group: 'commands',
    zh: '/doctor 环境自检，出问题先跑它',
    en: '/doctor checks your environment — run it first when stuck',
  },
  {
    id: 'cmd-config',
    group: 'commands',
    zh: '/config 看配置来源与启动方式',
    en: '/config shows config sources and how you launched',
  },
  {
    id: 'cmd-reload',
    group: 'commands',
    zh: '/reload 重读偏好文件并即时应用（主题/语言/预设/模型/动画）',
    en: '/reload re-reads pref files (theme/lang/preset/model/activity) and applies live',
  },
  {
    id: 'cmd-model',
    group: 'commands',
    zh: '/model 换模型会 fork 续聊，历史不丢',
    en: '/model forks to continue: history is preserved',
  },
  {
    id: 'cmd-effort',
    group: 'commands',
    zh: '/effort 滑杆 ←/→ 实时调推理强度',
    en: '/effort slider tunes reasoning effort live with ←/→',
  },
  {
    id: 'cmd-thinking',
    group: 'commands',
    zh: '/thinking 切换思考块的展开显示',
    en: '/thinking toggles expanded thinking display',
  },
  {
    id: 'cmd-color',
    group: 'commands',
    zh: '/color 会话强调色：无参调色板 / <名> 直设 / reset 清除，resume 后仍在',
    en: '/color sets a per-session accent: bare = palette, <name> direct, reset clears; survives resume',
  },
  {
    id: 'cmd-tokens',
    group: 'commands',
    zh: '/tokens 看 token 明细与上下文百分比',
    en: '/tokens shows token details and context percentage',
  },
  {
    id: 'cmd-preset',
    group: 'commands',
    zh: '/preset 切换 agent 预设（standard/ptc 等）',
    en: '/preset switches presets: standard/ptc/minimal/cordis/liangshen',
  },
  {
    id: 'cmd-preset-liangshen',
    group: 'commands',
    zh: '/preset liangshen 梁神模式：首轮最小工具，之后全开',
    en: '/preset liangshen starts minimal, then opens up',
  },
  {
    id: 'cmd-settings',
    group: 'commands',
    zh: '/settings 自定义底栏：开关 TPS/轨迹条/上下文条等',
    en: '/settings customizes the status bar: TPS, trajectory, context bars',
  },
  {
    id: 'cmd-workspace',
    group: 'commands',
    zh: '/workspace open <路径> 切换工作区',
    en: '/workspace open <path> switches the workspace',
  },
  {
    id: 'cmd-skills',
    group: 'commands',
    zh: '/skills 浏览技能目录',
    en: '/skills lists the skill catalog',
  },
  {
    id: 'cmd-agents',
    group: 'commands',
    zh: '/agents 列出子代理，Enter 看详情 / X 中断',
    en: '/agents lists subagents; Enter for details, X to interrupt',
  },
  {
    id: 'cmd-init',
    group: 'commands',
    zh: '/init 一键创建 AGENTS.md 项目规则',
    en: '/init creates AGENTS.md project rules',
  },
  {
    id: 'cmd-provider',
    group: 'commands',
    zh: '/provider 交互式添加自己的模型提供方',
    en: '/provider adds your own model provider interactively',
  },
  {
    id: 'cmd-login',
    group: 'commands',
    zh: '/login 查看凭证状态；/logout 登出',
    en: '/login shows credential status; /logout signs out',
  },
  {
    id: 'cmd-mcp',
    group: 'commands',
    zh: '/mcp 查看 MCP 服务器与工具连接',
    en: '/mcp lists MCP servers and their tools',
  },
  {
    id: 'cmd-plugins',
    group: 'commands',
    zh: '/plugins check <清单路径> 诊断插件兼容性',
    en: '/plugins check <manifest> diagnoses plugin compatibility',
  },
  {
    id: 'cmd-update',
    group: 'commands',
    zh: '/update 自动更新 TUI 并重启恢复会话',
    en: '/update updates the TUI and restarts, resuming the session',
  },
  {
    id: 'cmd-restart',
    group: 'commands',
    zh: '/restart 重启进程并恢复本会话',
    en: '/restart relaunches the process and resumes this session',
  },
  {
    id: 'cmd-permission',
    group: 'commands',
    zh: '/permission 弹出由 DSH registry 提供的权限预设选择器',
    en: '/permission opens the DSH registry-backed permission-preset picker',
  },
  {
    id: 'cmd-plan-goal',
    group: 'commands',
    zh: '/plan 计划模式；/goal 设置会话目标',
    en: '/plan enters plan mode; /goal sets a session goal',
  },

  // ── 工作流 ────────────────────────────────────────────────
  {
    id: 'flow-steer',
    group: 'workflow',
    zh: '模型工作时：Enter 加塞、Tab 排队、Ctrl+Enter 打断',
    en: 'While working: Enter steers, Tab queues, Ctrl+Enter interrupts',
  },
  {
    id: 'flow-alt-up',
    group: 'workflow',
    zh: 'Alt+Up 取回最后一条消息，改完重发',
    en: 'Alt+Up retrieves the last message to edit and resend',
  },
  {
    id: 'flow-rewind-fork',
    group: 'workflow',
    zh: '时间回溯会 fork 新会话，原消息回到输入框',
    en: 'Rewind forks a session; your message returns to the input',
  },
  {
    id: 'flow-tree',
    group: 'workflow',
    zh: '/tree 打开会话分叉树：悬停预览、点击回退/分叉/切分支',
    en: '/tree opens the session tree: hover to preview, click to rewind/fork/adopt',
  },
  {
    id: 'flow-tree-search',
    group: 'workflow',
    zh: '/tree 顶部搜索框直接打字过滤分支',
    en: 'In /tree, type in the search box to filter branches',
  },
  {
    id: 'flow-fork-copy',
    group: 'workflow',
    zh: '/fork 把当前会话复制成可恢复副本，原会话不受影响',
    en: '/fork copies the session into a resumable twin; the original is untouched',
  },
  {
    id: 'flow-resume',
    group: 'workflow',
    zh: '/resume 里 Ctrl+S 折叠子 agent 运行',
    en: 'In /resume, Ctrl+S folds subagent runs',
  },
  {
    id: 'flow-resume-clean',
    group: 'workflow',
    zh: '/resume 里 Ctrl+X 清理空壳会话',
    en: 'In /resume, Ctrl+X prunes empty sessions',
  },
  {
    id: 'flow-search',
    group: 'workflow',
    zh: 'Ctrl+R 搜历史输入；转录态 / 搜会话全文',
    en: 'Ctrl+R searches input history; / searches the transcript',
  },
  {
    id: 'flow-at',
    group: 'workflow',
    zh: '@ 补全支持模糊匹配；@src/ 直达该目录',
    en: '@ completes files with fuzzy matching; @dir/ lists that directory',
  },
  {
    id: 'flow-mention-lines',
    group: 'workflow',
    zh: '@src/a.ts#L12-14 精确引用文件行区间',
    en: 'Append #L12-14 to an @ path to cite exact line ranges',
  },
  {
    id: 'flow-question-type',
    group: 'workflow',
    zh: '问卷选项行直接打字 = 选项 + 自定义文本一起提交',
    en: 'Typing on a question row submits option + custom text',
  },
  {
    id: 'flow-plan-review',
    group: 'workflow',
    zh: '计划评审按 1 / 2 数字键快速批准或反馈',
    en: 'Plan review: press 1 / 2 to approve or give feedback fast',
  },
  {
    id: 'flow-approval',
    group: 'workflow',
    zh: '审批条按 1 允许（仅本次）/ 2 拒绝',
    en: 'Approval bar: 1 allows once, 2 rejects',
  },
  {
    id: 'flow-goals',
    group: 'workflow',
    zh: '模型写 Goals/Todos 时面板自动出现，无需操作',
    en: 'Goals/Todos appear automatically when the model writes them',
  },
  {
    id: 'flow-recap-open',
    group: 'workflow',
    zh: '打开会话自动出回顾摘要，点击回顾行展开详情',
    en: 'Opening a session auto-shows a recap; click the row to expand',
  },
  {
    id: 'flow-file-actions',
    group: 'workflow',
    zh: '全屏模式下点击转录中的文件路径：打开/定位/复制',
    en: 'Click a file path in the transcript (fullscreen): open, reveal, copy',
  },
  {
    id: 'flow-btw-copy',
    group: 'workflow',
    zh: '/btw 面板按 c 一键复制答案',
    en: 'In /btw, press c to copy the answer',
  },

  // ── 界面与个性化 ──────────────────────────────────────────
  {
    id: 'disp-statusbar',
    group: 'display',
    zh: '底栏 TPS、轨迹条、上下文条默认关，/settings 里打开',
    en: 'TPS, trajectory, context bars are off by default — enable in /settings',
  },
  {
    id: 'disp-statusbar-session-id',
    group: 'display',
    zh: '底栏可显示短会话 ID（# 前 8 位），与日志文件名对应，/settings 里开',
    en: 'Footer can show the short session id (# + 8 chars, matches the log filename) — enable in /settings',
  },
  {
    id: 'disp-statusbar-title',
    group: 'display',
    zh: '底栏可显示会话标题；/rename 随时改',
    en: 'Footer can show the session title; rename anytime with /rename',
  },
  {
    id: 'disp-statusbar-fields',
    group: 'display',
    zh: '底栏字段逐项开关：token 总量、git 分支、模式、活动摘要…… /settings 里配',
    en: 'Footer fields are per-field switches: token totals, git branch, mode, activity — set in /settings',
  },
  {
    id: 'disp-statusbar-compact',
    group: 'display',
    zh: '底栏 compact 开=单行收纳；关=左右分组（指标在左、位置在右）',
    en: 'Footer compact on = one merged line; off = metrics left, location right',
  },
  {
    id: 'disp-statusbar-hint',
    group: 'display',
    zh: "空闲时 '? 查看快捷键' 常驻提示也是底栏开关（shortcutHint）",
    en: 'The idle "? for shortcuts" reminder is itself a footer switch (shortcutHint)',
  },
  {
    id: 'disp-cost',
    group: 'display',
    zh: '底栏花费估算 ≈¥ 峰/谷：仅官方 DeepSeek 显示，/settings 可关',
    en: 'Footer cost estimate (peak/idle) shows only for official DeepSeek; toggle in /settings',
  },
  {
    id: 'disp-context-warn',
    group: 'display',
    zh: '上下文 ≥80% 变琥珀预警，该 /compact 了',
    en: 'Context ≥80% turns amber — time to /compact',
  },
  {
    id: 'disp-tps-color',
    group: 'display',
    zh: 'TPS 仪表：≥50 绿 / ≥20 黄 / <20 红',
    en: 'TPS gauge: ≥50 green / ≥20 yellow / <20 red',
  },
  {
    id: 'disp-theme',
    group: 'display',
    zh: '/theme auto 跟随终端背景色；/theme <名> 直接切',
    en: '/theme auto follows your terminal; /theme <name> switches directly',
  },
  {
    id: 'disp-theme-custom',
    group: 'display',
    zh: '主题：~/.dsh-tui/themes/<名>.json 或 npm 插件注册，即时热切换',
    en: 'Themes: ~/.dsh-tui/themes/<name>.json or npm plugin registration, hot-swappable',
  },
  {
    id: 'disp-theme-status',
    group: 'display',
    zh: '/theme status 查看 auto 实际解析到的色板',
    en: '/theme status shows which palette auto resolved to',
  },
  {
    id: 'disp-lang',
    group: 'display',
    zh: '/lang zh|en 界面语言即时切换',
    en: '/lang zh|en switches UI language instantly',
  },
  {
    id: 'disp-activity',
    group: 'display',
    zh: '/activity frames comet 换状态行动画（35 种）',
    en: '/activity frames comet changes the spinner (35 presets)',
  },
  {
    id: 'disp-diff-layout',
    group: 'display',
    zh: '/settings 里 diffLayout 切双栏/单栏 diff',
    en: 'In /settings, diffLayout switches split/unified diff',
  },
  {
    id: 'disp-settings-save',
    group: 'display',
    zh: '/settings 改动自动保存，Esc 直接退出',
    en: '/settings saves every change; Esc exits straight away',
  },
  {
    id: 'disp-thinking-fold',
    group: 'display',
    zh: '/settings 里 thinkingFold：preview 折叠 / full 全展开',
    en: 'In /settings, thinkingFold: preview folds, full expands',
  },
  {
    id: 'disp-tool-bg',
    group: 'display',
    zh: '/settings 里 toolBackground 调工具卡背景强调',
    en: 'In /settings, toolBackground tunes tool-card emphasis',
  },
  {
    id: 'disp-mouse',
    group: 'display',
    zh: '全屏模式鼠标拖选即复制；Esc 取消选区',
    en: 'Drag-select copies instantly in fullscreen; Esc cancels',
  },
  {
    id: 'disp-keymap',
    group: 'display',
    zh: '/settings → shortcuts 自定义快捷键，改完立即生效',
    en: 'Remap shortcuts in /settings → shortcuts; changes apply instantly',
  },
  {
    id: 'disp-hover-footer',
    group: 'display',
    zh: '悬停底栏字段：ctx 原地变等宽压力条，明细走常驻底行，布局不动',
    en: 'Hover footer fields: ctx morphs in place into a same-width bar, details on a stable line',
  },
  {
    id: 'disp-wheel-sel',
    group: 'display',
    zh: '有文本选区时，滚轮平移选区而非滚动列表',
    en: 'With a text selection, the wheel translates the selection, not the list',
  },
  {
    id: 'disp-whale',
    group: 'display',
    zh: '首屏鲸鱼动画（终端 ≥64 列才显示）',
    en: 'The whale intro shows on terminals ≥64 columns',
  },

  // ── 避坑 ──────────────────────────────────────────────────
  {
    id: 'pit-cost-approx',
    group: 'pitfalls',
    zh: '底栏花费是估算值，仅供参考，以 DeepSeek 平台为准',
    en: 'The footer cost is an estimate — the DeepSeek platform is authoritative',
  },
  {
    id: 'pit-busy',
    group: 'pitfalls',
    zh: '回合运行中 /compact /model 会被拒绝，先 Ctrl+C',
    en: '/compact and /model refuse while working — Ctrl+C first',
  },
  {
    id: 'pit-esc',
    group: 'pitfalls',
    zh: '审批条 Esc=拒绝；问卷第 2 题起 Esc=上一题，Ctrl+C=取消整批',
    en: 'Esc rejects approvals; question batches use Esc for previous and Ctrl+C to cancel',
  },
  {
    id: 'pit-ctrl-c',
    group: 'pitfalls',
    zh: 'Ctrl+C 工作时先中断；中断卡住再按强制退出；空闲连按两次退出',
    en: 'Ctrl+C interrupts; press again if it stalls, double-tap when idle',
  },
  {
    id: 'pit-unknown-cmd',
    group: 'pitfalls',
    zh: '未知命令会作为普通消息发给模型',
    en: 'Unknown commands are sent to the model as plain messages',
  },
  {
    id: 'pit-preset-lock',
    group: 'pitfalls',
    zh: '/preset 已开始的会话不可切换，新会话才生效',
    en: '/preset only applies to new sessions (blank-only rule)',
  },
  {
    id: 'pit-update',
    group: 'pitfalls',
    zh: '/update 需 dsh --profile 方式启动',
    en: '/update requires launching via dsh --profile',
  },
  {
    id: 'pit-reload-scope',
    group: 'pitfalls',
    zh: '/reload 不重读 cordis.yml 与全屏布局，改它们用 /restart',
    en: '/reload skips cordis.yml and fullscreen layout; use /restart for those',
  },
  {
    id: 'pit-restart-busy',
    group: 'pitfalls',
    zh: '/restart 回合运行中会被拒绝，先 Ctrl+C',
    en: '/restart is refused while a turn runs — Ctrl+C first',
  },
  {
    id: 'pit-version-skew',
    group: 'pitfalls',
    zh: '提示版本错位时，按提示 npm install -g 对齐启动器',
    en: 'On version skew, follow the npm install -g hint to align the launcher',
  },
  {
    id: 'pit-drift',
    group: 'pitfalls',
    zh: 'logo ⚠ 提示 dsh 版本不符时，按提示 npm i -g @deepseek-ai/dsh 对齐',
    en: 'When the logo warns about dsh versions, follow the npm i -g @deepseek-ai/dsh hint',
  },
  {
    id: 'pit-mac',
    group: 'pitfalls',
    zh: 'macOS ⌘ 键需 iTerm2/kitty/WezTerm/ghostty/tmux',
    en: 'macOS ⌘ needs iTerm2, kitty, WezTerm, ghostty, or tmux',
  },
  {
    id: 'pit-thinking',
    group: 'pitfalls',
    zh: '/thinking 开关不持久化，重启回默认',
    en: '/thinking does not persist across restarts',
  },
  {
    id: 'pit-minimal',
    group: 'pitfalls',
    zh: 'minimal preset 下 /compact 与问卷不可用',
    en: '/compact and questions are unavailable under minimal preset',
  },
  {
    id: 'pit-mouse-mode',
    group: 'pitfalls',
    zh: '主界面鼠标需开 fullscreen；轨迹/resume 整屏页两种模式都带鼠标',
    en: 'Main-chat mouse needs fullscreen; full-page screens (trajectory, /resume) have it in both modes',
  },
  {
    id: 'pit-env-rename',
    group: 'pitfalls',
    zh: '旧 CC_TUI_*/DSH_CC_* 环境变量已改名 DSH_TUI_*',
    en: 'Legacy CC_TUI_*/DSH_CC_* env vars are now DSH_TUI_*',
  },
  {
    id: 'pit-pnpm',
    group: 'pitfalls',
    zh: '需要 pnpm 10+（pnpm 9 会启动失败）',
    en: 'pnpm 10+ is required (pnpm 9 fails at startup)',
  },
  {
    id: 'pit-terminal',
    group: 'pitfalls',
    zh: '需要交互 TTY；推荐 Windows Terminal ≥110 列',
    en: 'An interactive TTY is required; try Windows Terminal ≥110 cols',
  },
]

/**
 * 启动随机轮换选择：每次启动随机取一条，让首屏每次都有新鲜感。
 * random 可注入以便测试固定（默认 Math.random）。
 */
export function pickRandomTip(random: () => number = Math.random): Tip {
  return TIPS[Math.floor(random() * TIPS.length)]!
}

/** 按分组取 tips（/tips 面板展示用，保持 TIPS 内顺序）。 */
export function tipsByGroup(group: TipGroup): Tip[] {
  return TIPS.filter(tip => tip.group === group)
}
