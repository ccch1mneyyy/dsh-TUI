# 插件生命周期与装配

本文描述 dsh-cc-tui 作为 Cordis 插件从配置组合到进程退出的完整装配过程：
组合层构成、apply 启动序、命令分发、退出漏斗与 teardown 的区分。行号均以
审计基线 b2f4087 为准。

## 插件契约与入口

`src/index.ts` 是标准 Cordis 插件表面（name / inject / Config / apply）：

| 导出 | 位置 | 内容 |
| --- | --- | --- |
| `name = 'cc-tui'` | `src/index.ts:12-13` | 插件名；`inject = ['agents']`，agents 是唯一硬性注入依赖 |
| `Config` 接口 | `src/index.ts:19-62` | sessionId / provider / model / cwd / effort / activity / activityFrames / contextBar / fullscreen / lang / preset |
| `Config` Schema | `src/index.ts:64-80` | `Schema.object({...})`，**schema 上无 route 默认值**——注释明确 "No schema defaults on the route... The defaults live at the end of the fallback chain in modelRoute.ts"（issue #30） |
| `apply` | `src/index.ts:89-92` | 通过动态 `await import('./plugin.js')` 委托 `plugin.ts`，使入口扫描工具与 Loader 解析到纯 .ts 模块 |

Loader 解析 `dsh-cc-tui` 行的入口是 `package.json:7-8` 的 `main: lib/types/index.js`
与 `types: lib/types/index.d.ts`（tsc 产物，见 [overview.md](overview.md) 源码分布）。

## 配置组合层

profile 装配链（npm 包 → profile 组合 → 启动入口）：

```text
dsh plugin --profile cc-tui add dsh-cc-tui   （install.sh:22，初始化 profile、装 dsh-base 首层、pnpm 装包）
  -> CLI 读取 package.json 的 dsh.bundle.patch 元数据（package.json:103-107）
  -> 把 cordis.patch.yml 追加为 bundle 组合层（docs/getting-started.md:62）
  -> 组合层顺序：dsh-base -> 其他 bundle -> dsh-cc-tui patch -> 用户 profile patch -> home patch
     （docs/getting-started.md:64-67；scripts/run.ts:208-215 同序）
  -> dsh --profile cc-tui 启动（install.sh:24），Loader 解析 cc-tui 行 -> lib/types/index.js
```

`scripts/run.ts:183-215` 是 workspace 开发启动路径：按 base → working-activity →
外部插件 → cc-tui → 用户 profile → home patch 顺序 loadOverlayPatches 后
`boot('dsh', rootConfig, allPatches, ...)`（:249），并做 healProfilesModuleFallback、
installFailLoud、`DSH_HOME` 钉为 ~/.dsh-cc（:17-19）、`NODE_ENV=production`（:27，
防 react-reconciler dev 构建 OOM）、堆看护 `DSH_CC_HEAP_WATCH`（:56-81）。该脚本
绕过 profile 目录系统（:5-9），仅用于源码开发。

### cordis.yml（裸组合示例，24 个服务行）

程序化计数（`grep -c '^\- id:'`）= 24：user-questions(9)、cc-tui(12)、
llm-deepseek(33)、subprocess(42)、bash(45)、fs(53)、fs-policy(60)、tool-fs(63)、
tool-todo(69)、subagent(77)、subagent-spawn(80)、subagent-fork(85)、
tool-subagent(90)、tool-subagent-fork(98)、agent-spine(106)、commands(126)、
plan-mode(132)、command-goal(141)、working-activity(153)、sessions(161)、
session-query(167)、session-checkpoints(170)、token-meter(174)、compact(177)。

行间无显式 deps 字段，依赖是服务级。关键装配约束（均来自行内注释）：

| 约束 | 位置 |
| --- | --- |
| user-questions 必须位于根，agent loop 的工具执行才能触达 | `cordis.yml:5-8` |
| 核心 `dsh-subagent` 服务必须在任何 provider 之前挂载 | `cordis.yml:74-77` |
| commands 注册表必须挂在命令之前 | `cordis.yml:123-127` |
| tool-todo 的 allowParallelInProgress 必填（schema 无默认） | `cordis.yml:66-68` |
| plan-mode 段必填且非空，裸挂载会校验失败并回滚整树 | `cordis.yml:131-137` |
| rc.6 schema 键是 `apiKeyEnv` 而非 `apiKey`（旧 snapshot 键被 loader 丢弃） | `cordis.yml:30-32` |

