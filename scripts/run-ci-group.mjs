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
 *   - run: node scripts/run-ci-group.mjs render-scroll --shard 1/3
 *
 * --shard i/n：只跑本组第 i 片的条目，ci.yml 用 matrix 把大组拆成并行 job；
 * 不带 --shard 即整组。分片按耗时装箱（最长处理时间优先：条目按预计耗时
 * 从长到短，逐条放进当前最轻的一片），各片预计耗时几乎相等；片内仍按登记
 * 顺序运行。预计耗时来自同目录的 ci-group-timings.json（本地整组实测），
 * 表里没有的新条目按本组中位数估算。这张表只决定条目落在哪一片，不决定
 * 跑哪些条目：每条恰好落在一片里（下方断言），表过时只会让各片不够均衡，
 * 不会漏跑。新增测试只登记 GROUPS，不必改分片。
 * --list 只打印本片条目与预计耗时，不运行。--record-timings 在跑完后把本次
 * 通过条目的实测耗时写回 ci-group-timings.json（重新均衡分片时用）。
 * --jobs N：组内并发（缺省 1 = 逐条串行，CI 行为逐字节不变）。本地提速用：
 * 每条仍是独立渲染日志 + 一次性 HOME，输出按条缓冲、完成后整段透传；并行
 * 失败的条目自动串行复跑一次——复跑绿按「CPU 竞争假红」放行但显式记录
 * （::error + 汇总标注），复跑仍红才算真失败。渲染类组在 CPU 争抢下本就有
 * 假红前科（#513/#734），并发只用于本地往返；--jobs > 1 与 --record-timings
 * 互斥（并发耗时失真，会污染装箱表）。
 *
 * 组定义在下方 GROUPS 表：名称 + 完整 argv + 可选附加 env。所有条目默认
 * NODE_ENV=production：产品入口本就强制生产版 React，dev 版 reconciler 每次
 * commit 都 performance.measure 并 structured-clone 组件 props，慢一倍以上且
 * 让时序断言在 CI 上贴线抖动（#805）。显式设置的 NODE_ENV 优先。新增测试时在此表登记——
 * 每条的注释即原 ci.yml 里该 step 上方的说明（迁移时保留）。
 *
 * 行为：
 *   - 逐条运行，实时透传 stdout/stderr（日志仍是每条测试的原始输出）；
 *   - 失败不中断，记录后继续；
 *   - 结束时汇总 ✓/✗ 清单（附每条耗时，按登记顺序），任一失败 exit 1 并给
 *     失败条目打 ::error；在 GitHub Actions 里再往 step summary 写一张按
 *     耗时降序的表——分片与拆组按这张表的数据来，不靠日志时间戳反推。
 *   - 每条脚本带 DSH_TUI_RENDER_LOG=ci-render-logs/<名>.log 跑（显式设置优先）：
 *     通过即删，失败保留，ci.yml 在 job 失败时把目录传成 artifact。时序
 *     flake（#513/#734 一类"退出备用屏后主屏错一行"）本地复现不出来，只有
 *     CI 那一次失败的原始帧字节才是证据。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = { NODE_ENV: 'production', ...process.env }

