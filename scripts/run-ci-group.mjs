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
 * 组定义在下方 GROUPS 表：名称 + 完整 argv + 可选附加 env。新增测试时在
 * 此表登记——每条的注释即原 ci.yml 里该 step 上方的说明（迁移时保留）。
 *
 * 本分支（pi-tui 渲染器）与 main 的组表差异：main 各组里的 Ink 时代
 * .tsx 渲染探针（repro-* / verify-*  headless xterm 系列）已随旧渲染器
 * 退役，不登记；render-scroll 组改为承载 pi-tui 渲染器与 TUI 集成测试。
 * 只登记仓库里实际存在的脚本。
 *
 * 行为：
 *   - 逐条运行，实时透传 stdout/stderr（日志仍是每条测试的原始输出）；
 *   - 失败不中断，记录后继续；
 *   - 结束时汇总 ✓/✗ 清单，任一失败 exit 1 并给失败条目打 ::error。
 */
import { spawnSync } from 'node:child_process'

const env = { ...process.env }

const GROUPS = {
  // pi-tui 渲染器与 TUI 集成测试（pi-tui 架构下取代 main 的 Ink 渲染探针组）。
  // 四项都是 package.json 脚本，经 pnpm 调用保持单一事实源。
  'render-scroll': [
// vendored pi-tui 渲染器包自身测试（packages/pi-tui，zero-diff fork 的
// 守卫套件；见 packages/pi-tui/AGENTS.md 的 Guard command）。
    ["pi-tui-test", ['pnpm', '--filter', '@deepseek-harness-tui/pi-tui', 'test']],
// TUI 集成测试（test/tui/）：新渲染器生命周期、root/input、channel
// 会话树/竞争、session-browser、设置面板等，node --test 裸跑。
    ["test-tui", ['pnpm', 'test:tui']],
// vendored fork 边界回归：pin 的上游 commit/版本记录、核心文件清单、
// src/tui 只经 public 口依赖渲染器。
    ["verify-tui-boundary", ['pnpm', 'verify:tui-boundary']],
// 入口 smoke：公共 Terminal 假件驱动 ChatScreen 全生命周期。
    ["smoke", ['pnpm', 'smoke']],
  ],
  'input-terminal': [
// Exit funnel and resume-marker decisions are pure lifecycle gates.
    ["verify-exit-resume-marker", ['node', '--import', 'tsx/esm', 'scripts/verify-exit-resume-marker.tsx']],
    ["verify-teardown-exit", ['node', '--import', 'tsx/esm', 'scripts/verify-teardown-exit.tsx']],
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
// 图片附件回归：剪贴板位图占位符与图片文件 @ 引用进附件库（#152）。
    ["verify-clipboard-image", ['node', '--import', 'tsx/esm', 'scripts/verify-clipboard-image.ts']],
// 换名迁移回归（issue #120）：~/.dsh-cc → ~/.dsh-tui 首启复制迁移、
// resume.txt 双写契约、旧 env 名检测（DSH_CC_RESUME_SESSION 双读不算废弃）。
    ["verify-legacy-rename", ['node', 'scripts/verify-legacy-rename.mjs']],
  ],
  'session-workspace': [
// 审批服务配置回归（issue #49 尾巴）：裸组合 cordis.yml 必须挂载
// approval 行；裸组合与 profile patch 的 policy 表达式逐场景同值
//（ask / never / win32 never），两个入口语义不漂移。
    ["verify-cordis-approval", ['node', 'scripts/verify-cordis-approval.mjs']],
// 工作状态由基础事件在进程内派生：阶段、500ms tick、Agent 切换重置。
    ["verify-working-activity", ['node', 'scripts/verify-working-activity.mjs']],
// TUI 创建及恢复的会话必须持久关联到 Workspace。
    ["verify-workspace-attachment", ['node', 'scripts/verify-workspace-attachment.mjs']],
// tuiWorkspaces 服务可选化回归（issue #183）：代码层 inject 不含
// tuiWorkspaces、消费处带本地兜底、patch 保留服务行与行级顺序保证。
    ["verify-workspaces-degrade", ['node', 'scripts/verify-workspaces-degrade.mjs']],
// 会话标题回归：选择器标题宽容读取（带未标记第三方事件的日志
// 不能让标题退化成目录名），/rename 的最后一条 session/title 优先。
    ["verify-session-titles", ['node', 'scripts/verify-session-titles.mjs']],
// resume 遗留事件注册回归（issue #153）：真实存储栈 e2e——注册前
// load() 抛 SessionFormatUnsupportedError（原样复现 issue）、注册后
// 放行；日志字节与 0600 权限绝不被改写；非白名单未知类型保持拒读
//（上游 fail-closed 新格式保护不破）。
    ["verify-resume-legacy-events", ['node', 'scripts/verify-resume-legacy-events.mjs']],
// 会话 cwd 回归（issue #96）：启动目录向上解析 git 仓库根（普通克隆
// 与 .git 文件 worktree 均覆盖、dotfiles ~/.git 守卫），/resume 过滤
// 双向兼容升级前记录的子目录会话，$HOME/盘符根容器目录只精确匹配
//（issue #153），Windows 分隔符与大小写语义。
    ["verify-session-cwd", ['node', 'scripts/verify-session-cwd.mjs']],
// 文件补全回归（issue #278）：CMake 构建目录与任意大型兄弟目录不得
// 独占 100 条全局预算，普通深层源码也不能被固定深度静默截断。
    ["verify-file-completion", ['node', 'scripts/verify-file-completion.mjs']],
// /resume 会话管理回归（issue #112）：picker 重命名追加帧（seq 连续、
// 已有字节不动、last-title-wins）、删除目录、路径穿越 id 拒绝。
    ["verify-resume-manage", ['node', 'scripts/verify-resume-manage.mjs']],
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
  ],
  'channel-ui': [
// channel 层回归：发送链（submit/steer/撤回/打断重投）、compact 折叠、
// goal/todo 事件回放。曾因不在 CI 而随接口演进静默失效（0.3.6 的
// installModelSelection、#34 的投递异步化都没被它们拦下），挂进来
// 防再腐烂。
    ["verify-submit", ['node', '--import', 'tsx/esm', 'scripts/verify-submit.mjs']],
    ["verify-compact", ['node', 'scripts/verify-compact.mjs']],
    ["verify-channel-goal-todo", ['node', '--import', 'tsx/esm', 'scripts/verify-channel-goal-todo.mjs']],
// 裸 ● 空行回归：纯思考/纯工具步骤（无文本块）的 assistant/message
// 不得创建空 assistant 行，否则思考块折叠后转录里多出一个只有
// ● 前缀、内容为空的行。
    ["verify-empty-assistant-row", ['node', 'scripts/verify-empty-assistant-row.mjs']],
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
// 外部编辑器回归（issue #123）：Ctrl+G 的 $VISUAL/$EDITOR 解析
// （引号拆分、优先级、未配置时 unavailable——无 vi 兜底）与临时文件
// 往返（edited/unchanged/非零退出/启动失败）。假编辑器进程，无需 TTY。
    ["verify-external-editor", ['node', 'scripts/verify-external-editor.mjs']],
// 主题解析回归：内置主题完整性、parseCustomTheme 拒绝畸形/不安全项、
// displayName 内嵌换行入口压平（#160 窗口化列表单行契约的第一道防
// 线）。注意必须走 tsx——脚本直接 import src/customTheme.ts。
    ["verify-themes", ['node', '--import', 'tsx/esm', 'scripts/verify-themes.mjs']],
// /provider 向导回归：catalog/custom 两分支的 profile 形状、凭据回滚
// （覆盖时恢复旧 key 而非误删）、env shadow 跳过、rc.6 兼容守卫、
// hideCustomInput 逐题标记。
    ["verify-provider-wizard", ['node', 'scripts/verify-provider-wizard.mjs']],
// resume 模型路由回填回归：session 记录的 request/header 路由必须能被
// resolvePersistedRoute 读回并喂给 agents.resume——provider-only 的
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
