# dsh-tui 安全模式 PR① 设计：safe 入口 + 自动 fallback（v2）

- 日期：2026-09-07（v2：经 codex gpt-6-astra 行级审查修订，审查原文 `/mnt/shared/_Projects/DSH-TUI/safe-mode-spec-audit.out`）
- 状态：待用户审阅
- 依据：调研报告 v2（`/mnt/shared/_Projects/DSH-TUI/safe-mode-research-report.md`）。本 spec 明确采纳其"入口先于自举/委托、退出码保真、防死循环"三项；**修改**：纯只读收窄为控制面只读（见 §4）；**延期**：恢复参数与会话选择的完整隔离（B-8）到 PR②（重试语义最小闭环见 §5.3）
- 上游参考：anywhere-labs/dsh-desktop v2.0.3 startup recovery（手动入口先于 Host 启动、`relaunch-arguments.ts:5` 一次性恢复参数）

## 1. 背景与目标

dsh-tui 是 cordis 插件体系的纯插件：profile 装坏时 dsh 组合起不来，TUI 的 apply 不执行，修复能力全在 TUI 之外且用户未必知道。PR① 给 dsh-tui 一个 profile 损坏时依然可达、可见的安全模式入口，内含只读诊断与修复指引；变更类修复动作属 PR②③。

**覆盖边界**：自动入口是"最终 dsh 子进程**非零退出码**后自动询问进入"，不是无条件进入，也不覆盖启动挂起（挂起检测依赖就绪协议，属后续结构化检测范围，见 §10）。

## 2. 范围

**做（PR①）**
- `bin/dsh-tui.js` 单文件内全部改动：`safe` 子命令截获、fallback 承接、`runDoctorChecks` 提取、无自举启动函数、MSG/helpText 扩展（**单文件内联，不新增 bin/ 模块**——理由见 §3.1）
- `scripts/verify-safe-mode.mjs` 聚焦回归 + 受影响既有断言更新
- `README.md` / `README_EN.md` 双语同步

**不做（PR① 边界）**
- 不执行任何变更命令（remove/add/install 只显示不代跑）；不 spawn 修复 shell；安全模式控制面不写任何文件（§4 界定例外）
- 不做 stderr 管道化 / 失败签名识别 / 就绪协议（结构化自动检测独立立项，不依附 PR②③）
- 不做检查点、依赖重建、干净 profile、多实例互斥（PR②③，见 §10）
- 不改 `src/`、`cordis.patch.yml`、`lib/`——patch-surface / boundary / contract 门禁零影响。**例外**：无（`migrateGlobalLauncher` 不动，正因如此必须单文件内联）

## 3. 入口：双通道

### 3.1 手动入口 `dsh-tui safe`

顶层截获（doctor 块后、update 块前，`bin/dsh-tui.js:284-405` 之间），先于角色分支（`bin/dsh-tui.js:430`）；两种角色跑同一段代码（实际分支：非（`runningInsideProfile` 或 `DSH_TUI_NO_DELEGATE=1`）且 `ownVersion !== undefined` 才走瘦壳委托，其余全部走完整逻辑）。零 lib 依赖、不委托、不自举——对齐 doctor 的依赖边界（doctor 的既有注释：profile 残缺时它必须还能跑）；不沿用 update 的"动态 import profile 编译产物"路径（update 自己注释了那条路的代价，且 profile 产物损坏正是安全模式要救的场景）。瘦壳角色对 `safe` 直接应答、不委托给 profile 副本。

**为什么必须单文件内联**：全局启动器由 `migrateGlobalLauncher`（`src/update.ts:1285`）以"入口文件 + 包清单"覆写——只拿到新入口、拿不到新模块文件的安装真实存在；`bin/dsh-tui.js:23` 的入口契约与迁移实现都只覆盖单文件。拆分模块在该场景下静态导入坏掉全部入口、动态导入令 safe 不可达。safe 菜单以内联函数区段实现，预计使 `bin/dsh-tui.js` 从 574 行增至 ~950 行——为迁移自保接受此膨胀（与 `bin/dsh-tui.js:89-91` "零外部依赖是自保底线"同源的约束，升级为"单文件自包含"）。

