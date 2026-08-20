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
    id: 'keys-ctrl-x',
    group: 'keys',
    zh: 'Ctrl+X 用 $VISUAL 编辑器编辑当前输入',
    en: 'Ctrl+X edits your input in the $VISUAL editor',
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
    zh: 'Home/End 与 Ctrl+A 快速到行首/行尾',
    en: 'Home/End and Ctrl+A jump to line start/end',
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
    zh: 'Ctrl+V 粘贴文本、文件路径或图片附件',
    en: 'Ctrl+V pastes text, file paths, or image attachments',
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
    zh: '单击消息行展开/收起；点链接直接打开浏览器',
    en: 'Click a message row to expand it; click links to open the browser',
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
    zh: '/resume 里直接打字即可搜索会话',
    en: 'In /resume, just type to search sessions',
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
    id: 'cmd-tokens',
    group: 'commands',
    zh: '/tokens 看 token 明细与上下文百分比',
    en: '/tokens shows token details and context percentage',
  },
  {
    id: 'cmd-preset',
    group: 'commands',
    zh: '/preset 切换 agent 预设（standard/code 等）',
    en: '/preset switches presets: standard/code/minimal/cordis/liangshen',
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
    id: 'cmd-audit',
    group: 'commands',
    zh: '/audit 全面代码审计；/review 代码评审',
    en: '/audit runs a code audit; /review reviews the code',
  },
  {
    id: 'cmd-vuln',
    group: 'commands',
    zh: '/vuln-check 扫依赖漏洞；/bug 生成结构化 bug 报告',
    en: '/vuln-check scans dependencies; /bug drafts a bug report',
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
    id: 'cmd-permission',
    group: 'commands',
    zh: '/permission 切换权限预设（read-only/workspace/full）',
    en: '/permission switches permission presets (read-only/workspace/full)',
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
    id: 'flow-resume',
    group: 'workflow',
    zh: '/resume 里 Ctrl+S 折叠子 agent 运行',
    en: 'In /resume, Ctrl+S folds subagent runs',
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
    zh: '任意位置 @ 补全文件，@ink 也能命中 src/ink',
    en: '@ completes files anywhere; @ink matches src/ink',
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
    zh: '自定义主题：~/.dsh-tui/themes/<名>.json 即写即热切换',
    en: 'Custom themes: ~/.dsh-tui/themes/<name>.json, hot-swappable',
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
    id: 'disp-whale',
    group: 'display',
    zh: '首屏鲸鱼动画（终端 ≥64 列才显示）',
    en: 'The whale intro shows on terminals ≥64 columns',
  },

  // ── 避坑 ──────────────────────────────────────────────────
  {
    id: 'pit-busy',
    group: 'pitfalls',
    zh: '回合运行中 /compact /model 会被拒绝，先 Ctrl+C',
    en: '/compact and /model refuse while working — Ctrl+C first',
  },
  {
    id: 'pit-esc',
    group: 'pitfalls',
    zh: '审批条 Esc=拒绝；问卷 Esc=取消整批提问',
    en: 'Esc rejects approvals and cancels question batches',
  },
  {
    id: 'pit-ctrl-c',
    group: 'pitfalls',
    zh: 'Ctrl+C 有输入时先清空，连按两次才退出',
    en: 'Ctrl+C clears input first; double-tap to exit',
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
    id: 'pit-version-skew',
    group: 'pitfalls',
    zh: '提示版本错位时，按提示 npm install -g 对齐启动器',
    en: 'On version skew, follow the npm install -g hint to align the launcher',
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
    zh: '鼠标操作仅在全屏模式（fullscreen）下生效',
    en: 'Mouse support only works in fullscreen mode',
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
