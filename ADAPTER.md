# Adapter 边界与上游契约

## 边界规则

厂商包按目录隔离,中立层不碰厂商代码:

| 目录 / 包 | 规则 |
| --- | --- |
| `@deepseek-ai/*` | 只在 `src/dsh-adapter/` 内 import |
| `@anthropic-ai/*` | 只在 `src/backends/claude/` 内 import(由该后端 manifest 的 `vendorPackages` 派生,见下) |
| `@agentclientprotocol/*` | 只在 `src/backends/acp/` 内 import(为将来的 ACP 后端预留,目录尚不存在) |
| `@dsh-std/*` | 只在 `src/adapter/standard/` 与 `src/dsh-adapter/` 内 import |
| `src/agent/`、`src/channel/` | 不 import 厂商包、`src/dsh-adapter/`、`src/backends/` 与 `src/ink/`;`src/agent/` 也不 import `src/channel/`。唯一例外:`src/channel/sanitize.ts → src/ink/stringWidth.ts` |
| `src/backends/<x>/` | 不 import 其他后端目录;后端之间共用的代码放 `src/backends/shared/`,中立领域代码放 `src/agent/` 或 `src/channel/` |
| `src/backends/shared/` | 后端无关的共享件(原子写、渠道令牌库);任何后端都可 import。它自己不 import scoped(厂商)包、具体后端目录与 `src/dsh-adapter/` |
| Codex 后端(`src/backends/codex/`) | 驱动用户安装的 `codex` 二进制,不依赖 Codex npm 包;本地 daemon 的 stdio proxy 用通用 `ws` 处理 WebSocket 帧,协议类型由 `scripts/codex-protocol-sync.mjs` 生成入库;`package.json` 不得出现 `@openai/codex*`(`verify:codex-contract`) |
| UI 层(`screens/`、`components/`、`hooks/`、`ink/`) | 不 import `src/backends/`;从 `src/dsh-adapter/` 只取类型,运行期经 facade(`src/dsh-adapter/types.ts` 的类型 re-export、`channel.ts`/`plugin.ts` 提供的服务)接触上游。存量值 import 登记在 `scripts/adapter-boundary.allowlist.json`,只减不增 |
| `native.dsh` | 只允许 `src/dsh-adapter/` 内访问 |
| `native.codex` | 只允许 `src/backends/codex/` 内访问 |
| `'@deepseek-ai/…'` 字符串字面量 | 只在 `src/dsh-adapter/` 内出现(运行期拼出来交给 `createRequire` / `import()` 的说明符也算) |
| 宿主专属模块(`host-contract.ts` 的 `HOST_MODULES`,cordis 除外,含 `@deepseek-ai/dsh` 本身) | 任何地方不得值 import;只由 `src/dsh-adapter/host-dsh.ts` 按宿主 realpath 动态加载,说明符只写在 `host-contract.ts`;`host-dsh.ts` 对 `@deepseek-ai/*` 只能 `import type`;`host-contract.ts` 只给 `host-dsh.ts` 与 `contract.ts` import |

### 后端 manifest

`src/backends/<id>/manifest.ts` 是后端对宿主、UI 与门禁的**静态声明**,纯数据:
除 `import type` 外只允许 import 自己目录内无运行时依赖的版本常量(唯一登记例外:
`backends/claude/manifest.ts → contract.ts`),因为构建期索引会静态 import
每个 manifest(每次启动,含只用 DSH 的启动)。字段与语义见
`src/agent/backend-manifest.ts`;六条容易踩的边界:

- **`id`**:`^[a-z0-9][a-z0-9-]{0,31}$`(`-` 之外的分隔符一律不留,`:`
  在 Windows 上做不了 `~/.dsh-tui/backends/<id>/` 目录)。**成员判断**由运行时注册表
  回答——语法合法但没装的 id 与未知值同义(回落 dsh + 告警),见
  `src/dsh-adapter/backend-registry.ts`。
- **`vendorPackages` / `nativeKey`**:门禁的后端作用域规则由这两个字段派生;
  `nativeKey` **缺省即"不使用 native 通道"**,凭空给某个后端补一条规则等于放宽门禁,
  派生结果会与 `scripts/verify-adapter-boundary.ts` 里的期望快照逐字比对。
- **`unloadExport`**:只用于**模块级/进程级资源池**(如 codex 的 app-server hub,
  按设置指纹池化、跨会话复用);会话级资源仍归 `fiber` 的 `session.dispose()`。
  注册表只记"真的加载过"的条目——没加载过的后端不会被 import,也不会被关池。