**旧启动器兼容（前提重述）**：旧全局启动器把 `safe` 透传给 profile 副本、由新版副本截获——**前提是副本入口可读且为新版**；profile 包损坏/副本缺失时，旧全局启动器会在自举或委托读取处先行失败（`bin/dsh-tui.js:430-439`），此场景的救援指引是升级全局启动器（`npm i -g @deepseek-harness-tui/dsh-tui`）或直接重装，README 如实写明。自动 fallback 的承接范围限定为最终 dsh 子进程的退出结果（§5），不承诺接住更早的启动器自身失败。

**参数消费**：`safe` 作为首参被截获消费；其后若还有参数，忽略并在标题下提示一行"已忽略附加参数：<n> 个"（不做参数语义）。

### 3.2 自动 fallback（异常退出承接）

位置：完整逻辑分支（瘦壳委托路径**零改动**，天然无双询问）最终启动 dsh 的退出处理。判定与结果语义统一见 §5。

## 4. 只读边界（控制面只读）

- **控制面只读**：safe 会话自身（询问、菜单、诊断、清单、指引）不写任何文件、不执行任何安装/卸载、不修改 env 后遗留（会话内临时状态除外）
- **重试是显式例外**：菜单动作 1"重试正常启动"把进程交回正常启动链，其后的行为（TUI 写会话记录 `sessionHistory.ts:43` 等）属正常运行，不受只读约束
- **重试不得隐式自举**：重试前检查 `profileReady()`；不 ready 时不进入 `bootstrapProfile()`（那会触发插件安装，`bin/dsh-tui.js:359-394`），而是回菜单报告"profile 不完整，无法重试"并指向修复指引中的重装命令。fallback 场景 profile 正是嫌疑对象，隐式自举会掩盖故障且引入写操作
- **safe 入口跳过旧文件清理**：进入 safe 会话不触发 Windows 旧二进制删除等入口期清理（`bin/dsh-tui.js:36` 附近的既有逻辑只在正常路径执行，safe 截获先于它即可）
- 非 TTY 降级输出同样只读（一次性打印 §6.2 全量信息后退出）

## 5. fallback 判定与结果语义

### 5.1 退出结果模型

dsh 子进程的结束统一表示为 `{ kind: 'exit', code } | { kind: 'signal', signal } | { kind: 'error', error }`（error = spawn 创建失败，现 `bin/dsh-tui.js:334` 的 error 路径并入此模型）：

| 结果 | 首次启动（正常链内） | 重试（safe 菜单动作 1 内） |
|---|---|---|
| exit 0 | `process.exit(0)`（原样） | 以 0 结束 safe（使命完成） |
| exit N≠0 | TTY→询问进 safe（pendingExitCode=N）；非 TTY→追加提示行后 `exit(N)` | 更新 pendingExitCode=N，回菜单显示"重试仍失败（码 N）" |
| signal | 原样 self-kill 透传（`bin/dsh-tui.js:338` 既有语义，**不变**） | 回菜单显示"重试被信号终止"；pendingExitCode **不变**（信号不是会话退出码） |
| error | TTY→等同 exit 1 处理（询问进 safe，pendingExitCode=1）；非 TTY→保留原 launchFailed 诊断 + 追加提示行后 `exit(1)` | 回菜单显示启动失败诊断；pendingExitCode 不变 |

- **退出码保真**：最终以最近一次会话退出码结束（pendingExitCode 只被非零 `exit` 更新）；信号首启维持 self-kill，数值语义不在信号场景下虚构
- **Windows**：dsh 经 `cmd()`+`shell:true` 启动（`bin/dsh-tui.js:82`），壳层观察到的 `{code, signal}` 不保证等同内部 dsh 的中断语义——只按数值退出码判定 fallback，不从数值反推信号；控制台中断（Ctrl+C 经 cmd）单列入 §8 验证

