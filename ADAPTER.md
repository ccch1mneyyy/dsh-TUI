# Adapter 边界与上游契约

## 边界规则

官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import。
UI 层(`screens/`、`components/`、`ink/`、`hooks/`、`utils/`、`cc/`)
一律通过 adapter 的 facade(`src/dsh-adapter/types.ts` 的类型 re-export、
`channel.ts`/`plugin.ts` 等运行期服务)间接接触上游。

门禁:`pnpm run verify:boundary`(扫描全部源码,发现越界 import 即失败;
已挂进 `build`)。

## 上游契约

- 校验版本线:`0.1.0-rc.6`(`src/dsh-adapter/contract.ts`)
- 白名单包:blessed list(harness 包按 rc 号校验,框架包 cordis/schemastery 按 major 校验)
- 启动时:检测到 drift 打 warning;CI 上 `pnpm run verify:contract` 直接失败

## Patch Surface

`cordis.patch.yml` 里对官方行的干预已快照到 `patch-surface.snapshot.json`:

- **disables**:与官方 `@deepseek-ai/dsh-web-app` 自己的 patch **完全一致**(24 行,
  preset 所有权迁移的结构性禁用,官方 web 也这么做),TUI 特有的禁用为 0
- **config overrides**:6 行(system-prompt / llm-deepseek / agent-loop /
  sandbox-policy / approval / session-persistence-jsonl),全部是表面发行配置
- **inserts**:4 行(dsh-tui、working-activity、agent-presets、cordis-host-runner;
  后两个与官方 web-app 共用)

上游发版后如果 patch 面变化,`pnpm run verify:patch-surface` 会在 CI 先爆;
确认差异后执行 `node --import tsx/esm scripts/verify-patch-surface.ts --snapshot`
重新生成快照。

## 升级流程

1. `pnpm add` 各 `@deepseek-ai/*` 到新 rc 版本
2. `pnpm run build`(typecheck + 三道门禁)
3. 若 patch-surface 或 contract 报警:审查差异,更新 `contract.ts` 校验版本 /
   重新生成快照
4. 业务 UI 代码原则上零修改;若需要改,改动必须落在 `src/dsh-adapter/` 内
