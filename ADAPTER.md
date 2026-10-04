# Adapter 边界与上游契约

## 边界规则

厂商包按目录隔离,中立层不碰厂商代码:

| 目录 / 包 | 规则 |
| --- | --- |
| `@deepseek-ai/*` | 只在 `src/dsh-adapter/` 内 import |
| `@anthropic-ai/*` | 只在 `src/backends/claude/` 内 import |
| `@agentclientprotocol/*` | 只在 `src/backends/acp/` 内 import(为将来的 ACP 后端预留,目录尚不存在) |
| `@dsh-std/*` | 只在 `src/adapter/standard/` 与 `src/dsh-adapter/` 内 import |
| `src/agent/`、`src/channel/` | 不 import 厂商包、`src/dsh-adapter/`、`src/backends/` 与 `src/ink/`;`src/agent/` 也不 import `src/channel/`。唯一例外:`src/channel/sanitize.ts → src/ink/stringWidth.ts` |
| `src/backends/<x>/` | 不 import 其他后端目录;共享代码放 `src/agent/` 或 `src/channel/` |
| UI 层(`screens/`、`components/`、`hooks/`、`ink/`) | 不 import `src/backends/`;从 `src/dsh-adapter/` 只取类型,运行期经 facade(`src/dsh-adapter/types.ts` 的类型 re-export、`channel.ts`/`plugin.ts` 提供的服务)接触上游。存量值 import 登记在 `scripts/adapter-boundary.allowlist.json`,只减不增 |
| `native.dsh` | 只允许 `src/dsh-adapter/` 内访问 |

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
