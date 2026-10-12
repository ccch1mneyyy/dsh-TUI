# Codex 原生后端：交接文档

[技术方案](codex-backend-design.md) · [施工日志](codex-backend-progress.md) · [多后端架构](agent-backend-design.md)

写给在另一台机器上接手的实现者（人或 AI）。读完本文就能从当前状态接着做，不需要原会话的上下文。
**权威顺序**：施工日志（实测与偏离）＞ 技术方案（设计与分期）＞ 本文（状态与操作指引）。三者冲突时
以施工日志为准，并顺手修正另外两份。

## 1. 当前状态

- 分支 `feat/codex-native`，基于 main `f6d61438`。设计提交 `483a550b`，之后是实现提交，截至交接的
  实现 HEAD 为 `93457fb7`；本文与方案的修订在其后的文档提交里。
- **已完成**
  - **C0**：协议类型入库（codex-cli 0.160.1，`src/backends/codex/protocol/generated/`，同步脚本
    `scripts/codex-protocol-sync.mjs`）、`contract.ts` + `verify:codex-contract`（在 `verify:build` 里）、
    假 app-server、fixture 与脱敏检查、实测守卫、探针；方案 §12.1 的 V1–V17 全部有结论（施工日志 C0）。
  - **C1**：rpc/hub/binary/detect/backend、会话（四种输入放置、取消回执、命令/文件/权限审批、问卷）、
    翻译器（live 与回放共用 `translate/items.ts`）、首页历史回放、内核注册（N7：`--backend codex`、
    配置、`DSH_TUI_BACKEND`、内核选择器）、`/doctor` 行、中英文案。
  - **中立层 N1–N7**：N1 与 N7 随 C0/C1；N2–N6（elicitation 公共函数、问卷保密输入、运行中工具实时输出
    `tool.output`、diff 的 unified patch 真实行号、目标预算与 `goals` 能力）在 `feat/codex-neutral`
    实现后合入（合并提交 `1e798ed3`）。
  - **C0+C1 独立评审与修复**（`93457fb7`）：10 项建议修复完成 9 项、小问题完成 6 项（施工日志
    "评审修复"）。
  - **方案评审**（交接前）：方案按 17 处优化修订——新增中立层 N8（独立的只记账 `usage` 事件 +
    `context.usage` 占用读数）、N9（可选 `init` 能力）、事件流不变量检查器、斜杠命令对照表（§8.6）、
    Shift+Tab 只切 Plan、上下文按官方 12k 基线公式、默认设置优先级、bubblewrap 对话内提示、
    hub 路由不依赖到达顺序、Windows 解析真正的 `codex.exe`、渠道 URL 校验等。凡标 **评审修订** 的段落。
- **本机续作已实现 C2–C4**：基线 `02141231` 上的未提交改动在独立工作树；N8/N9、控制面、登录/渠道、
  原生目录与分页、图片、fork/rewind/color、保真重连、子代理/终端/目标、hooks、旁问/recap 与 Codex
  标题已接通。完整验证和实际未测边界见施工日志的本机续作条目。维护者随后授权重新构建、部署dst并上传feat/codex-native供验收，暂不开PR、不合并。

## 2. 剩余工作

方案 §11 的日常核心清单已实现，不表示所有原生信息字段和进阶功能已适配。剩余信息面缺口与
真实凭据/TTY验收见施工日志末节。维护者已授权上传feat/codex-native，验证后再决定PR和合并。
下表的原评审遗留已修复，保留作回归清单。

### 2.0 评审遗留（已修复）

| 项 | 内容 | 方案出处 |
| --- | --- | --- |
| 渠道 URL 校验（评审 #7） | 随 C2 的 `channels.ts` 实现：只收 https（http 仅本机），拒绝 userinfo/query/fragment/像密钥的路径段；文档写明主机名在进程列表可见 | §5.11 |
| hub 诊断只给第一个会话 | debug/stderr/bubblewrap 一次性诊断广播给所有 attach 的会话 | §5.3 |
| 退出时没关 hub | `closeAllCodexHubs()` 接入退出漏斗 | §5.3 |
| `usageOnly` 标志 → N8 | C1 评审修复用 `assistant.message.usageOnly`（施工日志 R-D1）；方案评审改为独立 `usage` 事件，并让投影器采用 `context.usage` 占用读数 | §6 N8、§7.5 |
| 事件流不变量检查器 | 新建并跑 DSH/Claude/Codex 全部 fixture | §10.3 |

### 2.1 注意点

- `/init` 不能做成后端命令（本地 `/init` 会遮住它），走 N9 能力。
- 默认权限档只在用户既没在 dsh-tui 选过、`config.toml` 也没设时才用 `auto`；不覆盖用户配置。
- rewind 用稳定的 `thread/fork{lastTurnId}`；`beforeTurnId` 只在实验类型里，不用。
- ChatGPT 订阅登录无账号可测：`chatgptAuthTokens` 链路只用假 app-server 验证；有账号后首个实测要确认
  OpenAI 是否接受 `originator=dsh-tui`（方案 §12.2），不得伪装官方客户端名。
- 开 PR 前：全部门禁绿、独立评审无阻断；按 `.agents/skills/pr` 先建 `[功能]` 跟踪 issue（目标/范围/
  非目标），PR 标题英文 conventional（仓库 squash 合并），正文中文。

