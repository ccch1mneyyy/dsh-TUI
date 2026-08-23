#!/usr/bin/env node
/**
 * CI 组内失败聚合器：把一个测试组从 GitHub Actions 默认的 fail-fast
 * （step 失败 → 后续 step 全部 skipped）改为「全部跑完、最后统一报告」。
 *
 * 背景（issue #466 收尾）：#467 的拆组把失败遮蔽范围从全 CI 缩小到单个
 * 组，但组内第一个失败的测试仍会遮蔽同组后续测试——修一个又冒一个。
 *
 * 用法（ci.yml 中每个测试组一条）：
 *   - run: node scripts/run-ci-group.mjs render-scroll
 *
 * 组定义在下方 GROUPS 表：名称 + 完整 argv + 可选附加 env（例如
 * measure-depth 需要 NODE_ENV=production）。新增测试时在此表登记——
 * 每条的注释即原 ci.yml 里该 step 上方的说明（迁移时保留）。
 *
 * 行为：
 *   - 逐条运行，实时透传 stdout/stderr（日志仍是每条测试的原始输出）；
 *   - 失败不中断，记录后继续；
 *   - 结束时汇总 ✓/✗ 清单，任一失败 exit 1 并给失败条目打 ::error。
 */
import { spawnSync } from 'node:child_process'

const env = { ...process.env }