- **`install`**:**声明式配方**,不是排他特权(Stage B / B-1)。字段是
  `{ executor, specifier, version }`:清单说**装什么、哪个版本**,以及**交给宿主的哪个
  执行器**去装;动作在宿主侧的表里(`src/dsh-adapter/install/`,当前唯一取值
  `pnpm-profile-add`)。注册表在准入处**查表**派生 `RegisteredBackend.installable`
  ——"这个条目有没有安装面"因此是声明与宿主能力的合取,不再是谁的 id。声明了宿主不认识的
  执行器**不抛错**:按"没有安装面"处理(那张 dim 行退回落检测自己的 hint,不长出一个按不动
  的按钮)。`install` 缺省也是一等公民:codex 依赖用户自己的 `codex` 二进制,没有包可装 ——
  它要的是"缺什么、怎么补"的呈现,不是一个装不了任何东西的按钮。
  选择器的 `sdk-install` 浮层带**后端 id**,安装面在打开时按 id 现查——装的是用户点的那一行
  (Stage A 的做法相反:浮层不带 id、`backends.ts` 静态 import 那一个安装器,于是任何别的
  后端都只能装成 Claude 的 SDK)。
- **公开子集与 in-tree 私有项**:manifest 是 `tui.dsh/v1alpha1#Backend` 公开声明的
  **超集**。`inTree`、`alwaysAvailable`、`nativeKey`、`vendorPackages`、`backendExport`
  与 `label.kind === 'key'` 是仓内私有项,不进公开面;`backendContributionOf()`
  (`src/dsh-adapter/backend-contribution.ts`) 是唯一的投影方向——剥掉私有项、把 key
  标签展开成字面量、缺省声明投影成空列表,结果必须过 `validateBackendSpec()`
  (`tui-profile/protocols/tui-contributions.js`)。`scripts/verify-backend-contribution.ts`
  断言三个内建后端都投影得干净(私有键零泄漏)、投影是纯函数。
  `capabilities` 与 `grants` 是这条公开面上的两个新字段:前者必须覆盖运行期
  `AgentSession.capabilities` 实际返回的键集,后者只取宿主权限词表
  (`registry/permissions-0.1.json`);两者的未知名字一律**降级不拒绝**,判定是
  `src/dsh-adapter/backend-admission.ts` 的 `backendAdmission()`(已知权限名无授权 →
  注册但不进 picker)。声明文本按不可信输入净化。族语义见
  [说明 0009](tui-profile/notes/0009-backend-contribution.md)。
- **恢复语义(B-2a fail-closed)**:后端自己的 `lastSession()` 只归自己。启动恢复只
  针对所选后端,恢复目标绑定后端身份,裸 `--resume` 只查**该后端自己的** `lastSession`;
  后端不可用、没有上次会话、指定会话不存在一律明确报错并**非零退出**
  (`src/kernelPrefs.ts` 的 `resolveResumeTarget()`),不回落、不恢复别的后端的上次会话、
  不自动新建会话。唯一例外是安全模式的"重试正常启动"(一次性 env
  `DSH_TUI_RESUME_RETRY`,撤销降级为告警 + 冷启动),它不进协议;`lastSession` 接口与
  恢复目标的传递方式也不在协议内。

新增一个后端 = 新建 `src/backends/<id>/`(`manifest.ts` + 实现),再把
`pnpm compile` 重新生成的 `src/dsh-adapter/backends.generated.ts` 一并提交;
`kernelPrefs.ts` 与 `backends.ts` 不用改,目录与身份回归也都按 ID 取项(新增目录
不必同步它们)。唯一的例外是**边界快照**:声明了非空 `vendorPackages` 或
`nativeKey` 的后端,派生规则会与 `scripts/verify-adapter-boundary.ts` 的
`EXPECTED_*` 逐字比对,必须把快照与本文档一并更新(不声明这两项的后端无需改动)。
声明 `install` 时只需保证 `executor` 拼的就是宿主那个取值:`verify-backend-registry`
会断言"声明了配方 ⟺ 这个条目可装",拼错等于悄悄丢掉自己的向导。
那份索引**入库**是有意的:CI 的测试组与
`gates` 复用构建产物、不跑 `compile`,gitignore 的文件在那边不存在,
而注册表要从 `src/` import 它(`verify-backend-registry` 会断言它与磁盘上的
manifest 一致,过期即红)。

门禁:`pnpm run verify:boundary`(`scripts/verify-adapter-boundary.ts`,扫描全部源码的
真实 import,越界即失败;已挂进 `build`)。多后端的分层见
[docs/agent-backend-design.md](docs/agent-backend-design.md)。

## 上游契约