### 5.2 提示文案（非 TTY 与拒绝后）

在**既有非零退出诊断输出之后追加**一行（不替换、不删除旧诊断——`verify-launcher.mjs:174` 断言护住旧文案）：`[dsh-tui] 异常退出（码 N）。可运行 dsh-tui safe 进入安全模式`（en 对应，MSG 新增 `safeHint`）。

### 5.3 重试的参数与环境继承

- 重试**复用首次规范化后的启动输入**：完整逻辑分支在启动 dsh 前已完成参数拦截/嗅探（`--resume`/`-c` 写入 `DSH_TUI_RESUME_SESSION` 等，`bin/dsh-tui.js:501-539`）并构造 spawn args（`bin/dsh-tui.js:517` 起）——实现须把"最终 spawn 的 argv 数组 + 关键 env 增项"保存为可重放上下文，重试直接重放，**不重新解析 `process.argv`**（避免恢复参数二次消费/工作区参数再次落入透传）
- `DSH_TUI_LAUNCHER_VERSION`：保持进程 env 现状不重设（瘦壳已注入则沿用——外层代际如实传递；缺失则首次构造时的补值逻辑已执行，重试不重复触发）
- 手动 `safe` 入口：不预设任何恢复变量；env 继承进程现状（这是"进入正常运行"例外的一部分，§4）

## 6. safe 会话（内联于 `bin/dsh-tui.js`）

### 6.1 菜单

```
dsh-tui safe · 安全模式（控制面只读）      [launcher|profile] <版本>
profile: <profileDir>
──────────────────────────────────────────────
<进入时自动运行一次 doctor 诊断并展示>
  1) 重试正常启动
  2) 重新运行环境诊断
  3) 查看 profile 插件清单（只读）
  4) 显示修复命令指引
  5) 退出（退出码 <pendingExitCode ?? 0>）
```

- **动作 1**：按 §4/§5.3 执行（profileReady 前置检查、重放启动上下文）
- **动作 2**：`runDoctorChecks()`（§7.1）
- **动作 3**：读 `profileDir/package.json`，两维度分列——`dsh.profile.bundles`（有序组合层，只读展示）与 `dependencies`（直接依赖）；保护包 = `@deepseek-ai/dsh-base`、本包 `@deepseek-harness-tui/dsh-tui`，标注"内置"；其余标注"第三方"。文件缺失/损坏/字段缺失或类型错误 → 降级显示「清单不可读：<原因>」与指引，safe 自身绝不崩溃。两维度分类是后续 PR② 卸载功能将复用的唯一分类规则，不得合并简化
- **动作 4**：可复制的完整命令——`dsh plugin --profile dsh-tui remove <包名>`（附动作 3 解析出的第三方直接依赖作为候选）、`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<版本>`（重装/对齐）、`dsh-tui doctor`、升级指引；明示"变更命令需自行执行"
- **动作 5**：以 pendingExitCode（无则 0）退出

### 6.2 交互、降级与终端所有权

- **询问（fallback）**：readline 单问「进入安全模式？[Y/n]」，默认 Y；Ctrl+C/Ctrl+D/EOF 等价拒绝（按原退出码退出）
- **菜单输入规则**：编号选择；无效输入重提示**上限 3 次**（每次一行简短提示），达到上限后重印完整菜单继续等待（不退出、不自动选择）；计数在每次有效选择后重置；Ctrl+C/Ctrl+D/EOF 等价动作 5
- **非 TTY 降级**（手动入口在管道/headless）：不进交互，一次性打印「标题+忽略参数提示+doctor 诊断+插件清单+修复指引」后以 pendingExitCode（无则 0）退出
- **终端所有权三阶段**：询问/菜单阶段 readline 持有输入；重试前**主动关闭 readline 并先移除 close 处理器**（用显式标志区分"为交接主动关闭"与"用户取消关闭"，后者才触发动作 5），子进程 stdio inherit 直通；重试结束回菜单时**重建 readline**。异常退出的子进程不保证完成终端清理（alt-screen/鼠标/raw 残留，清理责任在 TUI 的 `ink.tsx:2286` 一侧）——进入询问/菜单前 safe 输出最小恢复序列（显示光标、结束备用屏若在用），仅为让菜单可读，不承诺完整复原
- 文案中英双语（MSG 模式扩展），`lang` 判定沿用 `DSH_TUI_LANG ?? CC_TUI_LANG`