const GROUPS = {
  'render-scroll': [
// 带断言的回归：提问面板内联输入（issue #9）+ 工具卡排版
// （⎿ 缩进、diff 红绿行、信封剥离），失败即非零退出。
    ["repro-askpanel", ['node', '--import', 'tsx/esm', 'scripts/repro-askpanel.tsx']],
// 提问面板全应用布局回归：短/长高录、activity tick 差分、resize 风暴。
    ["verify-askpanel-layout", ['node', '--import', 'tsx/esm', 'scripts/verify-askpanel-layout.tsx']],
    ["repro-toolcards", ['node', '--import', 'tsx/esm', 'scripts/repro-toolcards.tsx']],
    ["repro-diff-split", ['node', '--import', 'tsx/esm', 'scripts/repro-diff-split.tsx']],
// 滚动/pill/内联模式回归：新消息 pill 计数递减、Ctrl+C 交互、
// 内联 scrollback 第三方终端适配。曾因 mock channel 缺新字段而
// 静默冻结（render 期 TypeError 被 ink 吞掉），不在 CI 里烂了
// 整个 0.6.x 才被发现——挂进来防再烂。
    ["repro-pill", ['node', '--import', 'tsx/esm', 'scripts/repro-pill.tsx']],
    ["repro-ctrlc", ['node', '--import', 'tsx/esm', 'scripts/repro-ctrlc.tsx']],
// /settings 设置屏回归（issue #165）：开屏、staged 编辑、revision 栅栏
// 保存、密钥走 credentials、Esc 返回会话。
    ["repro-settings", ['node', '--import', 'tsx/esm', 'scripts/repro-settings.tsx']],
    ["repro-inline-scrollback", ['node', '--import', 'tsx/esm', 'scripts/repro-inline-scrollback.tsx']],
    ["repro-inline-thirdparty", ['node', '--import', 'tsx/esm', 'scripts/repro-inline-thirdparty.tsx']],
// 全屏 resize 空白回归：宽度变化清空行高缓存 → scrollHeight 估算塌缩，
// shrunk 帧冻结的旧 scrollTop 与失准的 clamp 边界越过内容底，整屏裁剪
// 成"只剩输入框"（Orca pane 宽度抖动的现场取证复现）。
    ["repro-resize-blank", ['node', '--import', 'tsx/esm', 'scripts/repro-resize-blank.tsx']],
// 空转重渲染风暴回归（issue #433）：长历史 + 30ms 空转 commit 风暴下
// renderScrollTop / 画面 / 输入框行数必须逐帧恒定，几何不震荡。
    ["repro-idle-oscillation", ['node', '--import', 'tsx/esm', 'scripts/repro-idle-oscillation.tsx']],
// settled 子代理卡片不得永久持有动画时钟（空闲帧归零回归）：
// 曾以 120ms/卡片持续驱动 React commit，N 张相位错开合成 ~30ms
// 均匀帧 cadence。
    ["verify-subagent-settle", ['node', '--import', 'tsx/esm', 'scripts/verify-subagent-settle.tsx']],
// 子代理流投影批处理：chunk 风暴的 snapshot+行投影必须按 16ms 帧
// 对齐合并（token 率 100-300/s 下的全量深拷贝热路径），且生命周期
// 事件（tool/call、subagent/end）保持同步立即可见。
    ["verify-subagent-stream-batching", ['node', '--import', 'tsx/esm', 'scripts/verify-subagent-stream-batching.tsx']],
// 消息列表虚拟化回归：连续高度校正的嵌套更新上限（#129, React #185）、
// 滚动窗口与 shrink 边界。measure-depth 需生产模式（minified #185）。
    ["verify-message-measure-depth", ['node', '--import', 'tsx/esm', 'scripts/verify-message-measure-depth.tsx'], { NODE_ENV: 'production' }],
    ["verify-scroll", ['node', 'scripts/verify-scroll.mjs']],
    ["verify-shrink", ['node', 'scripts/verify-shrink.mjs']],
// unseen-count 上报契约回归：同值重复上报会在密集流式 commit 下把
// setState 派发进 commit 内，嵌套更新计数连涨越过 React #185 上限
// （#146 之后残留的活链）。只在计数变化时才允许上报。
    ["verify-unseen-report-once", ['node', '--import', 'tsx/esm', 'scripts/verify-unseen-report-once.tsx'], { NODE_ENV: 'production' }],
// /model 切换 scrollback 重复沉积回归：瞬态面板（补全/picker）必须
// 走零高度浮层，帧高不随开关涨落——否则帧顶行滚进 scrollback 后被
// 关闭重绘二次写入，每切一次 /model 多一份启动画。
    ["repro-model-switch-scrollback", ['node', '--import', 'tsx/esm', 'scripts/repro-model-switch-scrollback.tsx']],
// 长列表 picker 焦点窗口化回归：限高浮层下全量渲染会把焦点行裁出屏外
// （30 行终端 30 个模型，焦点在索引 0 不可见），且 yoga 挤压会产生
// 零高丢行——焦点必须始终随窗口在屏。
    ["repro-picker-windowing", ['node', '--import', 'tsx/esm', 'scripts/repro-picker-windowing.tsx']],
// 压边截断回归（#396）：长名在终端最后一格截断时选中 ✓ 计入截断
// 预算、行恒 1 不换行——断言零 wrapped 行、Pane 内无幽灵空行、翻页
// 后标题/页脚/焦点仍在屏。
    ["verify-picker-edge", ['node', '--import', 'tsx/esm', 'scripts/verify-picker-edge.tsx']],
// 滚动条 gutter 三态回归：rail 悬停/滚动/常驻三模式下 gutter 占位
// 与内容宽度协商，切换不闪烁、不塌行。
    ["verify-scrollbar-gutter", ['node', '--import', 'tsx/esm', 'scripts/verify-scrollbar-gutter.tsx']],
// 一键回底回归：pill 常驻显示、End/Enter 回底、远距回底不触发空白
// 死锁（大偏移一步到位后首帧即有内容）。
    ["verify-back-to-bottom", ['node', '--import', 'tsx/esm', 'scripts/verify-back-to-bottom.tsx']],
// 时间线 rail 回归：rail 覆盖全部轮次（含折叠轮），高亮锚定视口顶、
// ▲/▼ 目标不越过 maxScroll。
    ["verify-timeline-rail", ['node', '--import', 'tsx/esm', 'scripts/verify-timeline-rail.tsx']],
// 恢复历史会话落点回归：/resume 后最新消息末行必须可见且可达
// （scrollToBottom 补画完成后的锚定终态），不再落屏外。
    ["repro-resume-position", ['node', '--import', 'tsx/esm', 'scripts/repro-resume-position.tsx']],
  ],
  'input-terminal': [
// 按键解析回归（issue #110）：Option+Enter（ESC CR）精确/合并/分块
// 三种到达形态、CSI-u 与 modifyOtherKeys 的 Shift/Ctrl/Meta+Enter。
    ["verify-keys", ['node', '--import', 'tsx/esm', 'scripts/verify-keys.tsx']],
// 终端能力探测回归：延迟 OSC/XTVERSION 回复期间保持 raw mode，
// 回复只进 querier，不回显成终端残影。
    ["verify-terminal-queries", ['node', '--import', 'tsx/esm', 'scripts/verify-terminal-queries.tsx']],
// win32-input-mode 解析回归（issue #147）：Windows Shift+Enter 探针
// 字节、AltGr 文本、Ctrl+[ 等价 Escape、spec 字段省略、数字键盘
// Uc 优先、代理对与 keyup 交错、Rc 重复展开、conhost 拆散粘贴重组、
// Alt+numpad 两轮合成。
    ["verify-win32-input", ['node', '--import', 'tsx/esm', 'scripts/verify-win32-input.tsx']],
// 退出漏斗回归（issue #12）：上下文 teardown 不得走到进程退出。
    ["verify-teardown-exit", ['node', '--import', 'tsx/esm', 'scripts/verify-teardown-exit.tsx']],
// 退出 resume marker 回归（issue #42）：仅有实际消息或 pending 操作时保留 marker。
    ["verify-exit-resume-marker", ['node', '--import', 'tsx/esm', 'scripts/verify-exit-resume-marker.tsx']],
// 退出阶段 stderr/console 恢复回归（issue #42）：shutdown 解绑恢复物理流并注销监听器。
    ["verify-shutdown-stderr", ['node', '--import', 'tsx/esm', 'scripts/verify-shutdown-stderr.tsx']],
// /update 纯函数回归：版本探测（双布局+外来 manifest 拒绝）、
// registry 解析（env/npmrc/默认）、semver 比较、pnpm --latest。
    ["verify-update", ['node', 'scripts/verify-update.mjs']],
// 直达启动器回归（issue #108）：参数透传、残骸 profile 重装、
// 版本不一致提示、双语消息、shellQuote 转义规则。
    ["verify-launcher", ['node', 'scripts/verify-launcher.mjs']],
// 剪贴板回归：text/uri-list 严格 URL 解析（远程 authority 拒绝、
// query/fragment 剥离、畸形转义保留）、image/text MIME 挑选、插入格式化；
// stub PATH 假 wl-paste/xclip 集成——CJK 跨 chunk、gnome verb 行、
// 图片导出权限（目录 0700/文件 0600）、空 vs unavailable、
// 死 Wayland 会话回退 xclip。
    ["verify-clipboard", ['node', 'scripts/verify-clipboard.mjs']],
// Ctrl+V UI 端到端回归（stub wl-paste）：帮助面板在读取前关闭、
// 剪贴板文本落入输入框、busy 闩锁释放后第二次粘贴仍生效。
    ["repro-clipboard", ['node', '--import', 'tsx/esm', 'scripts/repro-clipboard.tsx']],
// 图片附件回归：剪贴板位图占位符与图片文件 @ 引用进附件库（#152）。
    ["verify-clipboard-image", ['node', '--import', 'tsx/esm', 'scripts/verify-clipboard-image.ts']],
// 换名迁移回归（issue #120）：~/.dsh-cc → ~/.dsh-tui 首启复制迁移、
// resume.txt 双写契约、旧 env 名检测（DSH_CC_RESUME_SESSION 双读不算废弃）。
    ["verify-legacy-rename", ['node', 'scripts/verify-legacy-rename.mjs']],
// 拖选复制端到端回归（用户报告：全屏下拖选"只能复制一个字符，只有
// 输入框文字能复制"）：右侧 gutter 误用 NoSelect fromLeftEdge 把整行
// 转录拉进不可选取区。真实 Chat 树 + SGR 拖选注入，静息/上滚阅读+
// 流式并发/流式结束后三场景断言 OSC 52 携带完整选中文本。
    ["repro-drag-select-streaming", ['node', '--import', 'tsx/esm', 'scripts/repro-drag-select-streaming.tsx']],
  ],
  'session-workspace': [
// 审批服务配置回归（issue #49 尾巴）：裸组合 cordis.yml 必须挂载
// approval 行；裸组合与 profile patch 的 policy 表达式逐场景同值
// （ask / never / win32 never），两个入口语义不漂移。
    ["verify-cordis-approval", ['node', 'scripts/verify-cordis-approval.mjs']],
// 工作状态由基础事件在进程内派生：阶段、500ms tick、Agent 切换重置。
    ["verify-working-activity", ['node', 'scripts/verify-working-activity.mjs']],
// TUI 创建及恢复的会话必须持久关联到 Workspace。
    ["verify-workspace-attachment", ['node', 'scripts/verify-workspace-attachment.mjs']],
// tuiWorkspaces 服务可选化回归（issue #183）：代码层 inject 不含
// tuiWorkspaces、消费处带本地兜底、patch 保留服务行与行级顺序保证。
    ["verify-workspaces-degrade", ['node', 'scripts/verify-workspaces-degrade.mjs']],
// 插件扩展面回归（dsh-tui-extensions）：
//  - events：真 cordis 总线 + 真 channel——tui/input 改写/取消/崩溃
//    隔离、rewind 决策（模式列表/否决/完成后摘要）、session-switch
//    否决与 switched 通知、compact 否决的 serial bail 语义。
//  - ui：对话框 store（FIFO/AbortSignal/超时/settleAll）、runtime
//    校验（告警不抛）、快捷键解析/匹配/保留位/派发、渲染器注册拒绝
//    与粘性报错、真 Chat 驱动的对话框/状态行/快捷键端到端。
    ["verify-extension-events", ['node', '--import', 'tsx/esm', 'scripts/verify-extension-events.tsx']],
    ["verify-extension-ui", ['node', '--import', 'tsx/esm', 'scripts/verify-extension-ui.tsx']],
// 会话标题回归：选择器标题宽容读取（带未标记第三方事件的日志
// 不能让标题退化成目录名），/rename 的最后一条 session/title 优先。
    ["verify-session-titles", ['node', 'scripts/verify-session-titles.mjs']],
// resume 遗留事件注册回归（issue #153）：真实存储栈 e2e——注册前
// load() 抛 SessionFormatUnsupportedError（原样复现 issue）、注册后
// 放行；日志字节与 0600 权限绝不被改写；非白名单未知类型保持拒读
// （上游 fail-closed 新格式保护不破）。
    ["verify-resume-legacy-events", ['node', 'scripts/verify-resume-legacy-events.mjs']],
// 会话 cwd 回归（issue #96）：启动目录向上解析 git 仓库根（普通克隆
// 与 .git 文件 worktree 均覆盖、dotfiles ~/.git 守卫），/resume 过滤
// 双向兼容升级前记录的子目录会话，$HOME/盘符根容器目录只精确匹配
// （issue #153），Windows 分隔符与大小写语义。
    ["verify-session-cwd", ['node', 'scripts/verify-session-cwd.mjs']],
// 模态确认 Enter 守卫回归（4-PR 评审尾巴）：Option+Enter（ESC CR）/
// Ctrl+Enter（CSI 13;5u）不得触发审批面板决定或任何模态确认，
// 仅无修饰 Enter 生效；ApprovalPanel 全链路 + 源码静态不变量。
    ["verify-plain-enter-guard", ['node', 'scripts/verify-plain-enter-guard.mjs']],
// Ctrl+←/-> 按词跳转回归（issue #156, PR #158）：Ctrl+方向键以
// leftArrow+ctrl 到达，isMod 跳词分支必须先于裸方向键分支；
// 真实管线喂 ESC[1;5D/1;5C 移动光标插入标记字符后提交校验全文。
    ["verify-word-jump", ['node', 'scripts/verify-word-jump.mjs']],
// stdin 批量按键回归：同一读取内的文本、方向键、文本必须依次基于
// 前一事件的输入状态执行，不能因 React 批处理读取旧闭包而丢字符。
    ["verify-batched-prompt-input", ['node', 'scripts/verify-batched-prompt-input.mjs']],
// 输入历史草稿回归（issue #287）：首次 ↑ 保存未提交草稿，遍历历史后
// ↓ 回到末尾必须恢复原文，重复越界不能把草稿清空。
    ["verify-prompt-history-draft", ['node', 'scripts/verify-prompt-history-draft.mjs']],
// 文件补全回归（issue #278）：CMake 构建目录与任意大型兄弟目录不得
// 独占 100 条全局预算，普通深层源码也不能被固定深度静默截断。
    ["verify-file-completion", ['node', 'scripts/verify-file-completion.mjs']],
// /resume 会话管理回归（issue #112）：picker 重命名追加帧（seq 连续、
// 已有字节不动、last-title-wins）、删除目录、路径穿越 id 拒绝。
    ["verify-resume-manage", ['node', 'scripts/verify-resume-manage.mjs']],
// resume 模型路由回填回归：session 记录的 request/header 路由必须能被
// resolvePersistedRoute 读回并喂给 agents.resume——provider-only 的
// cordis.yml pin（issue #67）否则会让 options.model 缺位，连累子代理
// 继承（{{model}} persona 变量装配失败）。
    ["verify-resume-route", ['node', 'scripts/verify-resume-route.mjs']],
// /resume 任意深度重命名回归：会话索引取消了标题解析窗口，最旧的一条
// 也必须解析出自己的标题、改名后立即显示新名。stub 只提供 list（不给
// listSnapshots/locate），因此同时覆盖降级路径。
    ["verify-resume-rename-mru", ['node', 'scripts/verify-resume-rename-mru.mjs']],
// 会话种类与视图真值表：origin 判子 agent、parentSession 单独出现是
// /rewind 分叉（不能一起过滤掉）、空会话只计数不列出、搜索/分组/
// 折叠、以及按行高解析的变高窗口（穷举 focus×budget×prev 不溢出）。
    ["verify-session-kinds", ['node', 'scripts/verify-session-kinds.mjs']],
// 会话索引引擎：结构化走帧、定界读与全量解码等价、损坏帧不吃掉整个
// 日志、标题来源判定、revision 命中/失效（钉住 revision 改写日志作
// 判据）、索引自愈与剪枝、**终态等价**（增量索引 == 全新构建）。
    ["verify-session-index", ['node', 'scripts/verify-session-index.mjs']],
// /resume 会话浏览器按键流回归：子运行折叠/展开、空会话不列出、搜索、
// Esc 先清查询再退出、rename 后光标按 id 跟随目标（不是按行号）、
// confirm-delete 只认无修饰 Enter、Esc 取消。真实 Chat 渲染驱动。
    ["verify-session-browser", ['node', 'scripts/verify-session-browser.mjs']],
// 会话浏览器布局压测：8 种几何 × 中英双语 × 9 个交互状态，用 xterm 的
// isWrapped 断言没有任何一行溢出终端宽度，并要求提示行始终是最后一行
// （等价于「上方每个区域都放得下、没有多占行、没有被挤出屏幕」）。
// 中文必测：所有文案都本地化，按字符数而非列宽排版在英文下看不出来。
    ["verify-session-browser-layout", ['node', 'scripts/verify-session-browser-layout.mjs']],
  ],
  'channel-ui': [
// channel 层回归：发送链（submit/steer/撤回/打断重投）、compact 折叠、
// goal/todo 事件回放。曾因不在 CI 而随接口演进静默失效（0.3.6 的
// installModelSelection、#34 的投递异步化都没被它们拦下），挂进来
// 防再腐烂。
    ["verify-submit", ['node', '--import', 'tsx/esm', 'scripts/verify-submit.mjs']],
    ["verify-compact", ['node', '--import', 'tsx/esm', 'scripts/verify-compact.mjs']],
    ["verify-channel-goal-todo", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-goal-todo.mjs']],
    ["verify-whale-toggle", ['node', '--import', 'tsx/esm', 'scripts/verify-whale-toggle.mjs']],
// 裸 ● 空行回归：纯思考/纯工具步骤（无文本块）的 assistant/message
// 不得创建空 assistant 行，否则思考块折叠后转录里多出一个只有
// ● 前缀、内容为空的行。
    ["verify-empty-assistant-row", ['node', 'scripts/verify-empty-assistant-row.mjs']],
// 空文本 assistant 行渲染层兜底（#383）：channel 层守卫之外的存量空行
// （历史日志回放、空白文本）在 visibleRows 管线过滤，工具卡上方不得
// 出现孤立 ●；streaming 空行保留 live dot；落定后过滤即时生效。
    ["verify-empty-assistant", ['node', '--import', 'tsx/esm', 'scripts/verify-empty-assistant.tsx']],
// 技能斜杠命令补全回归（issue #86）：user-invocable 技能合并进 /
// 菜单与 Tab 补全（skill 标记、与 locals/注册表撞名让位），
// skills/change 实时增删，读取失败保留 last-good。
    ["verify-skill-commands", ['node', 'scripts/verify-skill-commands.mjs']],
// 轨迹投影回归（issue #80 演进）：增量折叠与全量折叠在每个切分点终态
// 等价（机械 oracle）、六类括号配对、增广事件守卫的全变异模糊测试、
// 未知事件前向兼容、连发折叠边界、无 chunk 的步不伪造 TTFT。
    ["verify-trace-projection", ['node', 'scripts/verify-trace-projection.mjs']],
// effort 配置链路回归（issue #51）：cordis 配置的 effort 必须进入实际
// 请求配置，而不是只做状态栏启动显示（≤0.3.5 的 display-only 行为）。
    ["repro-effort", ['node', '--import', 'tsx/esm', 'scripts/repro-effort.tsx']],
// 子代理模型路由回归（issue #191）：child scope 没有 AgentOptions 路由时，
// 首次请求继承 TUI 当前完整路由；显式 child 路由保持优先。
    ["verify-subagent-model-route", ['node', '--import', 'tsx/esm', 'scripts/verify-subagent-model-route.tsx']],
// 子进程 stderr 接管回归（issue #17）：inherit 的 MCP 子进程 stderr
// 不再裸写终端破坏 alt-screen，输出去重聚合为受控通知。
    ["verify-child-stderr", ['node', '--import', 'tsx/esm', 'scripts/verify-child-stderr.tsx']],
// 模型路由原子解析回归（issue #67）：完整 config > pref > default 整对
// 生效，provider-only pin 不得与另一半拼接出错配路由。
    ["verify-model-route", ['node', 'scripts/verify-model-route.mjs']],
// CJK 显示宽度截断回归（issue #41）：4 处描述按终端显示宽度处理，
// CJK 不劈字、窄终端布局不破。
    ["verify-cjk-truncate", ['node', '--import', 'tsx/esm', 'scripts/verify-cjk-truncate.tsx']],
// 启动上下文摘要窄终端回归（issue #167）：摘要与 Ctrl+T 提示必须
// 作为一条可截断文本布局，不能换行后互相穿插。
    ["verify-loaded-context-width", ['node', '--import', 'tsx/esm', 'scripts/verify-loaded-context-width.tsx']],
// thinking spinner 残影回归（issue #72）：text-default emoji（✳）
// 量宽 2 实画 1 致 spinner 行每帧错位，thinking 残影堆积不消失。
    ["repro-thinking", ['node', '--import', 'tsx/esm', 'scripts/repro-thinking.tsx']],
// 斜杠命令描述 i18n 回归（issue #41）：/ 菜单与 ? 帮助菜单描述随
// /lang 中英切换，外部命令查不到映射回退注册表原文，窄终端中文不劈字。
    ["verify-i18n-command-descriptions", ['node', '--import', 'tsx/esm', 'scripts/verify-i18n-command-descriptions.tsx']],
// /help 长命令面回归（issue #368）：80×24/80×18/60×18 均须保留提示，
// ↑/↓、翻页、Home/End 与滚轮可达首尾且不滚动底层 transcript；关闭重开
// 回顶，pending 预览只在 help 关闭后恢复，组合键不改写背后的 Chat 状态。
    ["verify-help-scroll", ['node', '--import', 'tsx/esm', 'scripts/verify-help-scroll.tsx']],
// 外部编辑器回归（issue #123）：Ctrl+G 的 $VISUAL/$EDITOR 解析
// （引号拆分、优先级、未配置时 unavailable——无 vi 兜底）与临时文件
// 往返（edited/unchanged/非零退出/启动失败）。假编辑器进程，无需 TTY。
    ["verify-external-editor", ['node', 'scripts/verify-external-editor.mjs']],
// 外部编辑器 TTY 交接回归（issue #123 实机冒烟）：恢复后 transcript
// 全量重绘、交接窗口残留/晚到字节不落输入、抑制窗口结束后活性正常。
// xterm headless + 假编辑器进程，模拟 vim rmcup 与终端应答残片。
    ["repro-external-editor", ['node', '--import', 'tsx/esm', 'scripts/repro-external-editor.tsx']],
// /effort 滑杆 + 模式指示全应用回归（真实 Chat 渲染）：滑杆开/
// ←/→ 实时生效/Esc 关闭、状态栏 effort 段与模式段、三次 backtab
// 完整循环。
    ["verify-effort-slider-ui", ['node', 'scripts/verify-effort-slider-ui.mjs']],
// /thinking 显示语义回归（issue #317）：中英文文案必须明确只影响
// 思考过程显示，切换立即生效且不得改变模型 reasoning effort。
    ["verify-thinking-display", ['node', '--import', 'tsx/esm', 'scripts/verify-thinking-display.tsx']],
// 主题解析回归：内置主题完整性、parseCustomTheme 拒绝畸形/不安全项、
// displayName 内嵌换行入口压平（#160 窗口化列表单行契约的第一道防
// 线）。注意必须走 tsx——脚本直接 import src/customTheme.ts。
    ["verify-themes", ['node', '--import', 'tsx/esm', 'scripts/verify-themes.mjs']],
// Text 背景色回归（issue #166）：公开 themed Text 与 Box 一致支持
// 原始颜色值，且必须把对应 ANSI 背景色写入终端。
    ["verify-text-background", ['node', '--import', 'tsx/esm', 'scripts/verify-text-background.tsx']],
// 最高档思考强度点焰回归：数学层（波形/缓动/包络/逐列色契约）+
// 场景（headless xterm）：三幕（双框同步扫光/档名居中聚拢/渐隐
// 归零）断言帧间文本恒定、零行级 repaint、行数恒定、负路径全暗。
    ["verify-effort-ignition", ['node', '--import', 'tsx/esm', 'scripts/verify-effort-ignition.tsx']],
// 前缀充能回归：四态 + 充能窗内真实前景色采样（暗→全值单调）。
    ["verify-effort-accent", ['node', '--import', 'tsx/esm', 'scripts/verify-effort-accent.tsx']],
// 缩放重排回归（实机反馈：打开长会话后最大化窗口）：判据是终局等价
// ——缩放后的物理终端必须等于在新尺寸上全新渲染的同一状态。缩放会让
// 树内每个测量所依据的宽度失效，而没有任何节点被标脏，文本节点会沿用
// 旧宽度的测量结果，靠 flex 仲裁的行因此由两套布局拼成。
    ["verify-resize-reflow", ['node', '--import', 'tsx/esm', 'scripts/verify-resize-reflow.tsx']],
// Ctrl+T 归属回归：启动上下文面板在屏时该键属于面板（它自己在屏幕上
// 印着「Ctrl+T 展开」），转录有行之后才归轨迹场景。两者永不同屏——
// 面板只在首条消息前出现，而那正是轨迹为空的窗口。
    ["verify-ctrl-t-scope", ['node', '--import', 'tsx/esm', 'scripts/verify-ctrl-t-scope.tsx']],
// 收缩重绘回归：一个高于视口的帧在一帧内收起，屏幕必须等于同一短状态的
// 全新渲染——不留旧帧、表头不出现两次。shrink-frame 家族（#38/#39/#19/
// #10）里步长最大的一档，不经 Chat，直接对渲染器。
    ["repro-collapse-shrink", ['node', '--import', 'tsx/esm', 'scripts/repro-collapse-shrink.tsx']],
// /provider 向导回归：catalog/custom 两分支的 profile 形状、凭据回滚
// （覆盖时恢复旧 key 而非误删）、env shadow 跳过、rc.6 兼容守卫、
// hideCustomInput 逐题标记。
    ["verify-provider-wizard", ['node', 'scripts/verify-provider-wizard.mjs']],
// /login 凭据状态回归（issue #213）：只通过 credentials.describe()
// 展示 configured/source/writable，managed key 不得误报或泄露值。
    ["verify-login-credentials", ['node', '--import', 'tsx/esm', 'scripts/verify-login-credentials.tsx']],
// 提问面板 hideCustomInput 行为回归：纯选择题隐藏输入行且 Tab/打字
// 不劫持焦点，纯文本题忽略 hide 标记，多选题默认行为不回退。
    ["verify-askpanel-hide-custom-input", ['node', '--import', 'tsx/esm', 'scripts/verify-askpanel-hide-custom-input.tsx']],
// 长问卷列表回归：24 行终端中的 36 个两行 provider 选项必须围绕
// focusIndex 窗口化，初始和深度导航后焦点 label/单选标记始终可见。
    ["verify-askpanel-long-list", ['node', '--import', 'tsx/esm', 'scripts/verify-askpanel-long-list.tsx']],
// 插件场景渲染崩溃边界：Thrower 场景必须被 PluginSceneBoundary 接住——
// onError 精确一次、崩溃场景停止绘制、进程存活；健康场景不受影响。
    ["verify-plugin-scene-boundary", ['node', '--import', 'tsx/esm', 'scripts/verify-plugin-scene-boundary.tsx']],
  ],
  'flaky-observation': [
// resize 时间稳定性（借鉴 Codex 的 resize 漂移维度）：落定后不得
// 继续漂、20 次宽度循环无累计漂移、流中 resize 终态 == 冷渲染。
    ["verify-resize-temporal", ['node', '--import', 'tsx/esm', 'scripts/verify-resize-temporal.tsx']],
// 轨迹场景回归（issue #80 演进，取代 repro-trace）：xterm headless 驱动
// 真实场景——账本行/耗时/光标、窗口滚动、检视窗跟随光标且高度恒定、
// 查询过滤、时序⇄热点切换，以及备用屏进出后主屏逐字节还原、
// scrollback 零增量、动效帧只含 SGR。
    ["verify-trace-scene", ['node', '--import', 'tsx/esm', 'scripts/verify-trace-scene.tsx']],
  ],
}

const groupName = process.argv[2]
const group = GROUPS[groupName]
if (!group) {
  console.error('[run-ci-group] 未知组名: ' + groupName)
  console.error('可用组: ' + Object.keys(GROUPS).join(', '))
  process.exit(2)
}

console.log('::group::' + groupName + '（' + group.length + ' 项，失败不中断）')
const results = []
for (const entry of group) {
  const [name, argv, extraEnv] = entry
  console.log('\n===== ' + name + ' =====')
  const r = spawnSync(argv[0], argv.slice(1), {
    env: extraEnv ? { ...env, ...extraEnv } : env,
    stdio: 'inherit',
    shell: false,
  })
  const failed = r.status !== 0
  results.push({ name, failed, status: r.status })
  if (failed) console.log('::error title=' + groupName + '::测试 ' + name + ' 失败（exit ' + r.status + '）——已记录，继续跑同组其余测试')
}
console.log('::endgroup::')

console.log('\n' + groupName + ' 汇总：')
for (const { name, failed, status } of results) {
  console.log('  ' + (failed ? '✗' : '✓') + ' ' + name + (failed ? '（exit ' + status + '）' : ''))
}
const failedList = results.filter(r => r.failed)
if (failedList.length > 0) {
  console.error('\n' + groupName + '：' + failedList.length + '/' + results.length + ' 项失败——' + failedList.map(f => f.name).join(', '))
  process.exit(1)
}
console.log('\n' + groupName + '：全部 ' + results.length + ' 项通过')