- 校验版本线:主 `0.2.0-rc.2`,兼容 `0.2.0-rc.1` / `0.1.7-rc.2` / `0.1.7-rc.1` / `0.1.5-rc.1` / `0.1.5-alpha.2` / `0.1.5-alpha.1` / `0.1.3-alpha.2` / `0.1.2-rc.1` / `0.1.2-alpha.5` / `0.1.2-alpha.4` / `0.1.2-alpha.3` / `0.1.1-rc.2` / `0.1.1-rc.1` / `0.1.0-rc.8` / `0.1.0-rc.7` / `0.1.0-rc.6`
  (`src/dsh-adapter/contract.ts` 的 `UPSTREAM_VALIDATED_VERSIONS`;特性门控用
  `installedMeetsVersion(pkg, 'x.y.z-<alpha|beta|rc>.n')` 跨家族、跨预发布通道比较,老安装上优雅降级)
- peer 范围:`^0.1.0-rc.6 || ^0.1.1-rc.1 || 0.1.2-alpha.3 || 0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.2 || 0.1.5-alpha.1 || 0.1.5-alpha.2 || 0.1.5-rc.1 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2`(新命名的 registry/PTC 包仅声明 `0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2`;契约外版本启动时打 drift 警告;新增预发布一律用精确 OR,不用 caret)
- 白名单包:blessed list(harness 包按完整版本号校验,框架包 cordis/schemastery 按 major 校验)
- 启动时:检测到 drift 打 warning;CI 上 `pnpm run verify:contract` 直接失败

## 独立入口的宿主契约

本包入口(`src/dsh-adapter/host-entry.ts`)在进程内加载 PATH 上 `dsh` 的安装
(docs/standalone-host-design.md),契约单一来源是
`src/dsh-adapter/host-contract.ts`:

- **依赖**:`host-dsh.ts` 取类型的 `dsh-app-boot`、`dsh-cmdline`、`dsh-home-paths`、
  `dsh-http-proxy`、`dsh-launch-environment`(`HOST_TYPE_PACKAGES`)是 optional peer + dev、
  进 blessed 清单。宿主 CLI `@deepseek-ai/dsh` **不是**依赖(它的依赖树是整个 CLI):
  `host-dsh.ts` 本地声明入口读取的 `profile-boot` 三个导出。运行期**不**从本包解析
  它们:入口按宿主 realpath 加载宿主自己的副本(profile 由宿主 dsh 安装、cordis 必须单实例),
  所以它们也在运行期可缺的集合里(缺席不算 drift)。新包范围只写已核对的 `0.2.0-rc.2`
  (`dsh-home-paths` 沿用家族宽范围)。`cordis-plugin-loader` 只当 `unknown` 用,不声明 peer。
- **能力探测**:`HOST_MODULES` 列出 8 个宿主模块与入口读取的每个导出。`loadHostDsh` 逐项检查,
  缺模块 / 缺导出即抛出点名原因,入口回退(DSH 内核交给 `dsh --profile`,Claude 内核无宿主解析)
  并把原因写 stderr 与界面通知。`host-dsh.ts` 用 `Pick<typeof 宿主模块, 契约导出名>` 取类型
  (`profile-boot` 除外,本地声明),契约写了 pinned 宿主不存在的导出时编译失败。
- **复刻面**:`HOST_REPLICAS` 列出入口复刻的上游符号,`host-replica.snapshot.json` 记录在
  `HOST_REPLICA_VERSION` 上声明各符号的 lib 文件的整文件 sha256(信号偏粗:该文件任何改动都要求复核);
  刻意的偏差逐条记在 `HOST_DEVIATIONS`(同文件),审查复刻改动时以它为准。
- **门禁**:`verify:contract` 额外跑 `scripts/verify-host-contract.ts`(覆盖面见其头注释):假宿主回退
  在 CI 上总跑;生产探测与复刻指纹只在有已装宿主(PATH 上的 `dsh` 或 `DSH_TUI_CONTRACT_DSH`)时跑。
  移动版本线时在装有该版本 `dsh` 的机器上复核、把变化搬进 `host-dsh.ts`,再用 `--snapshot` 重写快照。

## Patch Surface

`cordis.patch.yml` 里对官方行的干预已快照到 `patch-surface.snapshot.json`:

- **disabled overrides**:23 行。其中 22 行恒定禁用；`command-goal` 在新 registry
  或旧 shipped standard preset 自带该命令时禁用。0.1.7 的 host PTC/workflow
  服务由 base 提供，模型可见的工具仍由 preset 控制；与 web-app 的差异见快照。
