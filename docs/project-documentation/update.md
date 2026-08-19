# 更新系统

本文覆盖版本检查（启动时一次性后台检查）、/update 手动更新链路、重启与会话
恢复，以及已确认缺陷（DSH_CC_UPDATED_FROM 取值时点）。更新系统由提交
dde5c86（PR #66）引入。行号均以审计基线 b2f4087 为准。

## 启动时版本检查（一次性，无周期轮询）

```text
src/plugin.ts:308  void checkForTuiUpdate().then(...) 首帧渲染后后台执行
  （:305 注释 "Check in the background so registry latency never delays the
  first frame. A failed/offline check is intentionally silent"）
  -> src/update.ts:150-153 checkForTuiUpdate -> resolveTuiUpdateTarget
  -> 自身版本：installedTuiVersion()（src/update.ts:36-53）读 ../../package.json
     或 ../package.json（编译布局/源码布局双路径），要求 name 匹配
     dsh-cc-tui 且 semver 合法（外来 manifest 拒绝）
  -> 最新版：fetchLatestVersion（src/update.ts:108-127）
     fetch(`${registry}/dsh-cc-tui/latest`，accept: application/json，
     AbortController 4s 超时 UPDATE_CHECK_TIMEOUT_MS）；任何失败返回
     undefined——离线/网络错误静默
  -> 目标分类三态（src/update.ts:134-143）：
     update（latest > current）/ latest（已最新）/ unknown（离线或自身版本
     不可读）
  -> 命中 update：channel.notify(update-available，含 current/latest，
     timeoutMs 12000，12 秒自动消失) 提示输入 /update（src/plugin.ts:310-314）
```

registry 解析优先级（src/update.ts:83-94）：`NPM_CONFIG_REGISTRY`（两种拼写，
含小写 npm_config_registry）> 用户 ~/.npmrc 的 `registry=` 行 > npmjs.org
默认值——"mirror users see the same `latest` their package manager would
install"。

## /update 手动更新链路

前置条件：/update **仅在 `dsh --profile <name>` 启动模式下可用**——profile
从 argv 解析（src/update.ts:63-76 resolveDshProfileName，首个 --profile token；
dsh 不设 profile 环境变量）；源码运行/--config 直启时 onUpdate 为 undefined
（src/plugin.ts:184-187,271-274）。

```text
/update（src/screens/Chat.tsx:647-657）：
  onUpdate === undefined -> notify update-unavailable
  channel.working -> notify update-working（当前回合需等待完成）
  否则 notify update-starting -> onUpdate()
  -> src/plugin.ts:274-292 onUpdate 预检 resolveTuiUpdateTarget：
     latest -> notify update-already-latest，不重启
     unknown -> notify update-check-failed 后仍继续
     updateRequested = true；instance?.unmount()（更新前必须先卸载 TUI，
     防止 pnpm 输出破坏已渲染的终端帧）
  -> waitUntilExit().then(handleExit)（src/plugin.ts:330）-> onUserExit
     （src/plugin.ts:194-264）：writeResumeTarget(channel.agentId) 写 resume.txt
  -> 打印 'Updating dsh-cc-tui and restarting…' -> disposeRootAndThen
     （cordis ctx.root.fiber.dispose() 整树回收，5 秒兜底定时器保证退出码，
     src/plugin.ts:497-510）
  -> updateTuiAndRestart(channel.agentId, profile)（src/update.ts:216-236）：
     runProcess('dsh.cmd'/'dsh', ['plugin', '--profile', profile, 'update',
       '--latest', 'dsh-cc-tui'], { shell: true })（win32 下 shellQuote 引号
       处理；stdio inherit 直连用户终端）
       --latest 是跨 minor 升级的关键（src/update.ts:199-210 注释）：
       "`--latest` is required: `pnpm add` writes a caret range into the
       profile manifest, and a plain `pnpm update` stays inside that range"
       ——本仓库 minor-per-release 节奏下 plain update 会重启却未变化
     -> 成功后重启：spawn(process.execPath, [...process.execArgv,
        ...process.argv.slice(1)]) 直接起 node——**不经 cmd.exe**，标准安装
       路径 C:\Program Files\nodejs\node.exe 含空格，经 cmd.exe 会被拆开
       导致替代进程起不来（src/update.ts:228-234）；env 携带
       DSH_CC_RESUME_SESSION（会话 id）与 DSH_CC_UPDATED_FROM
  -> 重启进程 cordis.patch.yml:203 sessionId =
     process.env.DSH_CC_RESUME_SESSION -> 恢复会话
  -> 新进程启动核验（src/plugin.ts:52-71）：delete process.env.DSH_CC_UPDATED_FROM
     （避免赋值 undefined 变字符串泄漏给子进程）；现版本未严格新于标记值时
     logger.warn + stderr 中文提示（"可能是镜像 registry 未同步，请稍后重试
     或检查 registry 配置"）
  -> 0.8.3 Launcher 对齐桥接（同一核验区块）：/update 只替换 profile 内
     的包，全局 dsh-tui Launcher 是独立安装。Launcher（bin/dsh-tui.js，
     >=0.8.3）spawn dsh 前设置 DSH_TUI_LAUNCHER_VERSION；更新成功后若该
     marker 缺失（旧 Launcher <=0.8.2 不设置），给一次性"如果你使用全局
     dsh-tui，请同步更新"提示；若 marker 明确比新 Profile 旧，给精确的
     `npm install -g @deepseek-harness-tui/dsh-tui@<profile版本>` 命令。
     marker 非一次性，后续 /update 重启需继承，才能知道外层 Launcher
     是否落后。
```

