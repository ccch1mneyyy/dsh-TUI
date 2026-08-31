# Adapter 边界与上游契约

## 边界规则

官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import。
UI 层(`screens/`、`components/`、`ink/`、`hooks/`、`utils/`、`cc/`)
一律通过 adapter 的 facade(`src/dsh-adapter/types.ts` 的类型 re-export、
`channel.ts`/`plugin.ts` 等运行期服务)间接接触上游。

门禁:`pnpm run verify:boundary`(扫描全部源码,发现越界 import 即失败;
已挂进 `build`)。

## 上游契约

- 校验版本线:主 `0.1.2-rc.1`,兼容 `0.1.2-alpha.5` / `0.1.2-alpha.4` / `0.1.2-alpha.3` / `0.1.1-rc.2` / `0.1.1-rc.1` / `0.1.0-rc.8` / `0.1.0-rc.7` / `0.1.0-rc.6`
  (`src/dsh-adapter/contract.ts` 的 `UPSTREAM_VALIDATED_VERSIONS`;特性门控用
  `installedMeetsVersion(pkg, 'x.y.z-<alpha|beta|rc>.n')` 跨家族、跨预发布通道比较,老安装上优雅降级)
- peer 范围:`^0.1.0-rc.6 || ^0.1.1-rc.1 || 0.1.2-alpha.3 || 0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1`(契约外版本启动时打 drift 警告;0.1.2 预发布用精确 OR,不用 caret)
- 白名单包:blessed list(harness 包按完整版本号校验,框架包 cordis/schemastery 按 major 校验)
- 启动时:检测到 drift 打 warning;CI 上 `pnpm run verify:contract` 直接失败

## Patch Surface

`cordis.patch.yml` 里对官方行的干预已快照到 `patch-surface.snapshot.json`:

- **disabled overrides**:24 行。其中 23 行恒定禁用；`command-goal` 仅在
  `dsh-agent-presets` 的 shipped standard preset 实际自带该命令时禁用,
  因而 0.1.2 线与 web-app 对齐,旧 0.1.1-rc.2 仍保留 host `/goal`;web-app 另有 `hmr`
- **config overrides**:8 行(原有 6 行加 session-telemetry-otel /
  plugin-package-inventory-deepseek),后两行保持 TUI 的隐私默认
- **inserts**:17 行(dsh-tui、working-activity、dsh-tui-auth、六个插件互通行,以及
  dsh-tui-storage、dsh-tui-storage-json、dsh-tui-storage-domain、
  dsh-tui-workspace、dsh-tui-code-runtime、dsh-tui-subagent-model-selection-settings、
  dsh-tui-agent-presets、dsh-tui-cordis-host-runner)。这些 host-plane 行使用 dsh-tui 作用域 id,
  并在检测到官方同 id/name 行已存在时自行 disabled,因此可安全共存。
  `dsh-tui-subagent-model-selection-settings` 还直接探测自己的包子路径,
  不依赖可被用户禁用的 inventory 行;预设 roster 在 rc.2 显式恢复 dsh CLI
  roots,0.1.2 线则省略 roots 并使用包内 `includeShippedRoot`
  (`dsh web` 不再 `duplicate loader entry id`)

上游发版后如果 patch 面变化,`pnpm run verify:patch-surface` 会在 CI 先爆;
确认差异后执行 `node --import tsx/esm scripts/verify-patch-surface.ts --snapshot`
重新生成快照。`pnpm run verify:web-coexistence` 会把 dsh-tui patch 与官方
web-app patch 按 include 语义合成一遍,直接拦截 loader entry id 复用;
当相邻 `deepseek-harness` 源码存在时还会额外校验其 base + web patch。

## 升级流程

- 安装基线与验证线分离:dev 树由 `pnpm-workspace.yaml` 的 overrides 钉在
  0.1.1-rc.2,最新 0.1.2 预发布不装进来,而是由 CI `alpha-compat` lane 对上游 tag 的源码做
  类型与 patch 合成校验。bump 不是 `pnpm add`,是改契约声明。
- `contract.ts` 是唯一真源:主验证线原地替换、不累积;`package.json` 的
  peer/dev 范围、CI 钉住的上游 SHA、校验脚本里的版本常量都只是它的镜像,
  必须同一次改齐(位置见 [docs/contributing.md](docs/contributing.md) 跨文件清单)。
- 上游删掉的包跟着删,不留半悬空的依赖;patch-surface 快照按 web-app 版本
  追加、保留历史。
- 业务 UI 代码原则上零修改;若最新预发布源码 tsc 报错,修复落在 `src/dsh-adapter/`
  内,优先形状探测而非版本门,老安装上优雅降级。