- **config overrides**:8 行(原有 6 行加 session-telemetry-otel /
  plugin-package-inventory-deepseek),后两行保持 TUI 的隐私默认
- **inserts**:19 行(dsh-tui、working-activity、内置 OAuth 入口 dsh-tui-auth、DeepSeek 账号回调的 dsh-tui-webserver、六个插件互通行,以及
  dsh-tui-storage、dsh-tui-storage-json、dsh-tui-storage-domain、
  dsh-tui-workspace、dsh-tui-code-runtime、dsh-tui-subagent-model-selection-settings、
  dsh-tui-agent-presets、dsh-tui-agent-preset-registry、dsh-tui-cordis-host-runner)。这些 host-plane 行使用 dsh-tui 作用域 id,
  并在检测到官方同 id/name 行已存在时自行 disabled,因此可安全共存。
  `dsh-tui-webserver` 会探测 webserver 包及已启用的宿主账号服务行；缺少账号服务的旧宿主禁用该行，
  新宿主在 TUI-only profile 下监听 loopback 动态端口，并在 Web 混合 profile 中让位官方 `webserver`。
  `dsh-tui-subagent-model-selection-settings` 还直接探测自己的包子路径,
  不依赖可被用户禁用的 inventory 行;预设 roster 在 rc.2 显式恢复 dsh CLI
  roots,0.1.2 线则省略 roots 并使用包内 `includeShippedRoot`
  (`dsh web` 不再 `duplicate loader entry id`)。0.1.7 禁用旧目录 roster/code-runtime
  行，经官方 registry 注册 web-app 导出的 standard/ptc/minimal/cordis bundle
  与包内 liangshen；已有 profile preset 声明优先，不重复注册。

上游发版后如果 patch 面变化,`pnpm run verify:patch-surface` 会在 CI 先爆;
确认差异后执行 `node --import tsx/esm scripts/verify-patch-surface.ts --snapshot`
重新生成快照。`pnpm run verify:web-coexistence` 会把 dsh-tui patch 与官方
web-app patch 按 include 语义合成一遍,直接拦截 loader entry id 复用;
设置 `DSH_HARNESS_SOURCE_ROOT` 指向官方源码 checkout 时还会额外校验其 base + web patch（CI 的 `alpha-compat` lane 总是设置）。

## 升级流程

- dev 树由 `pnpm-workspace.yaml` 的 overrides 钉在 `0.2.0-rc.2`,
  CI `alpha-compat` lane 还对同版上游 tag 的固定 SHA 做源码类型与 patch 合成校验。
  旧 SQLite 迁移工具的依赖闭包单独锁在 `vendor/sqlite-island`。
- 主验证线移动时 `verify:contract` 会要求复核独立入口的复刻面(见「独立入口的宿主契约」),
  `HOST_REPLICA_VERSION` 与主验证线一起改。
- `contract.ts` 是唯一真源:主验证线原地替换、不累积;`package.json` 的
  peer/dev 范围、CI 钉住的上游 SHA、校验脚本里的版本常量都只是它的镜像,
  必须同一次改齐(位置见 [docs/contributing.md](docs/contributing.md) 跨文件清单)。
- 上游删掉的包跟着删,不留半悬空的依赖;patch-surface 快照按 web-app 版本
  追加、保留历史。
- 业务 UI 代码原则上零修改;若最新预发布源码 tsc 报错,修复落在 `src/dsh-adapter/`
  内,优先形状探测而非版本门,老安装上优雅降级。

## 0.1.7 适配接缝

`compat/shell.ts` 优先使用 `execute(resolve(spec)).result()`，旧 host 回落 `run`，
失败不重试执行。`compat/messages.ts` 读取 V4 嵌套消息及旧事件载荷，不改变持久化
序列与 call-ID。Agent 创建/恢复始终等待异步生命周期完成。

Loader 行只调度 TUI runtime：Host 加载完成后由 Cordis 子插件启动，避免 preset
诊断等待 Loader 时反过来等待自身。启动失败经终端清理路径非零退出；volatile
Config 仍由原 Loader 行拥有，runtime 的设置监听显式使用该 owner。

`compat/settings.ts` 在新 host 消费 Config 的 volatile 字段与 Loader 更新事件，
旧 host 保留 scope 注册/watch。新 host 的设置 namespace 使用 Config owner 的
Loader 行 ID；若实际 Config 缺少 volatile 字段，启动报错并提示更新 DSH、重装
profile 依赖（需 schemastery >= 3.18.3），不回落到不可编辑的设置页。
设置由 DSH 写入当前 profile 配置；TUI 不维护第二份
设置文件。历史 Session 转换及子会话 catalog 仍交给官方 format catalog。