## 7. `bin/dsh-tui.js` 改动清单

### 7.1 `runDoctorChecks()` 提取（行为等价重构）

doctor 截获块（`bin/dsh-tui.js:284-331`）的检查逻辑提取为内联函数，返回 `{ hardFailure, lines[] }`：闭包依赖（`msg/PACKAGE/ownVersion`、`spawnSync/cmd/shellOpt`、`readJson/installedPkgPath/profileDir`、`runningInsideProfile/isVersionNewer`、`homedir/join/existsSync`）就地可用（同文件内联，无跨模块问题）；标题与逐项 `report` 行按原顺序收集进 lines；保留版本输出白名单回显、密钥 truthiness 红线、仅 dsh 缺失为硬失败；`process.exit` 留在 doctor 入口。doctor 子命令输出**逐字不变**（等价性由 §8 的完整期望值断言证明，不以现有子串断言为准）；safe 菜单复用同一函数——两个入口的 diagnostics 不许分叉（对齐 doctor 与 /doctor 的既有契约）。

### 7.2 无自举启动函数

"构造并 spawn dsh、返回 §5.1 结果对象"的函数：由完整逻辑分支的正常启动路径与 safe 重试共用；正常路径语义不变；重试路径按 §5.3 重放保存的启动上下文、按 §4 拒绝隐式自举、失败**返回调用者**（不直接 `process.exit`，退出决定权在菜单/首启逻辑）。

### 7.3 fallback 接线

完整逻辑分支的子进程退出处理改为消费 §5.1 结果模型（signal 分支维持既有 self-kill；error 路径并入模型且保留原诊断输出）；瘦壳的 `forwardExit` 不动。

### 7.4 其他

MSG 新增 `safeHint`（§5.2，追加语义）；`helpText` 补 safe 一行；safe 截获块内联菜单实现（§6），位置在 doctor 块后、update 块前。

## 8. 测试与验证

新增 `scripts/verify-safe-mode.mjs`（先读脚本头部说明的既有要求；手法注明来源）：

1. **零环境可用 + 只读证明**：绝对 Node 路径、空 PATH、隔离 HOME/DSH_HOME（`verify-cli-subcommands.mjs:49` 手法）→ `safe` 非 TTY 降级退出 0；断言输出含标题/诊断/指引标记；断言沙箱 DSH_HOME 内**无目录新增、无文件写入**（前后快照对比——只读的证明靠文件系统差异，不靠退出码）
2. **清单解析矩阵**：伪 profile package.json 夹具（扩展 `verify-cli-subcommands.mjs:93` 手法）覆盖：正常（两维度+保护包分类）、缺文件、字段缺失、字段类型错误、损坏 JSON——输出断言 + 文件内容不变断言。注意诊断读包安装清单（`installedPkgPath`）与插件清单读 profile 根清单是两个夹具
3. **fallback 触发矩阵**：dsh 替身用分命令脚本控制（`--version` 成功、实际启动按脚本退出，`verify-launcher.mjs:51/63` 手法）× 结果 {exit 0 / exit 3 / SIGINT / error} × TTY {无}（PTY 见下）：exit 0 无提示且码 0；exit 3 有 safeHint 且码 3；SIGINT 信号透传无提示；error 有 launchFailed+提示且码 1。另测非交互确认拒绝路径、连续失败 pendingExitCode 更新、重试成功以 0 结束、重试不自动二次询问
   勘误（终审）：spawn error 场景在非 TTY 沙箱不可无竞态构造（预检与最终 spawn 共用 PATH），error 分支自动化覆盖延至 PR② 注入点；现由代码评审覆盖