const GROUPS = {
  'render-scroll': [
    ['verify-image-inspection', ['node', '--import', 'tsx/esm', 'scripts/verify-image-inspection.tsx']],
    ['verify-terminal-images-sixel', ['node', '--import', 'tsx/esm', 'scripts/verify-terminal-images-sixel.tsx']],
    ['verify-sixel-transcript', ['node', '--import', 'tsx/esm', 'scripts/verify-sixel-transcript.tsx']],
// 启动落地页回归：头部（块体大字/鲸鱼/模型/目录）与快捷入口的版面、
// 高度阶梯（full → no-chips → no-hint → input-only）、受控输入的闭环、
// 焦点与 Enter 的归属（输入框提交 vs 入口激活）、真鼠标 SGR 点击。
    ['verify-launchpad', ['node', '--import', 'tsx/esm', 'scripts/verify-launchpad.tsx']],
// 首次引导向导回归：四步骨架与步骤条降级、凭证/余额文案口径、语言与主题
// 两个面板的键盘路径、模型/强度/工作区三条切换、招式卡与两个出口
// （Esc=skipped 不记账，最后一步 Enter=done 才写 onboarding.json）。
    ['verify-onboarding-wizard', ['node', '--import', 'tsx/esm', 'scripts/verify-onboarding-wizard.tsx']],
// Chat 集成层：两个屏幕在**真实 Chat** 里的编排契约（/setup 开向导、提交落点、
// 开整屏界面的动作要先收掉当前屏、覆盖层不收、记账 skipped/done、最小模式、
// 首启横幅不 stale）。这三类缺陷是单独挂组件的回归测不到的——先有 bug 才有它。
    ['verify-launchpad-onboarding-chat', ['node', '--import', 'tsx/esm', 'scripts/verify-launchpad-onboarding-chat.tsx']],
// 内核选择器（第八版）展示组件回归：标题/行标签/副标题（版本 · 置灰原因）/当前勾
// 跟着 current 走/不可选行变暗（焦点压上去 ❯ 指针仍在——不能用 ListItem 的
// disabled，它连指针一起吞）/pinned 提示行/鼠标点行回行号/没接 onPick 则无 hover
// 反馈。与同组的 verify-launchpad 是同一个功能的两面（底栏那一行 ↔ 选择器本体）。
    ['verify-kernel-picker', ['node', '--import', 'tsx/esm', 'scripts/verify-kernel-picker.tsx']],
// 带断言的回归：提问面板内联输入（issue #9）+ 工具卡排版
// （⎿ 缩进、diff 红绿行、信封剥离），失败即非零退出。
    ["repro-askpanel", ['node', '--import', 'tsx/esm', 'scripts/repro-askpanel.tsx']],
// 问卷回退回归：答案按题覆盖、草稿恢复、Esc 分层语义与最终摘要。
    ["verify-question-backtrack", ['node', '--import', 'tsx/esm', 'scripts/verify-question-backtrack.tsx']],
// 提问面板全应用布局回归：短/长高录、activity tick 差分、resize 风暴。
    ["verify-askpanel-layout", ['node', '--import', 'tsx/esm', 'scripts/verify-askpanel-layout.tsx']],
    ["repro-toolcards", ['node', '--import', 'tsx/esm', 'scripts/repro-toolcards.tsx']],
    ["repro-diff-split", ['node', '--import', 'tsx/esm', 'scripts/repro-diff-split.tsx']],
// 代码块 tab 缩进背景回归（issue #606）：tab 展开须继承单元格样式，否则
// 无背景的空格被 diff 跳过，在 tmux/Windows Terminal 深色底下显示为黑块。
    ["verify-code-block-tab-background", ['node', '--import', 'tsx/esm', 'scripts/verify-code-block-tab-background.tsx']],
// 思考块流式视图回归：preview 固定三行且点击切全文/再点收回，full
// 默认值反向但仍不进入 0 行正文；增量 Markdown 与整段渲染的块间距
// 一致（真实段落空行保留，代码块后不凭空多一行）。
    ["verify-thinking-preview", ['node', '--import', 'tsx/esm', 'scripts/verify-thinking-preview.tsx']],
    ["repro-thinking-stream-fold", ['node', '--import', 'tsx/esm', 'scripts/repro-thinking-stream-fold.tsx']],
    ["verify-streaming-markdown-spacing", ['node', '--import', 'tsx/esm', 'scripts/verify-streaming-markdown-spacing.tsx']],
    ['verify-text-measure-cache', ['node', '--import', 'tsx/esm', 'scripts/verify-text-measure-cache.ts']],
    ['verify-text-wrap-geometry', ['node', '--import', 'tsx/esm', 'scripts/verify-text-wrap-geometry.tsx']],
    ['verify-streaming-markdown-blocks', ['node', '--import', 'tsx/esm', 'scripts/verify-streaming-markdown-blocks.tsx']],
    ['verify-text-paint-budget', ['node', '--import', 'tsx/esm', 'scripts/verify-text-paint-budget.tsx']],
    ['verify-text-viewport-paint', ['node', '--import', 'tsx/esm', 'scripts/verify-text-viewport-paint.ts']],
    ['verify-tool-history-window', ['node', '--import', 'tsx/esm', 'scripts/verify-tool-history-window.tsx']],
// 流式平滑揭示回归（dsh-tui.smoothStreaming）：调度器步进/游标生命周期
// （追加保游标、替换 snap、追平不再重打）+ MessageList 集成（流式行/
// 非流式 fresh 行渐进揭示、回放行直出、开关关闭直出）+ 组件契约
// （thinking ticker 跟随已到达文本而展开体吃切片、工具卡行级揭示、
// result 落定即全显）。
    ["verify-smooth-reveal", ['node', '--import', 'tsx/esm', 'scripts/verify-smooth-reveal.tsx']],
// 根级页边距（PageMargin）契约：无内缩终端（裸 WSL/tmux/SSH）下文字贴边。
// 左右 2 列上下 1 行内缩 + TerminalSize 收敛成内容区尺寸 + inset 坐标
// 补偿，对照组保证无 PageMargin 时既有「全宽」契约不变。
    ["verify-page-margin", ['node', '--import', 'tsx/esm', 'scripts/verify-page-margin.tsx']],
// 滚动/pill/内联模式回归：新消息 pill 计数递减、Ctrl+C 交互、
// 内联 scrollback 第三方终端适配。曾因 mock channel 缺新字段而
// 静默冻结（render 期 TypeError 被 ink 吞掉），不在 CI 里烂了
// 整个 0.6.x 才被发现——挂进来防再烂。
    ["repro-pill", ['node', '--import', 'tsx/esm', 'scripts/repro-pill.tsx']],
    ["repro-ctrlc", ['node', '--import', 'tsx/esm', 'scripts/repro-ctrlc.tsx']],
// /settings 设置屏回归（issue #165）：开屏、staged 编辑、revision 栅栏
// 保存、密钥走 credentials、Esc 返回会话。
    ["repro-settings", ['node', '--import', 'tsx/esm', 'scripts/repro-settings.tsx']],
// /settings 长页滚动回归：focus-follow 窗口只钉焦点行会裁掉不可聚焦的
// 卡片边框行——下滚到底丢 ╰──╯、上滚到顶丢 ╭─ 标题；窗口必须贴住列表
// 物理边界（根页/group 子页/极小视口下焦点永不被钉边挤出）。
    ["verify-settings-scroll", ['node', '--import', 'tsx/esm', 'scripts/verify-settings-scroll.tsx']],
// /settings 根页分组呈现回归：inline 组字段平铺根页（标题行不可聚焦，
// 焦点序跳过标题直达字段），page 组与无 mode 的旧默认仍走子页；空的
// inline 组不渲染孤儿标题。
    ["verify-settings-root-inline", ['node', '--import', 'tsx/esm', 'scripts/verify-settings-root-inline.tsx']],
    ["repro-inline-scrollback", ['node', '--import', 'tsx/esm', 'scripts/repro-inline-scrollback.tsx']],
    ["repro-inline-thirdparty", ['node', '--import', 'tsx/esm', 'scripts/repro-inline-thirdparty.tsx']],
// 安全回归：OSC 出口控制字符剥离 + 超链接 scheme 门禁（安全审查
// 2026-08-27）——tokenize 提取→回放链路的注入 payload 必须被剥除。
    ["verify-osc8-sanitize", ['node', '--import', 'tsx/esm', 'scripts/verify-osc8-sanitize.tsx']],
// 文件链接 ANSI 完整性回归：renderCodeSpan 把已上色的路径代码段传入
// createHyperlink 时，防注入消毒会剥掉合法 \x1b、SGR 参数文本上屏
// （[38;2;…m 残片）；链接标签的样式序列同样不得残留裸参数。
    ["verify-markdown-filelink-ansi", ['node', '--import', 'tsx/esm', 'scripts/verify-markdown-filelink-ansi.ts']],
// 全屏 resize 空白回归：宽度变化清空行高缓存 → scrollHeight 估算塌缩，
// shrunk 帧冻结的旧 scrollTop 与失准的 clamp 边界越过内容底，整屏裁剪
// 成"只剩输入框"（Orca pane 宽度抖动的现场取证复现）。
    ["repro-resize-blank", ['node', '--import', 'tsx/esm', 'scripts/repro-resize-blank.tsx']],
// Windows Terminal 最大化后的同尺寸 resize 必须修复丢失的静态格（#891），
// 不提前擦屏、不打断外部编辑器；inline 与非 ConPTY 路径继续保持安静。
    ['verify-conpty-surface-resize', ['node', '--import', 'tsx/esm', 'scripts/verify-conpty-surface-resize.tsx']],
// 空转重渲染风暴回归（issue #433）：长历史 + 30ms 空转 commit 风暴下
// renderScrollTop / 画面 / 输入框行数必须逐帧恒定，几何不震荡。
    ["repro-idle-oscillation", ['node', '--import', 'tsx/esm', 'scripts/repro-idle-oscillation.tsx']],
// 静置空转的终端下泄回归：inline 模式下光标停在内容下一行时，用 LF 补行会
// 逐行滚动终端——一帧「什么都没变」的画面也往回滚缓冲里塞一份重复视口
// （实测 ~73 LF/s）。静置窗口内 stdout 不得出现 LF、回滚缓冲不得增长，同时
// 鲸鱼闲置动画必须仍在重绘（不许靠冻结界面取巧）。
    ["verify-idle-repaint", ['node', '--import', 'tsx/esm', 'scripts/verify-idle-repaint.tsx']],
// 开屏头部契约：大字 5 行高且等宽（8×7 = 7×8）、bigTextWidth 与实际画出的列数
// 一致；窄终端按「鲸鱼+大字 → 纯大字 → 纯鲸鱼 → 纯文字」逐档降级，档位无空档。
    ["verify-splash-layout", ['node', '--import', 'tsx/esm', 'scripts/verify-splash-layout.ts']],
// 开屏彩蛋契约：节日换词（每款字体都要有 HAPPINESS/MERRY/NEW YEAR 的全部字形，
// 两行等宽 + 下排居中取最紧解）与 1/20 的求 star 标语（OSC 8 成对 + URL 正确、
// 缩进按该行实际宽度重算、不支持超链接时退化成纯文本 URL），并挂真实 LogoV2 读屏。
    ["verify-splash-eggs", ['node', '--import', 'tsx/esm', 'scripts/verify-splash-eggs.tsx']],
    // 求 star 的触发条件（累计启动次数 / 累计在线时长的里程碑阶梯、账本坏文件兜底）：
    ["verify-usage-stats", ['node', '--import', 'tsx/esm', 'scripts/verify-usage-stats.mjs']],
    // 一键 star 的 gh 集成（探测/登录态/超时/失败分类，全用假执行器不联网）：
    ["verify-star-action", ['node', '--import', 'tsx/esm', 'scripts/verify-star-action.mjs']],
    // 女仆娘立绘（whaleGirl 设置 + 头部换画/阶梯契约）与 99h/999 次"求 star"
    // 开屏弹窗（挂真实 Chat：弹一次/记账/Esc 关且关后不抢键/忙时不弹不记账）：
    ["verify-whale-girl", ['node', '--import', 'tsx/esm', 'scripts/verify-whale-girl.tsx']],
// 标题女仆娘立绘透明回归：假 Windows Terminal（DA1→Sixel）下立绘以
// transparent 放置、无衬底色——只画她自己的像素，壁纸从周围透出来。
    ["verify-maid-portrait-transparent", ['node', '--import', 'tsx/esm', 'scripts/verify-maid-portrait-transparent.tsx']],
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
    ["verify-message-measure-depth", ['node', '--import', 'tsx/esm', 'scripts/verify-message-measure-depth.tsx']],
    ["verify-scroll", ['node', 'scripts/verify-scroll.mjs']],
// 长会话冷/热窗口跳转、绘制边界发布与回底挂载预算（不能等滚轮救活）。
    ['verify-scroll-jumps', ['node', '--import', 'tsx/esm', 'scripts/verify-scroll-jumps.tsx']],
    ['verify-scroll-jumps-narrow', ['node', '--import', 'tsx/esm', 'scripts/verify-scroll-jumps.tsx'], { DSH_TEST_COLUMNS: '60' }],
// Windows Terminal 全屏拖选+滚轮回归：长 User 气泡的 selection overlay
// 会污染上一帧；污染帧不得进入 DECSTBM/shiftRows 硬件滚动，否则带背景
// 的旧像素被物理搬移后偶发重复/错位。A/B 同轨迹断言终态画面一致。
    ["repro-user-drag-wheel-render", ['node', '--import', 'tsx/esm', 'scripts/repro-user-drag-wheel-render.tsx']],
    ["verify-shrink", ['node', 'scripts/verify-shrink.mjs']],
// 高于视口的收缩必须记 anchoredPad：终端 scrollback 不随内容收缩，
// 高度差公式会少算 1 行 → 上移在视口顶被钳制 → 整帧相对写入链低一行
// （verify-trace-scene settle-gap flake 的确定性蒸馏，红绿验证过）。
    ["verify-shrink-anchored-pad", ['node', '--import', 'tsx/esm', 'scripts/verify-shrink-anchored-pad.tsx']],
// unseen-count 上报契约回归：同值重复上报会在密集流式 commit 下把
// setState 派发进 commit 内，嵌套更新计数连涨越过 React #185 上限
// （#146 之后残留的活链）。只在计数变化时才允许上报。
    ["verify-unseen-report-once", ['node', '--import', 'tsx/esm', 'scripts/verify-unseen-report-once.tsx']],
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
// 浮层锚点空间预算回归（#493/#698）：OverlayAbove 把 maxHeight 钳到输入簇
// 上方真实可画行数并把预算交给 picker 窗口化——短会话 + 高终端下标题/
// 焦点/页脚全部在屏、页脚紧贴输入行；长会话不过度钳制。
    ["verify-overlay-anchor-budget", ['node', '--import', 'tsx/esm', 'scripts/verify-overlay-anchor-budget.tsx']],
// 滚动条 gutter 三态回归：rail 悬停/滚动/常驻三模式下 gutter 占位
// 与内容宽度协商，切换不闪烁、不塌行。
    ["verify-scrollbar-gutter", ['node', '--import', 'tsx/esm', 'scripts/verify-scrollbar-gutter.tsx']],
// 一键回底回归：pill 常驻显示、End/Enter 回底、远距回底不触发空白
// 死锁（大偏移一步到位后首帧即有内容）。
    ["verify-back-to-bottom", ['node', '--import', 'tsx/esm', 'scripts/verify-back-to-bottom.tsx']],
// 底部超滚门控回归：已贴底时 wheel-down 必须是完全惰性的 no-op（不清
// sticky、不积 delta、不重绘）——修复前每格 sticky flip-flop + pill 闪现
// + 整屏重绘（流式下可感知为"强拖+闪烁"）；且滚上再滚回仍须正常（着陆
// 格放行、at-bottom re-pin 恢复 sticky）。
    ["verify-scrollbox-bottom-overscroll", ['node', '--import', 'tsx/esm', 'scripts/verify-scrollbox-bottom-overscroll.tsx']],
// 时间线 rail 回归：rail 覆盖全部轮次（含折叠轮），高亮锚定视口顶、
// ▲/▼ 目标不越过 maxScroll。
    ["verify-timeline-rail", ['node', '--import', 'tsx/esm', 'scripts/verify-timeline-rail.tsx']],
// 时间线 rail 视口高度落定回归：底部 chrome 悬停展开/收回与终端行 resize
// 改变转录视口高度时（无滚动通知、不翻转 sticky），rail 几何必须跟随；
// 通知语义（仅高度变化触发）经渲染器→React 回调计数探针断言。
    ["verify-timeline-rail-settle", ['node', '--import', 'tsx/esm', 'scripts/verify-timeline-rail-settle.tsx']],
// 多行 user 的置顶摘要不得向转录左侧出血；宽/窄终端均保留滚动锚定。
    ['verify-sticky-anchor', ['node', '--import', 'tsx/esm', 'scripts/verify-sticky-anchor.tsx']],
    ['verify-sticky-anchor-narrow', ['node', '--import', 'tsx/esm', 'scripts/verify-sticky-anchor.tsx'], { DSH_TEST_COLUMNS: '60' }],
// 恢复历史会话落点回归：/resume 后最新消息末行必须可见且可达
// （scrollToBottom 补画完成后的锚定终态），不再落屏外。
    ["repro-resume-position", ['node', '--import', 'tsx/esm', 'scripts/repro-resume-position.tsx']],
// 全屏转录键盘翻页回归：PgUp/PgDn 一次一页、到底按 at-bottom 契约重粘；
// help 浮层让位、问询面板不让位（面板在转录下方且不消费这对键）、inline
// 模式不接管（历史在终端原生 scrollback）、窄终端行为一致。
    ["verify-transcript-paging", ['node', 'scripts/verify-transcript-paging.mjs']],
// zellij 兼容回归（DECSTBM 硬件滚动撤回）：zellij 的 CSI T 只在光标位于
// 滚动区内时移动行，而渲染器把光标停在整屏最后一行（每个 ScrollBox 之下），
// 位移被静默吞掉而差分引擎仍当作已发生 → 上滚时旧行残留/错行；zellij 实现了
// DEC 2026，所以只撤 DECSTBM、BSU/ESU 保留。断言 zellij 下撤回 + DEC 2026
// 保留 + 无 zellij 对照，终端环境按场景显式构造（不继承宿主 env，见脚本头注）。
    ["verify-zellij", ['node', '--import', 'tsx/esm', 'scripts/verify-zellij.tsx']],
// 侧栏 Phase 1 纯函数几何契约：canSplit 92/93 边界、resolveSplit/zoom 的
// clamp 下限（chat>=64、panel>=28、和+1=列数）、ratio 极端钳制、
// resolveSidePanelGeometry 开关矩阵、nudgeRatio ±4 列步进与两端钳死。
    ["verify-side-panel-geometry", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-geometry.mjs']],
// 侧栏 Phase 1 渲染契约：divider 列位置与 ├/│ 接缝、PanelBar 胶囊+徽章、
// hint 随焦点切换（zh/en）、聊天侧输入框不越缝、zoom 与 93 列最小分栏
// 不破版、geometry=null 零 diff 直通、resize 终态等价（120→100→120）。
    ["verify-side-panel-layout", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-layout.tsx']],
// Companion（宠物）面板回归——纯函数层：mood 优先级格（attention 三触发各
// 自点亮、attention 阻止入睡、celebration 到期回落、activity 缺失/done/idle
// 退 spinnerMode、sleepAfterMs=0 永不睡）+ stepCompanionMood 的 since 保留与
// bubble 取值（phrase 优先、label+detail 兜底、idle/sleeping 无 bubble）。
    ["verify-companion-mood", ['node', '--import', 'tsx/esm', 'scripts/verify-companion-mood.mjs']],
// Companion pose 层：nextCompanionPoseStep 对 nextWhaleIdleStep 的帧级 parity
// （8 mood × heart × 50 步 pose+state+delay 逐项相等）、gestures 集合由层姿态
// 派生（tail+fin 重叠步同时 wag+flutter、静止步空集）、blink/heart/sleepZ 镜像
// nativeWhalePose、tick=floor(now/120)。
    ["verify-companion-pose", ['node', '--import', 'tsx/esm', 'scripts/verify-companion-pose.mjs']],
// Companion 渲染层：♥ tab 登记、宽幅 deepy 半块帧 + 「N 个工具」统计行、窄幅
// compact（♥+心情标签、无皮肤帧）、display:none 零时钟订阅（计数 ClockContext
// 代理探针）、SGR 点击艺术区触发 heart pass、Enter poke 显示完整 activity.line、
// 左栏 §16.6 零 diff（50 次 version bump 重渲染逐行恒等）。
    ["verify-companion-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-companion-panel.tsx']],
  ],
  'input-terminal': [
// 按键解析回归（issue #110）：Option+Enter（ESC CR）精确/合并/分块
// 三种到达形态、CSI-u 与 modifyOtherKeys 的 Shift/Ctrl/Meta+Enter。
    ["verify-keys", ['node', '--import', 'tsx/esm', 'scripts/verify-keys.tsx']],
// 侧栏 Phase 1 控制器键盘契约（真 stdin 注入）：ctrl+b 三态循环、面板聚焦
// 时 ←/→ 与 [ ] 循环、数字直达、z 缩放、+/- 调宽（面板+4/chat+4）、plain
// 键吞掉、ctrl 组合放行、alt+z 全局缩放、窄终端/编辑器打开时无效；含
// 已知缺陷 tripwire（真 Esc 带 meta 被放行，见脚本头注）。
    ["verify-side-panel-keys", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-keys.tsx']],
// 终端能力探测回归：延迟 OSC/XTVERSION 回复期间保持 raw mode，
// 回复只进 querier，不回显成终端残影。
    ["verify-terminal-queries", ['node', '--import', 'tsx/esm', 'scripts/verify-terminal-queries.tsx']],
// win32-input-mode 解析回归（issue #147）：Windows Shift+Enter 探针
// 字节、AltGr 文本、Ctrl+[ 等价 Escape、spec 字段省略、数字键盘
// Uc 优先、代理对与 keyup 交错、Rc 重复展开、conhost 拆散粘贴重组、
// Alt+numpad 两轮合成。
    ["verify-win32-input", ['node', '--import', 'tsx/esm', 'scripts/verify-win32-input.tsx']],
// 粘贴记录残留清洗回归（issue #1090）：win32 记录残留（带 ESC 的完整形态
// 与记录拆散后无 ESC 的尾部形态）必须在入口整体剥离、不留下 `_`；真实
// 下划线、仅形似的方括号文本、普通 bracketed paste 与既有 ANSI/CRLF
// 归一化零误伤。
    ["verify-paste-residue", ['node', '--import', 'tsx/esm', 'scripts/verify-paste-residue.tsx']],
// win32 协议重组回归：conhost 把 SGR/X10 鼠标报告与终端回复（DA1 等）
// 合成成逐字符 CSI Vk;Sc;Uc;Kd;Cs;Rc 记录时，必须跨块重组回完整协议
// 事件而不是逐键泄漏进输入框；截断的鼠标候选在 flush 时丢弃，单独
// Escape/未知 CSI/物理键不受影响。
    ["verify-win32-protocol", ['node', '--import', 'tsx/esm', 'scripts/verify-win32-protocol.ts']],
// 拖放文件粘贴回归：Windows 把拖入的文件名作为 OSC 8 超链接
// （ESC ] 8 ; params ; file:///… ST）送入，win32-input-mode 还会把它拆成
// 逐字符记录——ESC 被当协议消费后，OSC 参数残渣（[16;42;0;1;16;1…）会
// 落进输入框。粘贴载荷只剥「完整 OSC 帧」（含终止符）：恢复后的拖放载荷
// 里不得再出现 ESC 字节或 file:// 文本；CSI/ESC 字面文本与全部 C0 控制字节
// （含 TAB/CR/LF/DEL）按原样交给 composer 压平（T05 hotfix：parser 侧删
// C0 会吃掉 composer 应得的空格），file:// URI 仍能解码成路径进入图片/
// 附件管线。
    ["verify-paste-drop", ['node', '--import', 'tsx/esm', 'scripts/verify-paste-drop.ts']],
// 退出漏斗回归（issue #12）：上下文 teardown 不得走到进程退出。
    ["verify-teardown-exit", ['node', '--import', 'tsx/esm', 'scripts/verify-teardown-exit.tsx']],
// 退出 resume marker 回归（issue #42）：仅有实际消息或 pending 操作时保留 marker。
    ["verify-exit-resume-marker", ['node', '--import', 'tsx/esm', 'scripts/verify-exit-resume-marker.tsx']],
// 退出阶段 stderr/console 恢复回归（issue #42）：shutdown 解绑恢复物理流并注销监听器。
    ["verify-shutdown-stderr", ['node', '--import', 'tsx/esm', 'scripts/verify-shutdown-stderr.tsx']],
// 退出收尾运行时未命中回退：找不到 Ink runtime 时必须走完整 unmount 恢复终端。
    ["verify-shutdown-fallback", ['node', '--import', 'tsx/esm', 'scripts/verify-shutdown-fallback.tsx']],
// 退出鼠标残留回归（issue #522）：detach 闩锁后自愈探针不再重写
// ENABLE_MOUSE_TRACKING；unmount 在末帧渲染抛错时仍同步写完整清理
// （帧在 EXIT_ALT_SCREEN 前、DISABLE 后 SHOW_CURSOR），handle 暴露
// detach 方法供 finishExit 兜底闩锁。
    ["verify-exit-mouse-cleanup", ['node', '--import', 'tsx/esm', 'scripts/verify-exit-mouse-cleanup.tsx']],
// 退出查询泄漏回归（#507/#492）：退出清理（DISABLE）之后，健康探针/
// 模式重断言/已 dispose 的 querier 都不得再写出任何 ENABLE 或查询
// 字节、不得拉回 raw mode——在途回复与鼠标事件由清理后的 re-drain
// 吞掉，不再落入 shell。
    ["verify-exit-mouse-residue", ['node', '--import', 'tsx/esm', 'scripts/verify-exit-mouse-residue.tsx']],
// 组件级拖拽协议回归：无修饰左键 press 捕获 drag target，首动 dragstart、
// 连续 dragmove、release/focus-out/reset 收尾 dragend；未移动仍走 click，
// 无 handler 与修饰键区域保留基线文本选择；真实 SGR 管线 + 最小滑块消费者。
    ["verify-drag-protocol", ['node', '--import', 'tsx/esm', 'scripts/verify-drag-protocol.tsx']],
// hover 事件性能与健壮性回归：同批 motion 保留兴趣边界（tooltip dwell
// 不提前）、无兴趣矩形快路径跳过全树 hit-test，且渲染提交/帧边界/
// 多 root 失效；拖拽 motion 逐事件到达。
    ["verify-hover-coalesce", ['node', '--import', 'tsx/esm', 'scripts/verify-hover-coalesce.tsx']],
// /update 纯函数回归：版本探测（双布局+外来 manifest 拒绝）、
// registry 解析（env/npmrc/默认）、semver 比较、pnpm --latest。
    ["verify-update", ['node', 'scripts/verify-update.mjs']],
// /update 恢复链路端到端回归（#479/#483）：假 dsh 按剧本重放 pnpm 失败
// （Linux EEXIST 必现竞态、Windows 瞬时 ENOENT、真实 404），真实子进程
// 走编译产物——验证陈旧安装清理后重跑成功、瞬时重试升级、真实失败不
// 触发任何恢复且不破坏 profile，重启尾部向替代进程传递 env 契约。
    ["verify-update-recovery", ['node', 'scripts/verify-update-recovery.mjs']],
// /reload 与 /restart 纯函数回归：planReload 五类偏好的应用/跳过/
// 无变化分支、env 与 cordis.yml 显式配置的优先级守卫、模型路由原子
// 规则（provider-only pin 不挡偏好）、两命令的注册与解析。
    ["verify-reload", ['node', '--import', 'tsx/esm', 'scripts/verify-reload.ts']],
// 直达启动器回归（issue #108）：参数透传、残骸 profile 重装、
// 版本不一致提示、双语消息、shellQuote 转义规则。
    ["verify-launcher", ['node', 'scripts/verify-launcher.mjs']],
// CLI 子命令回归（issue #509）：help/version 零环境应答（不触发自举
// 与委托）、双语输出、profile 版本读取、只认第一个参数。
    ["verify-cli-subcommands", ['node', 'scripts/verify-cli-subcommands.mjs']],
// 安全模式回归（PR① spec）：safe 子命令零环境可用与非 TTY 降级、
// 控制面只读（文件系统快照）、插件清单解析矩阵、fallback 触发矩阵
// （非 TTY）、doctor 提取行为等价（完整期望值 golden）。
    ["verify-safe-mode", ['node', 'scripts/verify-safe-mode.mjs']],
// doctor 配置候选项一致性：legacy 根配置 `~/.dsh-tui/cordis.yml` 只在存在时
// 出现（profile 安装不使用它），profile 补丁跟随 `$DSH_HOME ?? ~/.dsh`，且
// CLI 与 TUI 内 /doctor 两个入口对同一份磁盘状态给出同一组候选路径。
    ["verify-doctor-config-paths", ['node', '--import', 'tsx/esm', 'scripts/verify-doctor-config-paths.ts']],
// 剪贴板回归：text/uri-list 严格 URL 解析（远程 authority 拒绝、
// query/fragment 剥离、畸形转义保留）、image/text MIME 挑选、插入格式化；
// stub PATH 假 wl-paste/xclip 集成——CJK 跨 chunk、gnome verb 行、
// 图片导出权限（目录 0700/文件 0600）、空 vs unavailable、
// 死 Wayland 会话回退 xclip。
    ["verify-clipboard", ['node', 'scripts/verify-clipboard.mjs']],
// Ctrl+V UI 端到端回归（stub wl-paste）：帮助面板在读取前关闭、
// 剪贴板文本落入输入框、busy 闩锁释放后第二次粘贴仍生效。
    ["repro-clipboard", ['node', '--import', 'tsx/esm', 'scripts/repro-clipboard.tsx']],
// 粘贴折叠回归：大段粘贴折叠成一行预览 chip（统计+首行预览，非黑盒）、
// 悬停窥视（窗口钉头部）/移开重折叠、点击 chip 固定展开、点击 ▾ 前缀
// 再折叠、Esc 展开不清空、Enter/输入全文提交——鼠标走真实 SGR 事件。
    ["repro-paste-fold", ['node', '--import', 'tsx/esm', 'scripts/repro-paste-fold.tsx']],
// 图片附件回归：剪贴板位图占位符与图片文件 @ 引用进附件库（#152）。
    ["verify-clipboard-image", ['node', '--import', 'tsx/esm', 'scripts/verify-clipboard-image.ts']],
// 拖选复制端到端回归（用户报告：全屏下拖选"只能复制一个字符，只有
// 输入框文字能复制"）：右侧 gutter 误用 NoSelect fromLeftEdge 把整行
// 转录拉进不可选取区。真实 Chat 树 + SGR 拖选注入，静息/上滚阅读+
// 流式并发/流式结束后三场景断言 OSC 52 携带完整选中文本。
    ["repro-drag-select-streaming", ['node', '--import', 'tsx/esm', 'scripts/repro-drag-select-streaming.tsx']],
// 草稿编辑态跨整屏往返回归（#846 增量，PR #942）：真实 Chat 往返——
// 折叠块/全屏编辑器/vim 模式与 insert-normal 子模式随快照往返、空输入
// 框保留模式态、Chat 卸载释放快照独占的 staged 图片、staged 绑定可提交。
// 文本/光标/归属基础往返在 session-workspace 组的
// verify-composer-draft-handoff；在途 staging 围栏在 verify:build 链的
// verify-image-preview。完整 8 场景矩阵见 PR #942 历史。
    ["verify-composer-draft-screen-switch", ['node', '--import', 'tsx/esm', 'scripts/verify-composer-draft-screen-switch.tsx']],
// 队列召回撤回回归（issue #986 后半）：↑ 走位召回的文本若仍挂在 pending 里，
// 必须把那条排队副本撤下来（否则改完重发等于同一句发两遍）——可撤时队列少一条
// 且有提示、已被本轮取走时如实报「撤不回来」且副本留在队列、文本不匹配的排队
// 项一律不动。
    ["verify-prompt-history-queue-retract", ['node', 'scripts/verify-prompt-history-queue-retract.mjs']],
// Shift+Tab 会话模式回归（真实 PromptInput + `\x1b[Z`）：一次按键恰好一次
// cycleMode、不吃发送/排队；并钉住按键入口的失败契约——桩返回 rejected
// promise 时入口必须自己兜住（通知 + 无 unhandledRejection + 处理器仍活），
// 这条在缺 `.catch` 时必红。
    ["verify-shift-tab-mode", ['node', 'scripts/verify-shift-tab-mode.mjs']],
// SGR 鼠标上报分片回归（issue #1160 macOS→SSH 会话重启后、#1120 WSL2 + dsh web）：
// 穷举一条 `ESC[<btn;col;rowM/m` 上报的 2-way / 3-way 切点（每个切点后一次
// escape flush），断言草稿收到的文本里不出现上报字节（修复前 cut=2/3 与 3-way
// 的 a=1/2/3 家族会整条泄漏）；另覆盖 provenance=false 的反吞噬表（字面 `[<`、
// `[<35;10`、Esc 后接 `[` 必须原样通过）与 hold 上界/到期释放（>1000ms 或 >64B
// 必须把持有字节按普通键回放，不丢字节、不重复）。
    ["verify-mouse-report-fragments", ['node', '--import', 'tsx/esm', 'scripts/verify-mouse-report-fragments.tsx']],
// 注：verify-permission-modes 不在此登记。该脚本在基线（dd413712）上本就有
// 22 处失败（Shift+Tab 循环相关的动态 preset / 官方命令路径整段未过），
// 与本次改动无关；把它放进阻塞组会直接红掉 input-terminal。等脚本自身修好
// 后再单独登记。
  ],
  'session-workspace': [
// 跨代理会话迁移回归（claude-code/codex/omp/zcode/grok-build → DSH sessions）：
// 全程跑官方读取链——Session.append 生成骨架（turn 配对/reasoning/
// provenance/空 system head/工具调用/中断/标题/压缩检查点）、
// JsonlSessionPersistence 落盘、open+fromRestore+deriveMessages 逐消息
// 断言（CJK/emoji 无损、wire 合法）、restore 作 seed 续聊写回并替换 head、
// uuid v5 幂等、五 adapter fixture 解析（含 sourceId 只取裸文件名）、
// /migrate 命令分类矩阵。
    ["verify-migrate", ['node', '--import', 'tsx/esm', 'scripts/verify-migrate.mjs']],
// 迁移源解析层回归（纯函数、合成 fixture）：jsonl 坏行计数、注入识别与
// 包装剥离、标题归一、工具调用配对，以及各源逐条解析规则。
    ["verify-migrate-parse", ['node', '--import', 'tsx/esm', 'scripts/verify-migrate-parse.mjs']],
// 外部来源浏览层回归（临时目录合成 fixture）：扫描 IO（头尾窗口、异步遍历、
// 指纹复用）、各源 scan()/load()、来源探测、catalog 快照、单会话导入。
    ["verify-migrate-browse", ['node', '--import', 'tsx/esm', 'scripts/verify-migrate-browse.mjs']],
// /migrate 交互回归（挂真实 Chat）：fresh 会话直接 `/migrate <agent>` 必须
// 打开确认层（旧实现查 picker 行缓存，缓存为空时一律报未知源）、未知源仍
// 被拒、`--dry-run` 要源、多源报 usage、重开选择器清空上一轮勾选。
    ["verify-migrate-command", ['node', '--import', 'tsx/esm', 'scripts/verify-migrate-command.tsx']],
// 审批服务配置回归（issue #49 尾巴）：裸组合 cordis.yml 必须挂载
// approval 行；裸组合与 profile patch 的 policy 表达式逐场景同值
// （ask / never / win32 never），两个入口语义不漂移。
    ["verify-cordis-approval", ['node', 'scripts/verify-cordis-approval.mjs']],
// 工作状态现在由 dsh-working-activity 插件的 session projection 拥有：本 app 只读，
// 不再在进程内折叠。这条静态门禁钉住「唯一 owner」——没有 tracker、没有 status
// import、没有 sidecar、channel 层不转发活动信号也不持 tick。
    ["verify-activity-ownership", ['node', '--import', 'tsx/esm', 'scripts/verify-activity-ownership.ts']],
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
// 非 TTY 宿主门禁回归（Web/Tauri 共存）：profile 装有 dsh-tui 的非终端
// 宿主（stdout 为 pipe/null）必须静默跳过插件、不 throw、不影响宿主启动；
// 显式 dsh-tui launcher/standalone 启动无 TTY 仍保留原报错。
    ["verify-tui-host-mode", ['node', '--import', 'tsx/esm', 'scripts/verify-tui-host-mode.ts']],
// 插件 toast 接缝回归（ctx.tuiToast）：消毒/标量强制、timeout 钳制
// （插件不可 sticky）、未知颜色拒绝、每激活 20/min 限速 + 粘性告警、
// host-only 面不泄漏到插件服务对象、公开 shim 导出。
    ["verify-plugin-toast", ['node', '--import', 'tsx/esm', 'scripts/verify-plugin-toast.tsx']],
// 会话标题回归：选择器标题宽容读取（带未标记第三方事件的日志
// 不能让标题退化成目录名），/rename 的最后一条 session/title 优先。
    ["verify-session-titles", ['node', 'scripts/verify-session-titles.mjs']],
// session/title 载荷形状回归（issue #1006）：真存储栈 e2e——离线写入器
// （/fork + 选择器改名）与实时 /rename 共用的 userTitleData 必须带
// messageSeqs/source，否则严格读取把整份日志判损坏（stored log is
// corrupt: title messageSeqs requires an array）而会话再也 resume 不了；
// 同一夹具塞旧形状 `{ title }` 必须仍被拒（红态自证，回退修复即失败）。
    ["verify-session-title-payload", ['node', 'scripts/verify-session-title-payload.mjs']],
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
// 快捷键 keymap 回归：共享组合语法、动作注册表与 /settings 改键
// （Alt+V 粘贴别名、覆盖热更新、保留位集合、草稿冲突校验），以及
// 真 Chat 里 Alt+V / 改键后的外部编辑器路径。
    ["verify-keymap", ['node', 'scripts/verify-keymap.mjs']],
// vim 编辑模式回归（/vim 命令 + normal/insert 键位 + 徽标 + 撤销栈 +
// insert Esc 让位回合打断）。
    ["verify-vim-mode", ['node', 'scripts/verify-vim-mode.mjs']],
// 输入框鼠标选区编辑回归（drag 协议消费者）：SGR 拖选/Shift+click 扩展/
// 双击选词自检测/Backspace/Delete 删选区/打字替换/Esc 分层/Ctrl+C 经
// Chat→控制器复制选区、CJK 宽字符显示列与 fold block 侧钳制。
    ["verify-input-selection", ['node', '--import', 'tsx/esm', 'scripts/verify-input-selection.tsx']],
// 全屏草稿编辑回归（expandEditor）：Ctrl+Shift+E/✎ 展开收起、Enter 换行
// 不发送、Ctrl+Enter 发送并收起、Esc 分层（选区→收起）、点击定位/拖选、
// 行号渲染、多行窗口跟随 + onWheel 滚轮自由滚动、折叠块互斥（展开清块/
// 展开态粘贴纯文本）、设置开关（expandEditor=false 入口消失）。
    ["verify-expand-editor", ['node', '--import', 'tsx/esm', 'scripts/verify-expand-editor.tsx']],
// 三合一会话管理界面回归（issue #879）：/resume、/agentview、/home 合并为
// 同一个 SessionSupervisor 后的两条硬性质——它确实是一个界面（工作区栏 +
// 该工作区会话 + 每行活跃状态 + 当前会话标记），以及被其他 TUI 终端占用的
// 会话可见但不可进入（点击绝不落到 channel.resumeTo，否则两个进程会交错写
// 同一份 append-only 会话日志）。
    ["verify-session-supervisor", ['node', '--import', 'tsx/esm', 'scripts/verify-session-supervisor.tsx']],
// 输入历史草稿回归（issue #287）：首次 ↑ 保存未提交草稿，遍历历史后
// ↓ 回到末尾必须恢复原文，重复越界不能把草稿清空。
    ["verify-prompt-history-draft", ['node', 'scripts/verify-prompt-history-draft.mjs']],
// 输入历史持久化回归（issue #986）：↑/↓ 必须走磁盘上的 history.jsonl——
// 冷启动后第一次 ↑ 召回的是最新一条（文件是追加序，漏了反转会翻出最旧的）、
// 能一路走到最旧并在那里钳住、本次进程提交的条目排在持久化条目之后且
// 接缝处不重复、重新挂载（重启）后仍能召回。
    ["verify-prompt-history-persist", ['node', 'scripts/verify-prompt-history-persist.mjs']],
// 草稿撤销回归：Ctrl+Z 是输入框草稿的词级撤销（两种按键编码等价、CJK 走
// ICU 分词、700ms 空闲切步、粘贴/提交/召回/Esc 清空的栈语义、图片能力保活），
// 且与 Esc Esc 的会话回溯不是一回事（栈空不触发 rewind）。
    ["verify-prompt-undo", ['node', 'scripts/verify-prompt-undo.mjs']],
// SIGCONT 恢复 raw mode 回归：Ctrl+Z 不再自停，外部 stop（kill -STOP / shell
// suspend）后 shell 把 tty 留在自己的 cooked 模式，SIGCONT 必须把 termios 放回，
// 否则输入框只画帧、按键被行规吃掉。
    ["verify-sigcont-rawmode", ['node', 'scripts/verify-sigcont-rawmode.mjs']],
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
// 真 JSONL 混合版本库：无关追加不重读旧会话摘要，文件改写/替换仍须失效。
    ["verify-session-artifact-cache", ['node', 'scripts/verify-session-artifact-cache.mjs']],
// 跨进程首屏快照：不等慢枚举、来源隔离、失败保留、空库清空与迟到守卫。
    ["verify-session-list-snapshot", ['node', 'scripts/verify-session-list-snapshot.mjs']],
// 空会话须完整读取后才能判定：截断/损坏、帧数上限、纯图片输入与旧缓存
// 不得隐藏真实历史或进入清理名单；真实 JSONL 重开验证落盘后的可见性。
    ['verify-session-emptiness', ['node', '--import', 'tsx/esm', 'scripts/verify-session-emptiness.ts']],
// /resume 会话浏览器按键流回归：子运行折叠/展开、空会话不列出、搜索、
// Esc 先清查询再退出、rename 后光标按 id 跟随目标（不是按行号）、
// confirm-delete 只认无修饰 Enter、Esc 取消。真实 Chat 渲染驱动。
    ["verify-session-browser", ['node', 'scripts/verify-session-browser.mjs']],
// 未发送草稿的跨屏交接回归：真实 PromptInput 真卸载再重挂——快照带上
// 光标偏移与图片绑定、按 agent 与世代校验归属、被回收的图片能力不复活、
// 空草稿不留残留。这条测的是「渲染期写回会先于认领 effect 覆盖草稿」，
// 只靠打字或由浮层换屏都到不了。
    ["verify-composer-draft-handoff", ['node', '--import', 'tsx/esm', 'scripts/verify-composer-draft-handoff.tsx']],
// Tooltip 悬停提示回归：悬停截断元素 ~600ms 后弹完整内容浮层——延迟未到
// 不出现、到点内容正确、leave 即隐、leave 早于延迟取消、自定义 delayMs、
// 多行内容锚点上方、屏顶锚点转下方、resize 隐藏（几何失效）、窄屏水平钳制；
// 复制干扰：折行的用户消息不再武装浮层（文本本就全可见，且卡片会盖住
// 待复制单元格），文本选区拖动/存续期间整个浮层层熄灭（dwell 照常触发
// 但不上屏），选区落定清掉 pending 卡片，随后悬停恢复。
    ["verify-tooltip", ['node', '--import', 'tsx/esm', 'scripts/verify-tooltip.tsx']],
// 工具卡头部 hover tooltip 内容门控回归：头部已经完整显示（单行标题 / 未
// 超出预算的 args）时悬停不再弹「重复可见文本」的浮层，改弹卡片元数据
// （开始/结束时刻、耗时、运行中时长）；折叠的终端脚本与超出 480 字符预算
// 的 args 仍弹完整内容（弹层优先真隐藏内容）。
    ["verify-tool-tooltip-gating", ['node', '--import', 'tsx/esm', 'scripts/verify-tool-tooltip-gating.tsx']],
// 工具卡 i18n 回归（issue #980）：卡片簇（AssistantToolUseMessage /
// SplitDiffView）的界面文案——工具名、按行折叠提示、退出码/信号行、
// 运行中占位、搜索截断——必须在 zh/en 双语都走字典渲染；与 verify-i18n
// 的字面量 tripwire 互补（那边管源码侧，这边管渲染侧）。
    ["verify-toolcard-i18n", ['node', '--import', 'tsx/esm', 'scripts/verify-toolcard-i18n.tsx']],
// 悬停浮层第二批回归：@ 文件补全面板长路径悬停弹全路径（完整可见的短路径
// 不弹）、会话列表行标题截断悬停弹完整标题+绝对时间+cwd（未截断不重复
// 标题）、状态栏 model/git 字段悬停明细（provider/ctx 窗口/完整分支）、
// cache 字段悬停明细只列非零缓存分项（DeepSeek 路由不上报缓存写入）。
    ["verify-hover-details", ['node', '--import', 'tsx/esm', 'scripts/verify-hover-details.tsx']],
// 便携包更新解压链安全回归：Windows 解压优先 tar.exe 数组参数，回退
// Expand-Archive 的两个路径按 PowerShell 约定把 ' 双写为 ''——路径派生
// 自环境变量，不转义即可注入任意命令；解压与替换之间的提取树校验拒绝
// 符号链接、逃逸条目与硬链接成员（GNU tar 实测会落地 symlink 成员，
// zip-slip 落地形式；LNKTYPE 指向树内目标时落地 nlink=2）。
// 恶意 zip/tar.gz fixture 由 python3 构造（../evil.txt 成员、
// 指向 /etc/passwd 的链接成员、指向树内目标的硬链接成员）。
    ["verify-update-extract", ['node', '--import', 'tsx/esm', 'scripts/verify-update-extract.tsx']],
// 便携包更新下载 SHA256 校验回归：SHA256SUMS 清单解析（两空格/二进制
// 星号/裸 digest 旁注）、篡改资产字节 fail-closed 拒绝且磁盘零残留、
// 无 sums 走 transition 警告、content-length 超 512MB 读 body 前拒绝、
// 无 content-length 无界流读到上限即刻断连（注入小上限；主资产与清单
// 两条流各测一遍）、镜像回退（API 失败→registry→直链）同样探测固定
// 命名清单并强校验。本地 http server + mock fetch + 临时假二进制，
// 不发真实请求。
    ["verify-update-checksum", ['node', '--import', 'tsx/esm', 'scripts/verify-update-checksum.tsx']],
// 便携包运行时缓存守卫回归：解压树启动链（bin→主模块两级闭包）的
// 哈希清单——清单内 JS 篡改/删除 → not ready 自愈重建、旧格式 marker
// （仅 bundleId）自愈升级、清单外文件不设防（边界确认）、chmod 收紧
// 限定自建层级（预存 cacheBase 保持用户权限，自建根目录与版本子目录
// 0700）。mini runtime fixture 由清单造树 + 系统 tar 打包，解压器注入。
    ["verify-standalone-cache-guard", ['node', 'scripts/verify-standalone-cache-guard.mjs']],
// ~/.dsh-tui 数据文件权限回归（安全修复）：history.jsonl（用户输入全文）、
// mouse-debug.log 与 session-index.json（会话标题/分支名）落盘 0600、
// DATA_DIR 建目录 0700；临时 HOME 重定向 + 固定 umask，修复前按 umask
// 落 0644 必红。
    ["verify-data-file-perms", ['node', '--import', 'tsx/esm', 'scripts/verify-data-file-perms.tsx']],
// /tree 搜索框显示塌缩回归：SearchBox 的单行窗口化预算取自实测自身宽度，
// 自适应宽度（默认 row 包裹、无 width prop）会让预算跟随内容收缩，收敛到
// 「前缀 + 1 字符 + 反色 caret」——只看得见最新输入的字符。断言逐键输入
// 完整可见，并守住超长查询单行窗口化语义（尾部可见、头部滚出、不折行）。
    ["verify-searchbox-windowing", ['node', '--import', 'tsx/esm', 'scripts/verify-searchbox-windowing.tsx']],
// 崩溃可观测性回归（React #185 闪退后续）：退出漏斗的崩溃行原来只带
// error.message，生产压缩 React 只留 "Minified React error #185" 一行、
// 四次真机闪退零取证。serializeCrashDetail（src/utils/crashDetail.ts，
// 纯函数）逐层序列化 stack / .cause 链 / componentStack / digest，
// formatCrashLogLine 钉死 crash.log 的 "<UTC ISO> pid=<pid> <text>" 行
// 格式，appendCrashLog 实写临时目录且吞掉写失败；源码 tripwire 保证
// plugin.ts 崩溃分支真的接线（回退成 message-only 必红）。
    ["verify-crash-detail", ['node', '--import', 'tsx/esm', 'scripts/verify-crash-detail.ts']],
  ],
  'channel-ui': [
// L4 composition boundary plus report/metadata lifetime fences.
    ["verify-channel-composition", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-composition.ts']],
// 状态行的读侧：会话键控、变更通知、宿主发布值的防御性收窄、绑定时的基线读取
// （投影只在变化时推送，恢复/重连的会话必须自己读一次当前值）。
    ["verify-activity-store", ['node', '--import', 'tsx/esm', 'scripts/verify-activity-store.ts']],
// 状态行的渲染面：投影值经 hook 到达屏幕、后台会话不得抢当前行、清空即消失、
// 两个接缝同时有值时以投影为准（读侧迁移对显示是零变化）。
    ["verify-activity-store-render", ['node', '--import', 'tsx/esm', 'scripts/verify-activity-store-render.tsx']],
    ["verify-channel-owner-lifecycle", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-owner-lifecycle.ts']],
    ["verify-channel-router-lifecycle", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-router-lifecycle.ts']],
    ["verify-reports-metadata",  ['node', '--import', 'tsx/esm', 'scripts/verify-reports-metadata.ts']],
// ChannelUi 读投影边界：会话事件日志（traceEvents）必须零拷贝直通——它每次
// append 都换新的快照数组，走 detached 投影会 O(events) 重建整条数组，而
// Chat 每次渲染都读它（长会话 44 万事件实测每帧上百毫秒）。同时钉住 rows
// 仍然是被投影的冻结副本，修复不得拆掉 detached 契约。
    ["verify-channel-trace-read", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-trace-read.ts']],
// channel 层回归：发送链（submit/steer/撤回/打断重投）、compact 折叠、
// goal/todo 事件回放。曾因不在 CI 而随接口演进静默失效（0.3.6 的
// installModelSelection、#34 的投递异步化都没被它们拦下），挂进来
// 防再腐烂。
    ["verify-submit", ['node', '--import', 'tsx/esm', 'scripts/verify-submit.mjs']],
// 打断后排队消息「停靠」（对齐 Claude Code 2.1.284：Esc 打断=停靠不自动发、
// ↑ 选一条编辑、空输入 ⏎ 全部发送恰好一次）。channel 层双后端各钉一遍：DSH
// 夹具（真 createDshSession：interrupt cancel 不带 keepInbox、内核 discard
// 事件不删停靠预览、本地撤回不经 inbox.remove、user-cancel 仍 keepInbox、
// claim 照常退场、Ctrl+Enter 连停靠一起立即投且各恰好一次）与 Claude 形
// 夹具（裸 AgentSession：retractPending=false 下停靠行仍可本地撤回、空
// still_queued 停靠成立、无 cancelQueued 能力的 CLI 回执 kept id → 撤销
// 停靠由 discard 正常退场；未确认回执（R2-1）：interrupt 拒绝/旧 CLI 无回执
// → 撤销停靠+明确 notice+SDK 只接受同意图一份、请求期间停靠的行不乘旧回执
// 的快照、回执落定后再 Esc 自发新请求、只有确认撤销的副本可重发；回执在途
// 的过渡停靠（R7）：deliver/remove/swap/Ctrl+Enter 全被门住（视觉停靠但不可
// 编辑/重发/交换），confirmed 空单才放行，迟到 failed/unknown/still_queued 只
// 撤销仍在 pending 的行——换过 id 的追不回，所以权利必须前置门住）。UI 层
// 键位（Esc 停靠/⏎ 全发/↑ 选择器/Esc 退出选择器/Alt+↑ 兼容）在
// verify-queue.mjs。
    ["verify-docked-queue", ['node', 'scripts/verify-docked-queue.mjs']],
    ['verify-shell-compat', ['node', 'scripts/verify-shell-compat.mjs']],
    ['verify-agent-lifecycle-compat', ['node', 'scripts/verify-agent-lifecycle-compat.mjs']],
    ['verify-bundled-presets', ['node', 'scripts/verify-bundled-presets.mjs']],
    ['verify-preset-startup', ['node', 'scripts/verify-preset-startup.mjs']],
// 随包用户手册（guide/）：副本与 docs/ 逐字节一致 + SKILL.md 能被内核加载 +
// 发布面与启动器真的把它带上。npm 包原本不含任何用户文档，用户机器上的 AI
// 无从"查手册回答"；这条门禁保证手册在包内且没漂移。
    ['verify-guide', ['node', 'scripts/verify-guide.mjs']],
    ['verify-message-compat', ['node', 'scripts/verify-message-compat.mjs']],
    ['verify-settings-compat', ['node', '--import', 'tsx/esm', 'scripts/verify-settings-compat.mjs']],
// 设置读点的 ns 归属（issue #1124）：分区注册与写入用 Config owner 的 Loader id
// （可为自定义 id），读点（channel.autoRecapOnOpen、Chat 的 lang 镜像、/reload 的
// langOverriddenBySettings）必须用同一个 ns —— 写死 'dsh-tui' 会让非默认挂载
// 「写得进、读不回」，自动回顾永远关不掉。
    ["verify-settings-namespace", ['node', '--import', 'tsx/esm', 'scripts/verify-settings-namespace.ts']],
    ["verify-compact", ['node', '--import', 'tsx/esm', 'scripts/verify-compact.mjs']],
    ["verify-compaction-progress", ['node', '--import', 'tsx/esm', 'scripts/verify-compaction-progress.tsx']],
// #1030：隔离 locale、持久化 /lang 与环境变量，不能靠 CI 的 zh 默认掩盖脚本依赖。
    ['verify-regression-language', ['node', 'scripts/verify-regression-language.mjs']],
    ["verify-context-warning", ['node', '--import', 'tsx/esm', 'scripts/verify-context-warning.mjs']],
// 占用单一真源回归（PR2）：官方 `contextPressure` 投影在场时占用 = `projectedTokens ??
// pressureTokens`（与会话累计未缓存输入解耦、随投影变更重发、非 completed 回合也评估
// 告警、压缩检查点不改写本地量），投影缺席（裸 cordis.yml 无 token-meter）时回退到
// 上次成功请求的计费采样且软失败不抛。
    ["verify-context-occupancy", ['node', '--import', 'tsx/esm', 'scripts/verify-context-occupancy.ts']],
// 分段估算口径回归（#1170）：estimateTokens 由 chars/4 改为 CJK 感知的纯函数——
// 单条纯 ASCII 与旧口径相同（显式快路径；跨消息累加因改为逐条 ceil 会有 ≤1
// token/条的舍入差），中文/全角按 ~1.4 字符/token、其它脚本按 ~2；单调不减、
// 非负、代理对与 ANSI 转义的处理都在这里钉死。
    ["verify-cjk-token-estimate", ['node', '--import', 'tsx/esm', 'scripts/verify-cjk-token-estimate.ts']],
    ["verify-channel-goal-todo", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-goal-todo.mjs']],
// 投影黄金基线（多后端方案 §6.4）：scripts/fixtures/dsh/ 的合成 DSH 日志
// + 流帧经「DSH 翻译器 + 共享投影器」的 replay 与 live 两路，与 Phase 0
// 由拆分前投影器生成的 *.golden.json 逐字段比较；live 与 replay 的差异
// 必须有登记的理由，不改黄金文件也必须通过。
    ["verify-projection-golden", ['node', '--import', 'tsx/esm', 'scripts/verify-projection-golden.ts']],
// DSH 翻译器词汇覆盖（多后端方案 §6.2/§8.2）：同一批 fixture 经翻译器的
// live/replay 两路，逐行断言 §6.2 每一类 DSH 事件产出对应 AgentEvent 与身份字段。
    ["verify-dsh-translate", ['node', '--import', 'tsx/esm', 'scripts/verify-dsh-translate.ts']],
// 非 DSH 会话上的 channel（多后端方案 §3.5，Phase 2 checkpoint B）：能力快照、
// 只提供后端支持的命令、通用动作走 AgentSession、DSH 专属动作显式不可用
// （通知 + 契约失败值）、能力在场时委托、/new 经后端 open、换会话后的代际
// 栅栏；同一入口的 DSH channel 命令表与今天逐字一致。
    ["verify-backend-channel", ['node', '--import', 'tsx/esm', 'scripts/verify-backend-channel.ts']],
// channel 构造是一个 owner 事务（Phase 4a 核心 + DSH 扩展）：核心构造、DSH 扩展
// 挂载、首次 bind 中任一步抛错，都释放宿主监听、agent 上下文监听、决策拓扑标记、
// IDE 选区连接（真实 loopback）与计时器，并关闭自管生命周期的非 DSH 会话。
    ["verify-channel-rollback", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-rollback.ts']],
// 真实 Chat 挂在非 DSH channel 上：斜杠菜单/Tab 只给后端支持的命令，键入的
// 不可用命令提示 cmd-unavailable-backend、绝不落到模型（运行中也不 steer）。
    ["verify-backend-chat", ['node', '--import', 'tsx/esm', 'scripts/verify-backend-chat.tsx']],
// 只有 token 计数、没有正文的思考行（方案 §4.5 (b)）：投影器 reasoning-tokens
// → ChatRow.reasoningTokens，流式一行「思考中 · ~N tokens」、落定「已思考 ·
// ~N tokens」，正文到达时正文优先；中英双语。
    ["verify-thinking-tokens", ['node', '--import', 'tsx/esm', 'scripts/verify-thinking-tokens.tsx']],
// Claude 后端翻译器（方案 §5.1，Phase 2）：scripts/fixtures/claude/ 下脱敏的真实
// SDK 消息序列 → 翻译器 → 共享投影器，与提交的 golden 逐字段比较，外加 Phase 0
// 各项实测修正的定点断言（先判 terminal_reason、[ede_diagnostic] 不上屏、中断
// 回显不成气泡、前台 Bash 不建任务卡、attempt.start 先于 delta、工具结果文本）。
    ["verify-claude-translate", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-translate.ts']],
// Claude 会话生命周期（假 Query，无网络）：开关 ×50 无残留、放置→priority、
// 取消与 30s 强制收敛（注入时钟）、取消回执三态（拒绝=failed/旧 CLI 无回执=
// unknown/still_queued=confirmed，快照边界不记请求期间新输入，R2-1）、权限回调
// 必定落定、进程死亡、握手失败。
// 真实 CLI 的 verify-claude-live / verify-claude-headless 只在
// DSH_TUI_CLAUDE_LIVE=1 时跑，不进 CI（消耗真实用量、需要凭证）。
    ["verify-claude-session-lifecycle", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-session-lifecycle.ts']],
// Claude 会话恢复回放（方案 §4.11，Phase 4b）：scripts/fixtures/claude/transcripts/ 下与流录制
// 一起脱敏的读 API 转录 → replay → 共享投影器，与 golden 逐字段比较；按真实提问切分 turn、
// 行锚点 = 推送时的 uuid、排队提问并入、中断/通知/本地命令回显/压缩摘要、工具结果配对、
// 子代理不进主转录、回放与 live 同一会话行一致、resume 后 live 编号接续。
    ["verify-claude-replay", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-replay.ts']],
// Claude 会话生命周期（假 SDK + 临时 HOME）：catalog 列表/标题来源/预览/改名/删除、resume
// 先读转录再以 resume 启动、/fork 与 rewind（文件/对话/两者）、channel 的浏览器列表、
// /resume 历史先于 live 绘制、claude:<id> 挂载账本（真实对端进程占用即拒绝）、失败响亮、
// 当前/被占用会话不可删、/fork 提示、rewind 提示与三种模式、启动历史先于首个 live 事件。
    ["verify-claude-catalog", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-catalog.ts']],
// Claude 子代理（方案 §4.8，Phase 5a，假 SDK + 录制 fixture）：Agent 调用预建卡片、
// task_started 以任务 id 补全（同一 lane 重键）、子通道的文本/工具进卡片与面板而不进
// 主转录、task_progress/task_notification 的用量与终态、stopTask 停止、后台子代理与
// 层级信号（缺席即推断 unknown，真实结束仍覆盖）、resume 回放子转录内容与终态推断，
// 以及 /agents、仪表盘与详情场景的无头渲染。
    ["verify-claude-subagents", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-subagents.ts']],
// Claude 后台任务（假 SDK + 录制 fixture）：后台 Bash 生命周期（任务卡、确认文本里的
// 输出文件、状态栏 chip、一次落定提示）、前台 Bash 只有工具卡、tasks.snapshot 的
// REPLACE 语义、kill → stopTask、用户中断不停任务；输出尾部只读 CLI 报告的路径并校验
// （<id>.output、解析符号链接后仍在 CLI 目录内、普通文件、最后 64 KiB）、每秒至多一次、
// 取消观察即停；任务卡与 /jobs 面板的无头渲染。
    ["verify-claude-tasks", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-tasks.ts']],
// Claude Task* 工具族 → 待办面板（CLI 2.1.284：TaskCreate/TaskUpdate/TaskList/TaskGet 取代
// TodoWrite，两族都是 preset 不带的 shouldDefer 工具）：离线合成帧过真翻译器 + 共享投影器——
// 角色映射（Task 子代理 / TaskStop 后台任务不卷入）、状态机（create 输入给内容/结果给 id、
// update 输入直接打补丁、deleted 移除、list/get 结果为准覆盖本地）、每次变化发完整
// todo.write 快照（TodoPanelItem 形状、创建序、不建卡）、TodoWrite 原路径逐字节不变、
// buildQueryOptions 的 allowedTools 附加+预批准且 tools 仍是 preset。
    ["verify-claude-task-tools", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-task-tools.ts']],
// Claude 会话的 Working Activity 工作行（复用 DSH 工作行的 ActivityView 形状）：
// 翻译器自身状态（openCalls/回合锚点/⏵ 自述行/TaskUpdate activeForm/本回合工具计数）
// 由 activity.ts 折叠成 WorkingActivityView——首回合前零发布（随机动词 spinner 原样）、
// 回合内 thinking/⏵ 叙述/tool(label+detail)/权限停靠 waiting、回合结束 done 卡（live=false）、
// 下回合复活；detail 提取优先级与截断；会话级（假 SDK）能力订阅真实回合上屏、迟到订阅者
// 立即收到最新值（红→绿杠杆＝session.ts 的发布钩子）。
    ["verify-claude-activity", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-activity.ts']],
  ["verify-claude-sdk-warnings", ['node', 'scripts/verify-claude-sdk-warnings.mjs']],
// Claude「加载更早消息」（方案 §4.11 压缩前历史）：按会话 id 扫描定位原生 JSONL、坏行容忍、
// 超限拒读；两次压缩的转录按 parentUuid 链逐段回溯（保留段的拼接与排除）、有界分片不重叠、
// 用尽后幂等；channel 上 olderHistory 显示分隔线、loadOlder 逐段前插（负 id、restored）；
// Claude 长会话重新折叠（只折有锚点的行）、保留文本有界、loadOlder 先从转录恢复折叠行。
    ["verify-claude-load-older", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-load-older.ts']],
// 共享权限面板（方案 §4.7，Phase 3）：PermissionStore 的 FIFO、选项与呈现规则、
// 四种结局（含拒绝理由）、撤回/会话释放/拆除不二次作答；channel 桥把会话的
// permission/question 事件接到 store 与问卷，答复经能力回到后端。
    ["verify-permission-store", ['node', '--import', 'tsx/esm', 'scripts/verify-permission-store.ts']],
// Claude 权限桥（假 Query）：允许一次/始终允许/拒绝的 PermissionResult、选项生成
// 与抑制、六条死锁规则、AskUserQuestion 作答与取消、ExitPlanMode 批准/继续规划、
// requires-action，以及翻译器的 permission_denied/计划工具/问卷记录。
    ["verify-claude-permissions", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-permissions.ts']],
// 审批面板的选项变体（中英）：DSH 无选项=今天的两行与结局字符串、后端三选项、
// defaultToNo 拒绝居首且无单键批准、allow-always 抑制、打字附拒绝理由。
    ["verify-approval-panel-options", ['node', '--import', 'tsx/esm', 'scripts/verify-approval-panel-options.tsx']],
// Claude 凭证（方案 §4.12，D-AUTH）：dsh-auth 登录 > 环境 > 本机 claude login 的优先级
// 与 env 清洗、到期前刷新（凭证文件锁内落盘）、探测、认证失败刷新后以同一会话
// resume 一次、二次失败引导 /login，且任何事件/提示/日志都不含令牌。
    ["verify-claude-auth", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-auth.ts']],
// Claude 控制面（假 Query）：model/effort/mode/compact/commands/mcp/context/account
// 的能力委托与持久化，channel 侧的原生模式标签、后端命令合并、/mcp、/context、
// 订阅用量、/login 宿主，以及状态栏模式标签与 /context 面板的无头渲染；effort
// 收敛不只 manual switch——open/resume seed、init 帧、message_start 漂移都按
// 「明确不支持/声明档位排除」收敛（缺元数据保留，R2-4）。
    ["verify-claude-controls", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-controls.tsx']],
// Claude 权限模式名册（/permission 选择器）：bypassPermissions 必须在运行期名册里、
// 且选择器真能切进去——allowDangerouslySkipPermissions 是 SDK 的**闸门**（sdk.d.ts:2001
// 要求 bypassPermissions 必须带它、sdk.d.ts:331 说没它预热起来的进程无法进入 bypass），
// 所以恒随 query options 下发，而 permissionMode 仍等于 env/settings/default 解析出的
// 起始 mode；每行必须带非空 description 且不等于自己的 label（此前每行把名字打两遍）；
// 安全线不放松：settings 里的 defaultMode=bypassPermissions 仍降级为 default，提示里
// 必须指出可在 /permission 显式选择。登记在 channel-ui（与其余 Claude 后端回归同组，
// 它们共用假 SDK 夹具；input-terminal / session-workspace 都不含后端面）。
    ["verify-claude-mode-roster", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-mode-roster.ts']],
// 渠道档案回归（/channel 二期）：channels.json 存储 best-effort（坏文件读空、写失败只进
// debug、临时文件+rename 原子提交、窄化）、真源优先级全链（active channel 的 models 精确+base
// 归一 > tiers 档位+default > 旧 model-names.json > settings env > 原始 id；channel 未激活时
// 与四期前逐字节一致）、settings 导入形状（host 作名、ANTHROPIC_*_MODEL 吸成 tiers、不猜
// models、重复导入刷新同 id）、/channel 门控（BACKEND_CHANNEL_COMMAND 随能力出现、DSH 永不
// 列出）、切换后 modelDisplay 经 session-controls 的 refreshModelDisplay 钩子同调用刷新。
    ["verify-claude-channels", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-channels.ts']],
// Claude 可执行文件解析回归（方案 §4.2）：PATH 候选必须本进程真能 spawn（--version
// 探针，与 SDK 同一 execFile 路径）才可采纳——npm 在 Windows 发布的扩展名空 POSIX
// 转发脚本/.cmd 会以"native binary failed to launch"拖垮整个启动；转发脚本被跟随到
// 其指向的真实二进制（仍是用户自己的 CLI），全部不可启动才落到 SDK 自带；挂死候选
// 被探针超时切断（POSIX 夹具）；process.ts 认的可执行文件环境变量显式值原样优先、不做二次校验。
    ["verify-claude-executable", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-executable.ts']],
// Claude 的 MCP elicitation 与用户对话框（方案 §4.3/§4.7，Phase 5b，假 Query）：表单字段
// → 问卷（枚举/布尔/多选/文本与数字校验、无效项重问、可选项可跳过）→ accept/decline/
// cancel；URL 模式的提示行与链接、elicitation_complete 关闭；不支持的模式拒绝；
// refusal_fallback_prompt 重试/取消/关闭、未声明种类直接 cancelled、重投同一答复；
// 中断与释放收回面板；经 channel 桥与真实 QuestionStore 端到端，面板渲染链接。
    ["verify-claude-dialogs", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-dialogs.ts']],
// Claude 提示审计（方案 §5.1，Phase 5b）：fixtures/claude/notices 下的消息夹具逐类
// 断言（api_retry、模型拒绝回退/无回退、informational 级别、notification 优先级、
// 限流告警/拒绝只报一次、permission_denied、auth_status 错误、memory_recall、
// conversation_reset、elicitation_complete），投影器按 key 去重（toast 替换、行原地更新）。
    ["verify-claude-notices", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-notices.ts']],
// Claude 对话重置（方案 §4.11，Phase 5b，假 Query）：conversation_reset → 清空行、
// 名册、用量/费用/标题并加提示行，批内重置先投影其前的事件；之后按新会话 id
// （ref、sessionRef、/fork、重连、启动器 resume 标记）；TUI 的 /clear 仍只清视图。
    ["verify-claude-reset", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-reset.ts']],
// Claude 会话命令（方案 §5.3，Phase 5b，假 Query）：/btw、/recap 的侧问是一次性 fork
// （resume 当前 id + forkSession + persistSession:false + 无工具 + 单轮 + 同模型/env/钉住），
// 流式、结束/中断/出错都关闭；/rename 走 renameSession 并发 session.title（未落盘先记下、
// 首次落盘补写）；/color 按会话 id 存 prefs（上限 200、最旧淘汰、重开恢复）；
// /mcp reconnect|toggle 走能力并补全子命令/服务器名/on|off；DSH 的命令集不变。
    ["verify-claude-session-commands", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-session-commands.ts']],
// Claude 图片输入（Phase 5b，假 Query）：带 images 能力的会话由核心在内存暂存（不经 DSH
// attachments 服务；同一限额模型、内容寻址、有界淘汰），submit 在文本后发 base64 块，
// 限额（类型/5 MiB/20 张/合计 20 MiB）与"图片块缺 facade 即拒发"；用户行由暂存字节
// 支撑，@ 图片同路径；回放 base64 成惰性 facade；无该能力的会话（DSH）行为不变。
    ["verify-claude-images", ['node', '--import', 'tsx/esm', 'scripts/verify-claude-images.ts']],
// IDE 选区通道回归（PR #562）：纯函数（env 直连/lock 扫描与 workspace
// 匹配过滤/hello_ack 解析/selection_changed 校验）、无 IDE 静默降级、
// loopback 对连（token 握手 ACK、错误 token 换下一候选、断连清空）、
// 选区消费（text 优先/磁盘回退/截断计数/replay 指示回扫）。
    ["verify-ide-channel", ['node', '--import', 'tsx/esm', 'scripts/verify-ide-channel.tsx']],
// 「Send to Chat」channel 层回归（侧栏设计 §6.7）：attach/detach/consume 的投影
// 语义（id 自增、重复 sourceId+title 替换、超限截断 + truncated）与
// <attached-context …> 块形状（转义、截断标记）；真 channel 的提交 payload 经
// composer 路径附块、提交后 chip 清空、consume-once、真实 /new 切换清空；
// 真 PromptInput 的 chip 上屏/在输入行上方/多枚横排/超宽单行截断，以及 Esc 分层
// （第一次只清 chip 不动草稿，第二次才清草稿）。
    ["verify-attached-context", ['node', '--import', 'tsx/esm', 'scripts/verify-attached-context.tsx']],
    ["verify-whale-toggle", ['node', '--import', 'tsx/esm', 'scripts/verify-whale-toggle.mjs']],
// 开屏大字字体设置（splashFont）：每个 id 解析到自己那款、daily 交回按天轮换、
// 非法值回落 daily、channel 往返、/settings 选项覆盖全部取值、Config 默认值，
// 以及 fontId 缝真的换脸（经典款上屏/方板款不在场）。
    ["verify-splash-font-setting", ['node', '--import', 'tsx/esm', 'scripts/verify-splash-font-setting.mjs']],
// 开屏鲸鱼三选一（classic 组合开场/heart/sleep）：帧表完整性（22 帧
// 含 heart/sleep 新调色）、序列合法性（standard 起止/纯自家行为帧、
// classic 仍捆绑眨眼+喷水+摆尾）、随机选取 API 覆盖/钳制/每次挂载
// 独立重掷、LogoV2 渲染冒烟（粉爱心/灰 Z 上屏后落定消失）。
    ["verify-whale-intro", ['node', '--import', 'tsx/esm', 'scripts/verify-whale-intro.mjs']],
// 开屏定格后的鲸鱼闲置行为（whaleIdle 设置，默认开）：纯规划器帧选
// 择与节拍（闲置偶动/入睡/工作唤醒/点击爱心单向播完）、频道接线。
    ["verify-whale-idle", ['node', '--import', 'tsx/esm', 'scripts/verify-whale-idle.mjs']],
// 计划退出恢复进入前权限；覆盖延迟切换、会话恢复与未知权限不提权。
    ["verify-plan-exit-restore", ['node', 'scripts/verify-plan-exit-restore.mjs']],
// 会话切换/清屏卫生：子代理投影（行 map/任务描述队列/仪表盘快照）随
// 切换重置、/clear 后在途子代理卡可回现、staged image token 会话作用域
// （switchModel 不泄漏）、resumeTo 竞争切换守卫、recap 预算从新到旧收容。
    ["verify-session-reset-hygiene", ['node', '--import', 'tsx/esm', 'scripts/verify-session-reset-hygiene.tsx']],
// 会话总览投影回归：派生辅助（折叠/摘要/状态映射/标题回退）+ Chat 接线
// （「← N 个会话等待输入」页脚与空输入按 ← 请求后台化）。整屏 Agent View
// 已随三合一会话界面删除，其断言一并移除。
    ["verify-agent-view", ['node', '--import', 'tsx/esm', 'scripts/verify-agent-view.mjs']],
// 后台任务（ctx.jobs）UI 投影：BackgroundJobStore 单元（注册/转换/消失
// 合成 killed/输出镜像有界）、channel 集成（建卡、job_output 镜像、落定
// toast、kill 权限传递、无 jobs 服务降级、/new 重置）、JobCard/JobsPanel
// 渲染冒烟（三行瀑布、settled 折叠、面板行/提示）。
    ["verify-jobs-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-jobs-panel.tsx']],
// jobs 侧栏迁移回归：SidePanelColumn/PanelHost 内挂真实 useSidePanel 与假
// channel——badge（running→info、未见 failed→error、打开清错）、名册渲染、
// usePanelInput 分派（↓ 移动 / 双 k kill / Esc 让出回聊天）、SGR 点击聚焦、
// jobsFocusStore 聚焦通道（nonce 重放）。
    ["verify-jobs-side-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-jobs-side-panel.tsx']],
// agents 侧栏迁移回归：SubagentDashboard/SubagentDetailScene 的 panel variant
// 挂在 PanelHost 内——badge（running→info、未见 failed→error、打开清错）、
// 面板内 dashboard 渲染（1 格外边距 + 分隔线跟随面板列宽）、Enter 进详情、
// ←/→ 翻页、**详情 Esc 回 dashboard 且焦点仍在右栏**、dashboard Esc 让出回
// 聊天、二级路由跨切面板保留、x 中断、SGR 点击开卡、名册缺行回落 dashboard。
    ["verify-agents-side-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-agents-side-panel.tsx']],
// 侧栏鼠标契约：PanelBar 标签可点（切换活动面板）且 hover 高亮、⤢ 只对声明
// capabilities.fullscreen 的面板出现并把**活动** id 交给宿主、点聊天列交还焦点。
    ["verify-side-panel-mouse", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-mouse.tsx']],
// 轨迹侧栏迁移回归：TrajectoryPanel 经真实投影渲染唤醒带/账本/检视器——
// 空态、↑/↓ 经分发器移动选中、Tab/→ 切视图、Enter 展开再收起、Esc 恒不消费、
// SGR 真鼠标点行聚焦、visible=false 零写流（visible=true 对照有写）、28/40 列不溢出。
    ["verify-trajectory-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-trajectory-panel.tsx']],
// 信息栏回归：分组键值渲染（模型/思考深度/模式/权限/上下文/缓存/TPS/消耗/工作目录/
// 会话标题与 ID）、无数据回落 ——、长值截断不溢出、窄列可读、visible=false 不订阅。
    ["verify-info-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-info-panel.tsx']],
// 工作目录（工作区）面板回归：账本渲染与当前项高亮、缺失目录标记、长路径不溢出、
// 失败分支、↑/↓ 选择、滚轮、鼠标点行与 hover、visible=false 不重复拉取。
    ["verify-workspace-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-workspace-panel.tsx']],
// 侧栏注册冒烟：内置面板注册齐（单格图标 + capabilities.fullscreen 位）且经真实
// PanelHost 挂载——标签渲染、点 ⓘ 切到信息栏、点 ∿ 切到轨迹空态、⤢ 只在该出现时出现。
    ["verify-side-panel-registry", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-registry.tsx']],
// 鲸娘皮肤回归：GIF→字母格素材包（22 动画/267 帧/30 色调色板，确定性构建）、
// 皮肤注册与 mood/heart/celebrate 落点、缺素材回退、设置切换生效、两包缓存不串色。
    ["verify-whale-girl-skin", ['node', '--import', 'tsx/esm', 'scripts/verify-whale-girl-skin.tsx']],
  ["verify-splash-mascot", ['node', '--import', 'tsx/esm', 'scripts/verify-splash-mascot.tsx']],
// 宠物代言通知路由：companion 为活动面板时新通知走头顶气泡、输入框 toast 不
// 重复（同一提交切换无闪烁）；其他面板 toast 照旧；error 色恒 toast。
    ["verify-companion-toast-routing", ['node', '--import', 'tsx/esm', 'scripts/verify-companion-toast-routing.tsx']],
// todo 侧栏折叠回归：TodoPanelAdapter 传 onToggle/collapsed——真 SGR 点头部折叠/
// 展开、Enter/空格切换、整屏 variant='default' 行为零变化对照；含 ink 500ms 双击
// 窗口的探针坑（第二次同点位点击前 sleep>500ms）。
    ["verify-todo-side-panel", ['node', '--import', 'tsx/esm', 'scripts/verify-todo-side-panel.tsx']],
// 侧栏滚动绘制回归：窄于屏幕的 ScrollBox 滚动不再用满宽 DECSTBM 快路径——分界栏
// 逐行 │/├ 完好、对侧列逐字节稳定（滚轮 64/65 与 ↑/↓ 双驱动、双向互证）。
    ["verify-side-panel-scroll-paint", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-scroll-paint.tsx']],
// 侧栏选择围栏（方向感知）：面板内起拖可选可复制面板文字（逐行列钳制不跨
// 聊天列）；聊天起拖维持 §4.6 不捕面板字符。真 SGR press/motion/release 驱动。
    ["verify-side-panel-selection", ['node', '--import', 'tsx/esm', 'scripts/verify-side-panel-selection.tsx']],
// 连续任务卡成组（JobGroupRow/JobGroupHeader）：组头汇总、组内取消空行与
// 链式连接线、落定整组折叠、点击/悬停/Ctrl+O 展开、失败数留在折叠行、
// 非相邻不成组、单卡原样，以及 jobGroupFold=auto/always/never 三档行为。
    ["verify-jobs-transcript-group", ['node', '--import', 'tsx/esm', 'scripts/verify-jobs-transcript-group.tsx']],
// #185 自愈守卫：React nested-update overflow（Minified error #185）抛出时
// reconciler 已清零计数器，守卫在 clock.tick / reveal.tick / scrollbox.notify /
// channel.emit(+emitStream) / selection.notify 等高频 enqueue 热点吸收该类
// 错误——丢一拍而非进程死亡；单元（分类/透传/限流）+ 热点集成 + 渲染零干扰。
    ["verify-update-overflow-guard", ['node', '--import', 'tsx/esm', 'scripts/verify-update-overflow-guard.tsx']],
// /tree 与 /fork 回归：sessionTree 纯模型（条目提取、回退/分叉边界、
// 家族拼接、扁平化/过滤、整轮丢弃预警）、compat 预算读取器
// （全量/截断/继承前缀跳过）、SessionTree 屏幕无头组装
// （渲染、Enter 菜单、字母直达执行、Esc）。
    ["verify-session-tree", ['node', '--import', 'tsx/esm', 'scripts/verify-session-tree.tsx']],
// 压缩 × 会话切换生命周期：压缩进行中 /model、/resume、/rewind 等必须先
// abort 并等压缩落定再 fork 快照（后台提交 checkpoint = "压缩失败后换模型
// 丢上下文"事故根因）；persistence 类失败与通用失败分开提示。
    ["verify-compact-switch", ['node', '--import', 'tsx/esm', 'scripts/verify-compact-switch.tsx']],
    ["verify-live-session", ['node', '--import', 'tsx/esm', 'scripts/verify-live-session.ts']],
// 血缘 × 自动标题回归：/model 在还没有人说过话的会话上不得写 parentSession
// （上游 first-prompt 标题 provider 只为无 parent 的会话生成标题，fork 永不
// 重试）；已有对话的源仍必须保留分支血缘，既有 /model 语义不得被削掉。
    ["verify-session-title-lineage", ['node', '--import', 'tsx/esm', 'scripts/verify-session-title-lineage.ts']],
    ["verify-session-v3", ['node', '--import', 'tsx/esm', 'scripts/verify-session-v3.ts']],
    ["verify-session-tree-generations", ['node', '--import', 'tsx/esm', 'scripts/verify-session-tree-generations.ts']],
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
// 真实命令注册事件 + 虚拟时钟：完整技能缓存、不完整观测保留 handler、
// 有界退避、恢复、异步代际与释放后不再排程。
    ["verify-skill-catalog-recovery", ['node', 'scripts/verify-skill-catalog-recovery.mjs']],
// 轨迹投影回归（issue #80 演进）：增量折叠与全量折叠在每个切分点终态
// 等价（机械 oracle）、六类括号配对、增广事件守卫的全变异模糊测试、
// 未知事件前向兼容、连发折叠边界、无 chunk 的步不伪造 TTFT。
    ["verify-trace-projection", ['node', 'scripts/verify-trace-projection.mjs']],
// effort 配置链路回归（issue #51）：cordis 配置的 effort 必须进入实际
// 请求配置，而不是只做状态栏启动显示（≤0.3.5 的 display-only 行为）。
    ["repro-effort", ['node', '--import', 'tsx/esm', 'scripts/repro-effort.tsx']],
// effort 默认档纯函数矩阵（src/effortPrefs.ts）：resolveEffortDefault 优先级
// 链、effort.json best-effort 语义（缺文件/坏 JSON/结构不符）、
// nearestLowerEffort 的只降不升边界（未知档 id 双向不参与、空候选）。
// repro-effort 钉请求级行为，这条钉纯函数输入域，二者互补。
    ["verify-effort-default", ['node', '--import', 'tsx/esm', 'scripts/verify-effort-default.ts']],
// 子代理模型路由回归（issue #191）：child scope 没有 AgentOptions 路由时，
// 首次请求继承 TUI 当前完整路由；显式 child 路由保持优先。
    ["verify-subagent-model-route", ['node', '--import', 'tsx/esm', 'scripts/verify-subagent-model-route.tsx']],
// 子代理面板同步回归（issue #966）：catalog/workflow 持久发现、重派 runId
// 分代（含上一 epoch 迟到 end 不得错杀）、resume 日志 bootstrap（历史行
// 不进转录）、会话绑定延迟愈合与 peer 会话不污染。
    ["verify-subagent-panel-sync", ['node', '--import', 'tsx/esm', 'scripts/verify-subagent-panel-sync.tsx']],
// 子进程 stderr 接管回归（issue #17）：inherit 的 MCP 子进程 stderr
// 不再裸写终端破坏 alt-screen，输出去重聚合为受控通知。
    ["verify-child-stderr", ['node', '--import', 'tsx/esm', 'scripts/verify-child-stderr.tsx']],
// 模型路由原子解析回归（issue #67）：完整 config > pref > default 整对
// 生效，provider-only pin 不得与另一半拼接出错配路由。
    ["verify-model-route", ['node', 'scripts/verify-model-route.mjs']],
// /balance 余额查询与状态栏花费估算回归：fetchBalance 响应解析与失败
// 分类（401/HTTP/网络/非法/空 key/超时/baseUrl）、官方单价表最长前缀
// 匹配、北京时间高峰/空闲时段边界、缓存命中计价、未知模型与零 token
// 不估算、官方 provider 判定。注入 fake fetch，不发真实请求。
    ["verify-balance", ['node', '--import', 'tsx/esm', 'scripts/verify-balance.tsx']],
// 本会话费用估算回归（#1089）：主会话按模型分桶 + 子代理按各自 (provider, model)、峰值/空闲、缓存分项合并计价，非官方/未收录只报 token 并标注未计价。
    ["verify-session-cost", ['node', '--import', 'tsx/esm', 'scripts/verify-session-cost.tsx']],
// /model 二级选择器派生回归：provider 分组（首现排序、显示名回退、
// 计数）与落焦规则（多 provider 聚焦当前组、单 provider 直达模型层、
// 缺席当前 provider 落首行）。键盘与 overlay 归约由 verify-chat-overlay
// 覆盖，这里钉住两层共用的纯派生。
    ["verify-model-picker-groups", ['node', 'scripts/verify-model-picker-groups.mjs']],
// 全屏出厂默认迁移回归（0.9.x schema + cordis.patch.yml false→true 翻转）：
// 翻转前钉在 settings 用户层的显式 false 首启被 unset 一次（marker 仅在
// 写入成功后落盘，失败下次自愈重试），此后再写的 false 是用户主动选择
// 永不触碰；首启 apply 收到的值必须整键缺省而非 false。
    ["verify-fullscreen-migration", ['node', 'scripts/verify-fullscreen-migration.mjs']],
// CJK 显示宽度截断回归（issue #41）：4 处描述按终端显示宽度处理，
// CJK 不劈字、窄终端布局不破。
    ["verify-cjk-truncate", ['node', '--import', 'tsx/esm', 'scripts/verify-cjk-truncate.tsx']],
// 启动上下文摘要窄终端回归（issue #167）：摘要与 Ctrl+T 提示必须
// 作为一条可截断文本布局，不能换行后互相穿插。
    ["verify-loaded-context-width", ['node', '--import', 'tsx/esm', 'scripts/verify-loaded-context-width.tsx']],
// Divider 可用宽度回归：横线按 Yoga 实际授予的宽度渲染（测量撑满
// Box），嵌套在更窄容器里（transcript 旁 2 列 timeline rail 排水沟）
// 不再按整终端宽度换行到第二行——「Session summary is ready」窄窗劈裂。
    ["verify-divider-width", ['node', '--import', 'tsx/esm', 'scripts/verify-divider-width.tsx']],
// Divider 测量循环回归（React #185 启动即崩）：横线宽度会反馈进 Box 的
// 实际授予宽度，内容定宽上下文（或同模式测量的兄弟元素）里测量值漂移
// 不收敛，每 commit 一次 setState 撞 reconciler 50 层嵌套更新上限直接
// 崩进程。钉住测量协商逐代有界 + resize 后重新开协商。
    ["verify-divider-stability", ['node', '--import', 'tsx/esm', 'scripts/verify-divider-stability.tsx']],
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
// 运行时主题插件接缝回归：Cordis activation 归属与自动清理、host-only
// facade、静态主题优先级、resolver token 清理及无服务降级。
    ["verify-runtime-themes", ['node', '--import', 'tsx/esm', 'scripts/verify-runtime-themes.ts']],
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
// 上下文进度条右对齐回归（#922）：页脚根 Box paddingX={1} ⇒ 内容区实宽
// columns - 2，bar 也必须按 columns - 2 取宽——右端与状态行右缘逐格比对。
    ["verify-context-bar-alignment", ['node', '--import', 'tsx/esm', 'scripts/verify-context-bar-alignment.tsx']],
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
// hideCustomInput 逐题标记；模型列表编辑的双通道发现（内置目录 + 无
// provider 字段的端点实拉）合并、线上新增标记、目录外 id 容量写入、
// 实拉失败降级与匿名探测请求形状。
    ["verify-provider-wizard", ['node', 'scripts/verify-provider-wizard.mjs']],
// /login 凭据状态回归（issue #213）：只通过 credentials.describe()
// 展示 configured/source/writable，managed key 不得误报或泄露值。
    ["verify-login-credentials", ['node', '--import', 'tsx/esm', 'scripts/verify-login-credentials.tsx']],
// 提问面板 hideCustomInput 行为回归：纯选择题隐藏输入行且 Tab/打字
// 不劫持焦点，纯文本题忽略 hide 标记，多选题默认行为不回退。
    ["verify-askpanel-hide-custom-input", ['node', '--import', 'tsx/esm', 'scripts/verify-askpanel-hide-custom-input.tsx']],
// 问卷面板粘贴回归：bracketed paste 压平插入（纯换行块不得提交、ANSI/
// OSC 剥净）、Ctrl+V/Alt+V 异步剪贴板插入到实时光标（读期间打字真竞态
// 臂、busy 去重）、选项行粘贴追加+附加标签、plan-review 粘贴绝不快选/
// 批准、隐藏输入题粘贴惰性、超长粘贴上限报错、同 chunk 批量按键经同步
// ref 依序编辑、emoji 码点步进。
    ["verify-question-paste", ['node', '--import', 'tsx/esm', 'scripts/verify-question-paste.tsx']],
// 问卷折叠：真实 Chat + stores 验证审批/对话框优先、整屏中断层恢复、
// abort 后 FIFO 请求身份隔离，以及改键和草稿保持（inline/fullscreen）。
    ["verify-question-fold", ['node', '--import', 'tsx/esm', 'scripts/verify-question-fold.tsx']],
// 长问卷列表回归：24 行终端中的 36 个两行 provider 选项必须围绕
// focusIndex 窗口化，初始和深度导航后焦点 label/单选标记始终可见。
    ["verify-askpanel-long-list", ['node', '--import', 'tsx/esm', 'scripts/verify-askpanel-long-list.tsx']],
// 问卷作答记录的真源投影回归（issue #1009）：ask_user_question 不渲染工具卡，
// 它的 tool/result 必须自己折叠出作答记录——实时一条、重放（/resume、rewind、
// 模型切换）同一条、同 callId 不重复、错误结果渲染日志里的错误文本（ASK_CANCELLED/
// ASK_ABORTED 不得伪造答案）、redact 仍只在本地向导打码、不可解析的载荷退化成
// 只有标题而不抛异常中断投影。修复前记录只由面板「开→关」那一跳 pushLocal 推送，
// 重放后必丢。
    ["verify-question-transcript-record", ['node', '--import', 'tsx/esm', 'scripts/verify-question-transcript-record.tsx']],
// 长 plan-review 正文回归（issue #413）：24 行终端里 40 段 plan 不得把
// Approve/反馈顶出屏外；滚轮必须滚 plan body（直接面板 + 挂进 Chat）。
    ["verify-plan-review-scroll", ['node', '--import', 'tsx/esm', 'scripts/verify-plan-review-scroll.tsx']],
// 插件场景渲染崩溃边界：Thrower 场景必须被 PluginSceneBoundary 接住——
// onError 精确一次、崩溃场景停止绘制、进程存活；健康场景不受影响。
    ["verify-plugin-scene-boundary", ['node', '--import', 'tsx/esm', 'scripts/verify-plugin-scene-boundary.tsx']],
// ctx.tuiPanels 全链（§18 Phase 6）：准入/前缀 id/预算/重复 id ledger/
// open 限速/跨插件所有权/订阅过滤/崩溃禁用/释放撤下 + 无头渲染冒烟
// （插件面板抛错出错误卡、3 次崩溃出禁用卡、Chat 侧不受影响）。
    ["verify-plugin-panels", ['node', '--import', 'tsx/esm', 'scripts/verify-plugin-panels.tsx']],
// 终端点击目标回归（点击链接开浏览器 / 文件路径弹菜单）：路径判定、
// dsh-file: URL 编解码、相对路径按 cwd 解析、file:// 转换、Windows
// start 组装——fileTarget.ts / openExternal.ts 的纯函数部分。
    ["verify-clickable-targets", ['node', '--import', 'tsx/esm', 'scripts/verify-clickable-targets.ts']],
// 会话标识回归（issue #372）：/color 会话强调色（setSessionColor 调用 +
// 边框 cell 级颜色重绘 + reset 恢复）、会话名标签渲染在输入框顶边框、
// /recap 面板（摘要 + 建议标题 + a 键一键应用标题走 renameSession）。
    ["verify-session-color-recap", ['node', '--import', 'tsx/esm', 'scripts/verify-session-color-recap.tsx']],
// 打开会话自动总结回归（recapOnOpen）：挂载自动触发恰一次、灰行渲染、
// hover 提示与关闭 chip、点击展开完整面板、a 应用标题、Esc 收起、
// × 关闭、会话切换重新触发、失败静默、设置关闭不再触发。
    ["verify-auto-recap", ['node', '--import', 'tsx/esm', 'scripts/verify-auto-recap.tsx']],
// @ 引用行区间回归（issue #359）：`#L12-14` 后缀按 1-based 闭区间切片
// 附加、endLine 越界 clamp 到文件尾、startLine 越界回退整文件并在块内
// 注明、剥后路径未命中时回退字面路径（真叫 `…#L…` 的文件按整文件附加
// 且模型看到字面路径）、双 miss 报用户原文、无后缀行为不变、目录忽略
// 后缀。内存 fs stub，expandMentions 纯扩展逻辑。
    ["verify-mention-lines", ['node', '--import', 'tsx/esm', 'scripts/verify-mention-lines.ts']],
// 问卷 provider 抢注守卫回归（issue #98 安全收尾）：静默让位只授予宿主
// 可验证的白名单在位者（本 TUI 的私有 symbol 标记）；在位者【自报】的
// 白名单名（name/hostId/id 字段可被任意插件拷贝伪造）走 alert-unverified
// 诚实告知；第三方在位或无身份信息走保守告警。判定为纯函数 + 真实
// UserQuestionService 端到端。
    ["verify-question-provider-guard", ['node', '--import', 'tsx/esm', 'scripts/verify-question-provider-guard.tsx']],
// secret.ref 保留名单守卫回归：第三方设置区块的 DEEPSEEK_API_KEY /
// DEEPSEEK_、DSH_ 前缀 ref 在注册层被摘除（其余字段照常）、宿主身份
// 放行、channel.settingsHost().writeCredential 对保留 ref 抛 i18n 文案
// ——防"给插件配 key"假象下覆盖主凭据。
    ["verify-secret-ref-guard", ['node', '--import', 'tsx/esm', 'scripts/verify-secret-ref-guard.tsx']],
// 审批面板外部来源徽标回归：无 callId / 配对不到 tool/call / call 已有
// tool/result（重放真实命令文本）的审批请求在面板数据带 external 标记
// 并醒目渲染 [external] 提示；活跃（未落定）调用不带标记、命令照常恢复。
// P-4 复查窗口：同 callId 的第二条（伪造孪生）入队时判 live，第一条被
// 允许、tool/result 落定后孪生弹出/渲染时徽标必须补上（弹出时 + 读取
// 当前条时重跑活跃判定）。
    ["verify-approval-source-badge", ['node', '--import', 'tsx/esm', 'scripts/verify-approval-source-badge.tsx']],
// 单行超长文本折叠回归（用户反馈：单行超长文本默认整行渲染，铺成上千视觉
// 行拖慢转录）：折叠阈值常量 1000 字符、行边界不被改写、短文本零分配快路径；
// 真实 MessageList 下 user 消息 / assistant 正文 / 工具卡标题（单行超长命令）
// 与正文都出折叠标记且裁掉的尾巴不在屏上；Ctrl+O 逃生门恢复原文；
// reasoning 行不折叠（自带三行预览）。
    ["verify-long-line-fold", ['node', '--import', 'tsx/esm', 'scripts/verify-long-line-fold.tsx']],
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
const wholeGroup = GROUPS[groupName]
if (!wholeGroup) {
  console.error('[run-ci-group] 未知组名: ' + groupName)
  console.error('可用组: ' + Object.keys(GROUPS).join(', '))
  process.exit(2)
}

/** 解析 --shard i/n（缺省 1/1）、--list 与 --record-timings。参数非法一律 exit 2，不能静默跑整组。 */
const flags = process.argv.slice(3)
let shard = { index: 1, count: 1 }
let listOnly = false
let recordTimings = false
let jobs = 1
for (let i = 0; i < flags.length; i++) {
  const flag = flags[i]
  if (flag === '--list') { listOnly = true; continue }
  if (flag === '--record-timings') { recordTimings = true; continue }
  const jobValue = flag === '--jobs' ? flags[++i] : flag.startsWith('--jobs=') ? flag.slice('--jobs='.length) : undefined
  if (jobValue !== undefined) {
    if (!/^[1-9]\d*$/.test(jobValue)) {
      console.error('[run-ci-group] --jobs 须为正整数，收到: ' + String(jobValue))
      process.exit(2)
    }
    jobs = Number(jobValue)
    continue
  }
  const value = flag === '--shard' ? flags[++i] : flag.startsWith('--shard=') ? flag.slice('--shard='.length) : undefined
  const m = value === undefined ? null : /^([1-9]\d*)\/([1-9]\d*)$/.exec(value)
  if (flag !== '--shard' && !flag.startsWith('--shard=')) {
    console.error('[run-ci-group] 未知参数: ' + flag)
    process.exit(2)
  }
  if (!m || Number(m[1]) > Number(m[2])) {
    console.error('[run-ci-group] --shard 须为 i/n 且 1 ≤ i ≤ n，收到: ' + String(value))
    process.exit(2)
  }
  shard = { index: Number(m[1]), count: Number(m[2]) }
}
if (jobs > 1 && recordTimings) {
  console.error('[run-ci-group] --jobs > 1 与 --record-timings 互斥：并发耗时失真，会污染 ci-group-timings.json 装箱表')
  process.exit(2)
}
const TIMINGS_FILE = new URL('./ci-group-timings.json', import.meta.url)
const timings = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'))
const measured = timings[groupName] ?? {}
const known = wholeGroup.map(([name]) => measured[name]).filter(s => typeof s === 'number' && s > 0).sort((a, b) => a - b)
const fallbackSeconds = known.length > 0 ? known[Math.floor(known.length / 2)] : 1
const estimate = name => typeof measured[name] === 'number' && measured[name] > 0 ? measured[name] : fallbackSeconds

// 最长处理时间优先装箱：同耗时按登记顺序，同负载取编号小的片——同一份输入
// 在每个 matrix job 里算出同一个划分。
const owner = new Array(wholeGroup.length)
const loads = new Array(shard.count).fill(0)
for (const i of wholeGroup.map((_, i) => i).sort((a, b) => estimate(wholeGroup[b][0]) - estimate(wholeGroup[a][0]) || a - b)) {
  let lightest = 0
  for (let s = 1; s < shard.count; s++) if (loads[s] < loads[lightest]) lightest = s
  owner[i] = lightest
  loads[lightest] += estimate(wholeGroup[i][0])
}
if (owner.some(s => !(s >= 0 && s < shard.count))) {
  console.error('[run-ci-group] 分片划分内部错误：有条目未分配到任何片')
  process.exit(2)
}
const group = wholeGroup.filter((_, i) => owner[i] === shard.index - 1)
const label = shard.count === 1 ? groupName : groupName + ' ' + shard.index + '/' + shard.count
// 分片数超过组内条目数时后面的片是空的：exit 0 会报"全部 0 项通过"，ci.yml 里
// 一个写错的 matrix 就能让整片静默变绿。空片判配置错误，与非法参数同级。
if (group.length === 0) {
  console.error('[run-ci-group] ' + label + ' 没有任何条目（组内共 ' + wholeGroup.length + ' 项）——分片数超过条目数')
  process.exit(2)
}

if (listOnly) {
  console.log(label + '（' + group.length + '/' + wholeGroup.length + ' 项，预计 ' + loads[shard.index - 1].toFixed(0) + 's；各片 '
    + loads.map(s => s.toFixed(0) + 's').join(' / ') + '）')
  for (const [name] of group) console.log('  ' + name + '  ~' + estimate(name).toFixed(1) + 's' + (name in measured ? '' : '（无实测，按中位数）'))
  process.exit(0)
}

const RENDER_LOG_DIR = 'ci-render-logs'
mkdirSync(RENDER_LOG_DIR, { recursive: true })

console.log('::group::' + label + '（' + group.length + ' 项，失败不中断' + (jobs > 1 ? '，--jobs ' + jobs : '') + '）')
const results = []

// One throwaway HOME per script: fixtures used to share the machine's real
// home, so a script that submits text left entries in
// `~/.dsh-tui/history.jsonl` for whatever ran next — and `↑` walks that file
// (#986), which turned one script's leftovers into the next script's
// assertion failure. A local group run must also never write the runner's
// own history. `HOME`/`USERPROFILE` sit after `env` (which carries the real
// ones) so the real home can never win; an entry may still override them
// through its own `extraEnv`.
const entryEnv = (extraEnv, renderLog, scriptHome) => ({
  DSH_TUI_RENDER_LOG: renderLog,
  ...env,
  HOME: scriptHome,
  USERPROFILE: scriptHome,
  ...(extraEnv ?? {}),
})

const reportFailure = (name, status, renderLog) => {
  console.log('::error title=' + label + '::测试 ' + name + ' 失败（exit ' + status + '）——已记录，继续跑同组其余测试')
  let bytes = 0
  try { bytes = statSync(renderLog).size } catch { /* 脚本没画帧（纯逻辑测试）：无日志可留 */ }
  if (bytes > 0) console.log('[run-ci-group] 帧日志已保留: ' + renderLog + '（' + bytes + ' 字节）')
}

if (jobs === 1) {
  for (const entry of group) {
    const [name, argv, extraEnv] = entry
    console.log('\n===== ' + name + ' =====')
    const renderLog = join(RENDER_LOG_DIR, name + '.log')
    rmSync(renderLog, { force: true })
    const scriptHome = mkdtempSync(join(tmpdir(), 'dsh-tui-group-home-'))
    const startedAt = performance.now()
    const r = spawnSync(argv[0], argv.slice(1), {
      env: entryEnv(extraEnv, renderLog, scriptHome),
      stdio: 'inherit',
      shell: false,
    })
    rmSync(scriptHome, { recursive: true, force: true })
    const seconds = (performance.now() - startedAt) / 1000
    const failed = r.status !== 0
    results.push({ name, failed, status: r.status, seconds })
    if (failed) reportFailure(name, r.status, renderLog)
    else rmSync(renderLog, { force: true })
  }
} else {
  // 并发路径：输出按条缓冲、完成后整段透传（前缀仍是 ===== name =====，日志
  // 可按条归因）；每条独立 HOME/渲染日志与串行完全一致。失败条目随后串行
  // 复跑一次分家「CPU 竞争假红」与真失败——两种结果都落盘，不静默放行。
  const pending = group.slice()
  const runOne = entry => new Promise(resolve => {
    const [name, argv, extraEnv] = entry
    const renderLog = join(RENDER_LOG_DIR, name + '.log')
    rmSync(renderLog, { force: true })
    const scriptHome = mkdtempSync(join(tmpdir(), 'dsh-tui-group-home-'))
    const startedAt = performance.now()
    const child = spawn(argv[0], argv.slice(1), {
      env: entryEnv(extraEnv, renderLog, scriptHome),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    const chunks = []
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => chunks.push(chunk))
    const settle = status => {
      rmSync(scriptHome, { recursive: true, force: true })
      resolve({ name, argv, extraEnv, renderLog, failed: status !== 0, status, seconds: (performance.now() - startedAt) / 1000, output: Buffer.concat(chunks) })
    }
    child.on('error', error => settle('spawn:' + (error.code ?? 'error')))
    child.on('close', status => settle(status))
  })
  const worker = async () => {
    for (;;) {
      const entry = pending.shift()
      if (entry === undefined) return
      const r = await runOne(entry)
      process.stdout.write('\n===== ' + r.name + ' =====\n')
      process.stdout.write(r.output)
      if (r.failed) reportFailure(r.name, r.status, r.renderLog)
      else rmSync(r.renderLog, { force: true })
      results.push(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, group.length) }, worker))
  for (const r of results.filter(item => item.failed)) {
    console.log('\n[run-ci-group] ' + r.name + ' 并行失败（exit ' + r.status + '），串行复跑一次：分家 CPU 竞争假红与真失败')
    const renderLog = join(RENDER_LOG_DIR, r.name + '.log')
    rmSync(renderLog, { force: true })
    const scriptHome = mkdtempSync(join(tmpdir(), 'dsh-tui-group-home-'))
    const startedAt = performance.now()
    const again = spawnSync(r.argv[0], r.argv.slice(1), {
      env: entryEnv(r.extraEnv, renderLog, scriptHome),
      stdio: 'inherit',
      shell: false,
    })
    rmSync(scriptHome, { recursive: true, force: true })
    r.seconds += (performance.now() - startedAt) / 1000
    if (again.status === 0) {
      r.failed = false
      r.status = 0
      r.flake = true
      rmSync(renderLog, { force: true })
      console.log('::error title=' + label + '::测试 ' + r.name + ' 并行红、串行复跑绿——按 CPU 竞争假红放行，已显式记录')
    } else {
      r.status = again.status
      reportFailure(r.name, again.status, renderLog)
    }
  }
}
console.log('::endgroup::')

const fmt = seconds => seconds.toFixed(1) + 's'
const total = results.reduce((sum, r) => sum + r.seconds, 0)
console.log('\n' + label + ' 汇总（共 ' + fmt(total) + '）：')
for (const { name, failed, status, seconds, flake } of results) {
  console.log('  ' + (failed ? '✗' : '✓') + ' ' + name + '  ' + fmt(seconds) + (failed ? '（exit ' + status + '）' : flake ? '（并行红，串行复跑绿）' : ''))
}
const flakeList = results.filter(r => r.flake)
if (flakeList.length > 0) {
  console.log('\n[run-ci-group] ' + flakeList.length + ' 项在 --jobs ' + jobs + ' 下并行红、串行复跑绿（CPU 竞争假红，已记录不静默）：' + flakeList.map(r => r.name).join(', '))
}

// GitHub Actions step summary：按耗时降序，给分片/拆组提供数据。
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = [...results].sort((a, b) => b.seconds - a.seconds)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '### ' + label + '：' + results.length + ' 项，共 ' + fmt(total),
    '',
    '| 结果 | 测试 | 耗时 |',
    '| --- | --- | ---: |',
    ...rows.map(r => '| ' + (r.failed ? '✗ exit ' + r.status : r.flake ? '✓ ⚑并行红串行绿' : '✓') + ' | ' + r.name + ' | ' + fmt(r.seconds) + ' |'),
    '',
  ].join('\n'))
}

if (recordTimings) {
  const next = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'))
  const entries = { ...(next[groupName] ?? {}) }
  for (const r of results) if (!r.failed) entries[r.name] = Math.round(r.seconds * 10) / 10
  // 只保留仍登记在组里的条目，按名字排序，diff 可读。
  const names = new Set(wholeGroup.map(([name]) => name))
  next[groupName] = Object.fromEntries(Object.keys(entries).filter(n => names.has(n)).sort().map(n => [n, entries[n]]))
  writeFileSync(TIMINGS_FILE, JSON.stringify(next, null, 2) + '\n')
  console.log('[run-ci-group] 已写回 ' + groupName + ' 的实测耗时（' + results.filter(r => !r.failed).length + ' 项）')
}

const failedList = results.filter(r => r.failed)
if (failedList.length > 0) {
  console.error('\n' + label + '：' + failedList.length + '/' + results.length + ' 项失败——' + failedList.map(f => f.name).join(', '))
  process.exit(1)
}
console.log('\n' + label + '：全部 ' + results.length + ' 项通过')