cc-tui 行（`cordis.yml:12-27`）：`provider: deepseek-official` 仅半钉（不构成完整
路由，issue #67，见 [model-route.md](model-route.md)）、`fullscreen: true`（:19，
Alt-screen 全屏）、`effort: max`（:24）、`sessionId: !!js process.env.DSH_CC_RESUME_SESSION ?? undefined`（:27）。

### cordis.patch.yml（profile 覆盖层）

`cordis.patch.yml:6-8` 文件头注释定义补丁语义：**"A patch replaces the targeted
row's whole config"**——补丁整行替换 config，覆盖行必须复述全部键。

- 29 个顶层覆盖：23 个 `disabled: true` + 6 个 config 行（system-prompt:16、
  llm-deepseek:26、agent-loop:36、sandbox-policy:132、approval:139、
  session-persistence-jsonl:147）。
- 1 个 insert 块（:161-217）插入 4 行：agent-presets(170)、cordis-host-runner(178)、
  cc-tui(185)、working-activity(214)。cc-tui 行 `fullscreen: false`（:193，注释
  "默认关闭——inline 模式下由终端原生选择/复制/scrollback 接管"，与裸组合相反，
  见 [unknowns.md](unknowns.md) 的设计性差异）。working-activity 行
  `publishIntervalMs: 500`（:217，默认 2000ms 调至 500 让状态栏计时平滑）。
- agent-loop 行 `agents: []`（:36-38，"no declarative agents are started at
  boot"——TUI 在运行时通过工厂创建/resume agent）。
- `dsh.bundle.patch: "./cordis.patch.yml"`（package.json:103-107）是 CLI 识别
  补丁层的元数据。

### preset 优先级链

`config.preset`（cordis.yml/patch 显式值）> `CC_TUI_PRESET` 环境变量
（`cordis.patch.yml:202` `preset: !!js process.env.CC_TUI_PRESET ?? undefined`）>
持久化 /preset（readPresetPref）> roster 默认 `'standard'`
（`cordis.patch.yml:173` `config: { default: standard }`）。src/plugin.ts:160-163
注释："cordis.yml `preset` over the persisted `/preset` choice; undefined adopts
the roster default"；新建路径 `composePreset(ctx, configuredPreset ?? readPresetPref())`
（src/plugin.ts:401）。

preset 装配实现（`src/presets.ts`）：

- `rosterOf` 经 `ctx.get('agentPresets')` 可选访问（`src/presets.ts:49-51`）；
- `composePreset` 返回 `{ agentPreset, setup }`，setup 在 agent 工厂
  `setup(agentCtx)` 钩子内 `presets.mount(agentCtx, resolvedId)`（:74-93），
  解析失败降级为无 roster 组合（:80-85）；
- `resolvePersistedPreset` 读 `ctx.get('sessionPersistence').load(id)` 后经
  `resolveSessionPreset`——"the last agent-preset/selected event wins over the
  creation header"（:105-126）；
- 持久化位于 `~/.dsh-cc/agent-preset.json`（`src/presetPrefs.ts:15-63`，读/写
  best-effort，id 正则 `^[a-z0-9][a-z0-9-]*$`）。

## apply 启动序

`plugin.ts` 的 apply 顺序（`:35-330`）：

```text
1. TTY 检查             src/plugin.ts:35-38    非交互终端直接抛错
2. 语言解析             src/plugin.ts:44-45    CC_TUI_LANG > config.lang > resolveStartupLang() > zh
3. 更新标记校验         src/plugin.ts:52-71    DSH_CC_UPDATED_FROM 校验后删除
4. 服务装配             src/plugin.ts:82-91    userQuestions 兜底创建 + toolAskUser 挂载
                                             + registerPackagedSkills + 问卷 provider 注册
                                             + ctx.effect(rejectAll)（"All three must be in
                                               place before the agent is resolved"）
5. stderr 守卫          src/plugin.ts:100-115  child-process spawn 补丁（issue #17）
6. 模型路由             src/plugin.ts:117-129  resolveModelRoute(configuredRoute, readModelPref())
7. channel 创建         src/plugin.ts:144-165  挂 stderr 通知并 flush 积压（:166-171）
8. 退出漏斗             src/plugin.ts:193-264  createExitFunnel
9. React 渲染           src/plugin.ts:267-303  Chat + AlternateScreen 全屏树
10. 后台版本检查        src/plugin.ts:308-314  checkForTuiUpdate（4s 超时静默）
11. teardown effect     src/plugin.ts:320-323  只 markTeardown + unmount
12. waitUntilExit       src/plugin.ts:330
```

