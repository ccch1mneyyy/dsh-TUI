# Adapter 边界与上游契约

## 边界规则

官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import。
UI 层(`screens/`、`components/`、`ink/`、`hooks/`、`utils/`、`cc/`)
一律通过 adapter 的 facade(`src/dsh-adapter/types.ts` 的类型 re-export、
`channel.ts`/`plugin.ts` 等运行期服务)间接接触上游。

门禁:`pnpm run verify:boundary`(扫描全部源码,发现越界 import 即失败;
已挂进 `build`)。

## 上游契约

- 校验版本线:主 `0.1.2-alpha.2`,兼容 `0.1.1-rc.2` / `0.1.1-rc.1` / `0.1.0-rc.8` / `0.1.0-rc.7` / `0.1.0-rc.6`
  (`src/dsh-adapter/contract.ts` 的 `UPSTREAM_VALIDATED_VERSIONS`;特性门控用
  `installedMeetsVersion(pkg, 'x.y.z-<alpha|beta|rc>.n')` 跨家族、跨预发布通道比较,老安装上优雅降级)
- peer 范围:`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2`(契约外版本启动时打 drift 警告)
- 白名单包:blessed list(harness 包按完整版本号校验,框架包 cordis/schemastery 按 major 校验)
- 启动时:检测到 drift 打 warning;CI 上 `pnpm run verify:contract` 直接失败

## Patch Surface

`cordis.patch.yml` 里对官方行的干预已快照到 `patch-surface.snapshot.json`:

- **disabled overrides**:24 行。其中 23 行恒定禁用;`command-goal` 仅在
  `dsh-agent-presets` 的 shipped standard preset 实际自带该命令时禁用,
  因而 alpha.2 与 web-app 对齐,rc.2 仍保留 host `/goal`;web-app 另有 `hmr`
- **config overrides**:8 行(原有 6 行加 session-telemetry-otel /
  plugin-package-inventory-deepseek),后两行保持 TUI 的隐私默认
- **inserts**:17 行(dsh-tui、working-activity、dsh-tui-auth、六个插件互通行,以及
  dsh-tui-storage、dsh-tui-storage-json、dsh-tui-storage-domain、
  dsh-tui-workspace、dsh-tui-code-runtime、dsh-tui-subagent-model-selection-settings、
  dsh-tui-agent-presets、dsh-tui-cordis-host-runner)。这些 host-plane 行使用 dsh-tui 作用域 id,
  并在检测到官方同 id/name 行已存在时自行 disabled,因此可安全共存。
  `dsh-tui-subagent-model-selection-settings` 还直接探测自己的包子路径,
  不依赖可被用户禁用的 inventory 行;预设 roster 在 rc.2 显式恢复 dsh CLI
  roots,alpha.2 则省略 roots 并使用包内 `includeShippedRoot`
  (`dsh web` 不再 `duplicate loader entry id`)

上游发版后如果 patch 面变化,`pnpm run verify:patch-surface` 会在 CI 先爆;
确认差异后执行 `node --import tsx/esm scripts/verify-patch-surface.ts --snapshot`
重新生成快照。`pnpm run verify:web-coexistence` 会把 dsh-tui patch 与官方
web-app patch 按 include 语义合成一遍,直接拦截 loader entry id 复用;
当相邻 `deepseek-harness` 源码存在时还会额外校验其 base + web patch。

## 升级流程

1. `pnpm add` 各 `@deepseek-ai/*` 到新预发布版本
2. `pnpm run build`(typecheck + 三道门禁)
3. 若 patch-surface 或 contract 报警:审查差异,更新 `contract.ts` 校验版本 /
   重新生成快照
4. 业务 UI 代码原则上零修改;若需要改,改动必须落在 `src/dsh-adapter/` 内