失败路径（src/plugin.ts:236-244）：updateCode 非 0 时不重启，打印 'cc-tui update
failed (exit N). Your session is preserved — resume with:' + resumeCommand
（Windows: `dsh-cc --resume <id>`；POSIX: `DSH_CC_RESUME_SESSION=<id> dsh
--profile <name>`，src/plugin.ts:484-489），再以 restartCode 退出进程。

teardown 与更新的衔接（src/plugin.ts:316-323,450-467）：cordis 上下文 teardown
（如 launcher 启动期 recompose）只 markTeardown + unmount，绝不进入用户退出/
更新序列；/update 走的是用户退出漏斗（exit funnel）路径。

## 已确认缺陷

**DSH_CC_UPDATED_FROM 取值时点错误**（src/update.ts:232）：

- 设计意图（src/plugin.ts:47-48 注释）：标记是 "the version it was leaving
  behind"（更新前版本），仅当 "the freshly loaded one is not newer" 时告警。
- 实际代码：`installedTuiVersion()` 在 `await runProcess(dsh, ...update
  --latest...)` **完成后**才求值——此时磁盘已是新版，标记 = 新版。
- 后果：成功更新后重启核验 `isVersionNewer(now, updatedFrom)` 必为假，
  "版本未变化"告警在**每次成功更新后同样触发**；该告警只在镜像滞后/失败
  场景才符合设计意图。

静态顺序证据明确；运行后果需实跑确认（dsh plugin update 的内部 pnpm 行为属
dsh CLI 外部实现，只读审计无法验证），证据等级 strong indication。

## 回归验证

`scripts/verify-update.mjs`：25 项 check，对编译产物 lib/types/update.js 做
纯函数断言（真实编译 lib、无网络、无子进程；:27-29），任一失败非零退出
（:206-210），挂 CI（.github/workflows/ci.yml:43-45）。覆盖：installedTuiVersion 双布局+外来
manifest 拒绝（4）、registry 解析 env 两种拼写/npmrc/默认（4）、semver 严格
大于（5）、resolveDshProfileName 五种形态（5）、shellQuote 三种（3）、源码
文本断言（4：pnpm --latest 存在、P1 dsh.cmd spawn 请求 shell、P1 node 重启
spawn 无 shell——空间安全执行路径）。

## 冲突

| 项 | 两侧 |
| --- | --- |
| update-unavailable 兜底提示缺 --latest | `src/i18n.ts:173` 提示 'dsh plugin --profile <name> update dsh-cc-tui'（无 --latest）；src/update.ts:204-207 注释明确 plain update 会被 caret 范围困住、跨 minor 必须 --latest——该提示等于把用户引向会空转的命令；getting-started.md:100 的手动命令用 `add dsh-cc-tui@latest` 才与 --latest 意图一致 |
| 文档遗漏小写拼写 | docs/interaction.md:152 只写 'NPM_CONFIG_REGISTRY 或 ~/.npmrc'；代码（src/update.ts:84）与 verify-update.mjs:112-117 同时支持小写 npm_config_registry |

## 未验证事项

- 重启后恢复会话的具体细节：重启进程用 process.argv.slice(1) 原样重放
  launcher 参数，dsh launcher 如何重新解析 --profile 并 recompose cordis 树
  属外部实现。
- installedTuiVersion 在 source-checkout 布局下（scripts/run.ts 经 tsx 启动）
  的真实运行时行为（verify-update.mjs 用拷贝到 scratch 的编译模块模拟该
  布局，真实 tsx 运行时未直接验证）。

相关文档：[lifecycle.md](lifecycle.md)（退出漏斗与 teardown）、
[session-context.md](session-context.md)（resume 契约）、
[model-route.md](model-route.md)（重启后路由解析）、[unknowns.md](unknowns.md)。