agent 解析（`resolveAgent`，`src/plugin.ts:352-429`）：

- resume 优先：有 sessionId 时 `ctx.agents.get(resumeId)`，未运行则
  `resolvePersistedPreset` + `composePreset` + `ctx.agents.resume`（:375-381），
  失败落回新建；
- 新建：`validateModelRoute(llm, startupRoute)`（:410，校验不通过整体回退默认
  路由）→ `ctx.agents.create`，meta 带 `agentPreset` 作为持久化 header
  （:416-424）；
- 失败 "Fail loud with the reason on stderr"（:425-432）。

### 环境变量入口全集

| 变量 | 读取位置 | 语义 |
| --- | --- | --- |
| CC_TUI_LANG | `src/plugin.ts:44` | 语言覆盖，无默认逐级回落 zh（`src/i18n.ts:1-11/390-392`） |
| DSH_CC_UPDATED_FROM | `src/update.ts:12`，`src/plugin.ts:53-57` | 更新后重启校验，校验后删除 |
| DSH_CC_RESUME_SESSION | `cordis.yml:27`、`cordis.patch.yml:203`；`src/plugin.ts:488` 生成 | resume 会话 id；`dsh-cc.cmd:29-32` 从 ~/.dsh-cc/resume.txt 喂入 |
| DSH_CC_SESSION_ROOT | `cordis.yml:164`、`cordis.patch.yml:149` | JSONL 会话根目录覆盖；裸 cordis.yml 默认 ~/.dsh-cc/sessions，profile patch 默认 dshHomePath('sessions')（通常 ~/.dsh/sessions） |
| CC_TUI_PRESET / CC_TUI_PERSONA | `cordis.patch.yml:202/17` | preset 覆盖；persona 默认 'You are a coding agent.' |
| CC_TUI_COMPACT_RATIO / CC_TUI_COMPACT_RETAIN | `cordis.yml:183-184` | 默认 '0.2' / '0.05' |
| CC_TUI_DISABLE_MOUSE | `src/utils/fullscreen.ts:10` | 禁用鼠标捕获 |
| CC_TUI_THEME | `src/components/design-system/ThemeProvider.tsx:55` | 主题覆盖 |
| CC_TUI_DEBUG | `src/utils/debug.ts:8` | 调试开关 |
| DSH_CC_RENDER_LOG | `src/ink/terminal.ts:215` | 渲染日志 |
| DSH_CC_WORKSPACE | `dsh-cc.cmd:16-17` | workspace 覆盖 |
| DSH_CC_HEAP_WATCH | `scripts/run.ts:56` | dev-only 堆看护 |

无 bin 入口（`src/plugin.ts:479-483` 注释："The package ships no `dsh-cc` bin —
resuming means feeding the session id through `DSH_CC_RESUME_SESSION`"）；
`dsh-cc.cmd:1-41` 是仓库提供的 Windows 启动器（`@dsh --profile cc-tui %ARGS%`，
`--resume` 读 resume.txt）。

## 命令分发链

```text
src/components/PromptInput.tsx useInput 捕获键入（src/components/PromptInput.tsx:373）
  -> '/' 触发 filterCommands 建议覆盖层（src/components/PromptInput.tsx:168-175）
  -> Enter -> tryRunCommand（src/components/PromptInput.tsx:337-354）：
     以 '/' 开头 -> parseCommandName（src/commands.ts:83-89，正则
     /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/）-> channel.commandList 判知
     -> 处理成功才进历史
  -> src/screens/Chat.tsx runCommand 大 switch（src/screens/Chat.tsx:293-708）
```

内置命令走本地分支：

| 命令 | 处理 |
| --- | --- |
| /model | 打开 ModelPicker（src/screens/Chat.tsx:463-473） |
| /rewind | 打开 RewindPicker（src/screens/Chat.tsx:513-518） |
| /new | channel.newSession（src/screens/Chat.tsx:439-448） |
| /compact | channel.compact（src/screens/Chat.tsx:457-459） |
| /resume | 会话选择器（src/screens/Chat.tsx:494-512） |
| /exit | onExit（src/screens/Chat.tsx:519-521） |
| 技能命令 | 发送 SKILL_PROMPTS 激活提示（src/screens/Chat.tsx:672-685） |