## 3. 新机器准备

```sh
git clone https://github.com/ccch1mneyyy/dsh-TUI.git && cd dsh-TUI
git switch feat/codex-native
git submodule update --init vendor/dsh-std
pnpm install --frozen-lockfile          # pnpm 11，Node ^22.19 || >=24
pnpm build                              # 编译 + 全部构建门禁（含 verify:codex-contract）
```

Codex 二进制（验证版本 0.160.1；最低 0.144.0，其余版本会有 drift 提示）：

```sh
npm i -g @openai/codex@0.160.1          # 或装到任意目录，再 export CODEX_EXECUTABLE=<路径>/codex
codex --version
```

升级协议（换验证版本时）：`node scripts/codex-protocol-sync.mjs --bin "$(command -v codex)"`，然后看
`src/backends/codex/protocol/generated/` 的 diff、更新 `contract.ts`、重跑 fixtures 与门禁、按方案 §12.1
复核清单逐项复核。

Codex 源码参考（只读，不入库）：

```sh
git clone --depth 1 --branch rust-v0.160.1 https://github.com/openai/codex.git codex-src
# codex-rs/app-server（协议实现）、codex-rs/tui/src（官方 TUI 的呈现，snapshots/*.snap 是显示对等基准）
```

原调研机器上的调研目录（生成类型原件、探针原件、录制原件）不随仓库；需要的部分已入库：
`protocol/generated/`、`scripts/fixtures/codex/`、`scripts/probes/codex-*.mjs`。

## 4. 测试与实测

- 回归：`scripts/verify-codex-*`（假 app-server，不花钱），已登记在 `scripts/run-ci-group.mjs`。
- 每期必跑：`pnpm build`、`pnpm verify:package`、`pnpm smoke`、`node scripts/run-ci-group.mjs <组>` 的
  全部组（CI 用 `DSH_TUI_LANG=zh`；`~/.dsh-tui/lang.json` 设为 zh 的机器上，`verify:transcript-images`
  与 `verify:image-preview` 需干净的 HOME 才过）、`verify:projection-golden`（DSH 不许动）、
  `verify-dsh-translate`、`verify:agent-domain`、`verify:claude-contract`、全部 `verify-claude-*`。
- 已知时序 flake（单独重跑通过即可，在施工日志注明）：`verify-compaction-progress`、
  `verify-session-browser`、`verify-scroll-jumps-narrow`；高负载并行时偶发 `verify:adapter-descriptor`、
  `verify:btw`、`verify:rewind-edit`、`verify:overlay-occlusion`、`verify-unseen-report-once`。
- **实测（真实 Codex，不进 CI）**：
  - 只走 `scripts/lib/codex-cheap-only.mjs` 守卫：临时 `CODEX_HOME`，中转 provider 经 `-c` 注入，模型只许
    `gpt-5.6-terra` + `low`（不行再 `gpt-6-sol` + `low`）。
  - 环境变量：`CODEX_TEST_BASE_URL`、`CODEX_TEST_API_KEY`（由维护者在执行机器上提供；**绝不提交、
    不打印、不写进任何文件或 fixture**），`DSH_TUI_CODEX_LIVE=1` 打开 `verify-codex-live`。
  - 每回合约 9.4k 输入 token（Codex 系统提示），按每期预算控制回合数；会话在 `finally` 里 dispose。

## 5. 规则（维护者要求）

- 提交身份：`git -c user.name=Chimney -c user.email=ccchimneyyy@gmail.com commit …`；提交信息末尾按执行方
  的署名规范加 `Co-Authored-By` 行。
- 只暂存显式路径，绝不提交 `lib/`，不运行破坏性 git 命令；未经维护者要求不 push、不开 PR。
- 本轮维护者明确要求扩大并行与 xhigh，实际使用 5 个独立工作树子代理，互不重叠；后续未获同类授权时
  沿原约定控制并行。**子代理不得再派子代理**。
- 省钱：能用假 app-server 证明的不用实测；实测只用上面的便宜模型。
- 推送前扫描：`git diff origin/main...HEAD` 里不得出现中转站主机名、`sk-`、Bearer、JWT 形状串、个人邮箱。
- 每个 checkpoint 在 `docs/codex-backend-progress.md` 追加条目（做了什么、门禁命令与通过数、偏离与理由、
  遗留）。

## 6. 代码导读

| 想了解 | 先读 |
| --- | --- |
| 整体与决策 | 方案 §0、§3、§4 |
| 一条通知怎么变成界面 | `rpc/client.ts` → `rpc/hub.ts`（按 threadId 路由）→ `session/session.ts` → `translate/live.ts` → `translate/items.ts` |
| 回放 | `session/history.ts` → `translate/replay.ts`（与 live 共用 `items.ts`） |
| 输入与取消 | `session/input.ts`（四种放置、客户端 followup 队列、`closedTurns`、回执） |
| 审批/问卷 | `session/approvals.ts`（`availableDecisions` → 选项；子 thread 审批路由到父会话） |
| 卡片长什么样 | `translate/presentation.ts`、`translate/commands.ts`（命令解包与只读动作） |
| 测试脚手架 | `scripts/lib/codex-fake-app-server.ts`、`codex-session-harness.ts`、`codex-translate-harness.ts` |
| 对照的成熟实现 | `src/backends/claude/`（同一套领域契约） |