4. **PTY 交互子集**：`pty-conpty-probe.mjs` 依赖外部原生模块（其头部 `:8` 注明）——脚本探测依赖可用性：可用则驱动询问 Y/n 与菜单动作 1/5（含超时清理），不可用则**报告跳过并留手动证据清单**（不静默跳过）；Windows conpty 路径同法单列；运行时输出 SKIP 行（不静默跳过）——已落地
5. **doctor 等价**：`runDoctorChecks` 提取前后 doctor 输出完整期望值比对（仅规范化临时路径等易变字段；覆盖双语、顺序、换行、退出码；不以 doctor/safe 同源互比充当证明）；同时跑既有 `verify-cli-subcommands.mjs`
6. **双角色截获**：全局瘦壳角色 + `DSH_TUI_NO_DELEGATE=1` + **真实 profile 内副本运行**（扩展 `verify-launcher.mjs:251` 复制真实入口的夹具，含单文件迁移布局：仅入口文件的安装形态下 safe 仍可用——这是 §3.1 单文件契约的直接断言）
7. **既有断言更新**：`verify-launcher.mjs:174` 涉及非零退出输出的断言按"追加不替换"更新期望；新脚本登记进 CI 聚合入口（`run-ci-group.mjs`）

手动演练（终端可见改动要求）：从 inline 与 fullscreen 两种前置状态人为制造非零退出，演练 fallback 询问 → 菜单全动作 → 退出码；窄终端宽度排版；Windows 数值退出码与控制台中断单列演练。

## 9. 文档同步

`README.md` / `README_EN.md`：安全模式小节（双入口、控制面只读边界与重试例外、覆盖边界=非零退出码、退出码语义、旧启动器兜底前提与升级指引）。实现 PR 描述链接本 spec。

## 10. PR②③ 锚点（后续消费，勿删细节）

- PR②：菜单加入卸载插件——两段式确认 + 执行后重读清单复验 + 多实例占用检测（真实 home/profile 路径登记）；修复 shell；恢复参数与会话选择完整隔离（本 PR §5.3 的最小闭环升级）
- PR③：三槽健康检查点（含 pnpm-lock.yaml 与 workspace 配置与市场状态）+ 依赖重建（`dsh plugin install` 先例，优先验证 frozen-lockfile 语义）+ 干净 profile 两隔离等级（同 home 救援 profile / 隔离 home 诊断环境）
- 结构化失败检测（stderr 管道化、就绪协议/挂起检测）独立立项，不依附 PR②③

### 范围变更记录（2026-09-10）：救援 profile 提前至本 PR

按维护者"最小可用"定义（创建空白 profile 并以 doctor 指导用户操作），PR③ 的"同 home 救援 profile"以简化版提前进本 PR：菜单选项 5 = 先展示 doctor 诊断 → 创建 `dsh-tui-safe` 空白 profile（`dsh plugin add` 钉当前版本，bootstrap 同款 -w 重试与 no-op 复查；**已存在绝不重复安装**——固定名 add 不清旧内容）→ 以它干净启动（`startDshSession` 参数化 profile），结果与重试同结算（exit 0 结束会话，其余回菜单）。写边界收窄为：**写操作只发生在全新目录**（本 PR §4 的第二个显式例外）。隔离 home 诊断环境与检查点/依赖重建仍留 PR③。验证：非 TTY 指引含救援手动命令（verify-safe-mode 断言）+ PTY 演练 D12（doctor 展示/创建落盘/干净启动 exit 0，24/24）。

## 11. 开放问题（实现计划阶段解决，不阻塞本 spec）

- PTY 依赖在 CI 的落位（原生模块安装或专用 runner）
- `runDoctorChecks`/无自举启动函数与现有代码的精确切割线（以实现时文件现状为准，本 spec 只锁行为契约）