default 分支只对 `command.external` 的注册表命令走
`channel.runExternalCommand`（src/screens/Chat.tsx:691-704），未知名返回 false 放行给模型。
外部命令执行（`src/channel.ts:1962-1976`）：`commandService.execute(agent, "/" + name + rawInput, signal)`，
结果文本落为通知；`commandService` 是可选服务 `ctx.get('commands')`
（src/channel.ts:879，dsh-commands 注册表）。channel 注释（:874-878）：execute
"logs the paired command/run + command/done records"（plan-mode 投影依赖）。

命令列表合并（`src/channel.ts:2226-2243`）：以 `LOCAL_COMMANDS`（39 条，
`src/commands.ts:25-72`）为基底，注册表条目仅当 `merged.some(...)` 名字冲突时
continue（本地命令保留），并挂 `ctx.on('commands/change', refreshCommandList)`。

**内部矛盾（已记录）**：`src/commands.ts:6-8` 模块注释声称 "with the registry
handler winning for names both sides declare"，与相邻 JSDoc（:22-24 "locals win
on name collisions"）及实际行为（src/channel.ts:2229-2230、src/screens/Chat.tsx:293 内置名先
命中 switch）相反——行为是本地命令胜出。

## 退出漏斗与 teardown

`src/plugin.ts:450-467` 的 `createExitFunnel` 提供 `markTeardown`（标记后
`handleExit` 直接返回）与完整用户退出两条路径：

| 路径 | 行为 |
| --- | --- |
| teardown（recompose 触发，issue #12） | `ctx.effect(() => () => { funnel.markTeardown(); instance?.unmount() })`（src/plugin.ts:320-323）——只卸载 UI 不退出进程。注释："Teardown only unmounts the UI; user exit runs the full leave sequence"。解决 DSH launcher boot-time recompose 闪退回 shell 症状 |
| 用户退出（/exit、双 Ctrl+C、渲染崩溃） | onUserExit（src/plugin.ts:193-264）：writeResumeTarget 写 ~/.dsh-cc/resume.txt（src/sessionHistory.ts:36-39）→ unmount → update 交接（updateRequested 时 disposeRootAndThen → updateTuiAndRestart）或打印 resumeCommand 提示 → disposeRootAndExit(ctx, 0)（:259-262） |

退出后提示的 resume 命令（`src/plugin.ts:484-489`）：Windows 为
`dsh-cc --resume <id>`，其他平台为 `DSH_CC_RESUME_SESSION=<id> dsh --profile <name>`。

## bootstrap 目录

`src/bootstrap/state.ts:1-14` 模块注释："Interaction-time telemetry stubs
consumed by the ported Ink core"——三个函数全部空操作
（`flushInteractionTime`/`updateLastInteractionTime`/`markScrollActivity`），仅被
`src/ink/ink.tsx:9`、`src/ink/components/App.tsx:2`、`src/ink/components/ScrollBox.tsx:3`
导入。"bootstrap" 目录名源自 Claude Code 原版遥测模块，**不是启动引导代码**。

## 未验证事项

- dsh CLI Loader 如何读取 dsh.bundle.patch 并把 shipped `config/agent-presets/`
  根叠加到 agent-presets 行、`dshHomePath()` 的实现——dsh CLI 与 dsh-app-boot
  源码不在本仓库（`cordis.patch.yml:44-51` 与 `docs/getting-started.md:56-62`
  仅注释/文档描述该机制）。
- dsh-agent-presets 的 roster 内部行为：includeUserRoot（~/.dsh/.agent-presets
  追加）、mount/recompose/serviceFor 的作用域链细节（`src/presets.ts:35-43`
  仅声明最小接口 AgentPresetsLike）。
- dsh-commands 注册表的 execute/list 语义（`src/channel.ts:879,1962-1976` 只
  消费 CommandRuntime 接口）。
- packaged-skills 实际注册结果：skills/ 目录实含 audit/bug/practice/
  pr-comments/release-notes/review/vuln-check 7 个，但各 SKILL.md 的 frontmatter
  字段未逐一核验。

相关文档：[overview.md](overview.md)（总览与模块边界）、
[input-commands.md](input-commands.md)（命令与输入模型）、
[model-route.md](model-route.md)（模型路由）、
[session-context.md](session-context.md)（resume 与 teardown）、
[update.md](update.md)（更新链）、[unknowns.md](unknowns.md)（未验证清单）。
