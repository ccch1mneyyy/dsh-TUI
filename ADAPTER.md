# Adapter 边界与上游契约

## 边界规则

官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import。
UI 层(`screens/`、`components/`、`ink/`、`hooks/`、`utils/`、`terminal-utils/`)
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

## Adapter-v2 P4-P6（本地分支状态）

- **P4 Channel Port/投影层**:新增 `projection / actions / state /
  plugins / transcript` 五个 Host Port 与 `src/adapter/channel/*` 拆分模块;
  live Channel 仍为实现真源。L4 已物理提取中性 types、唯一 live/replay projector、
  input FIFO/staging、binding cell、session tree、notifications、emitter/settings 等模块,
  生产根改供受保护的进程内 ChannelUi,
  非 wire snapshot；kernel 未 mount 时使用同一 policy factory 的本地 capability,
  已绑定 kernel 后禁止降级回退。新增 `verify:channel-ui` 验证嵌套句柄和生命周期。
  ChannelUi 及可达数据契约由 `adapter/ports/channel-*.ts` 拥有，原位置 re-export；
  ports 不依赖 adapter/React，上游事件经 RawTrajEvent 边界读取，scene 由 renderer outlet 注入。
  只读数据为脱离后端的冻结投影，嵌套回调捕获生命周期；shadow renderer 使用本地观察订阅。
  当前 L4 本轮将 composition root 收敛为约 1,000 行：typed readiness cell 一次性安装完整
  action surface，未安装或 owner 已释放时明确抛错；detached handles 与 context-warning/
  pending bookkeeping 分别归属内聚模块。owner 从最早资源获取进入统一撤销漏斗，清理逐项
  尝试并保留清理失败；Host Port 以 registration identity 固定一次注册，同对象重注册、owner
  release 与 A → B → A 都会撤销 retained authority。L4 已完成独立集中审查、定向修复和
  本地自动化验收（build/package、Channel UI 58/58、CI3）；真实 TTY 与长期压力基准未测。
  L5 Deferred，未宣称完整 RFC state。完成项与限制见 [L4/L5 路线图](docs/roadmap-adapter-channel-l4-l5.md)。
- **P5 Channel Provider/Consumer**:实现 `tui.dsh/v1alpha1#Channel`
  协议包络与校验;`runChannelReplay` 支持录制 snapshots 与真实 DSH
  sessionEvents 的 **minimal transcript replay**(不宣称完整 RFC state);
  未知 method 失败、features 必须显式声明且有证据、重复 features 先拒、
  未知非 ignorable event fail-closed、method handler 仅在 replay isolation 内执行,
  replay provider 不解析 selector(显式 unsupported);生产 driver 已真正跑
  open/subscribe/invoke/close;新增 `verify:adapter-channel-conformance`。
- **P6 compat 清理**:删除 `src/plugin-spec/*`、`src/dsh-adapter/{grants,
  host-descriptor}.ts` shim;彻底移除 `admissionCompat` 与
  `mountedAdmissionCoordinates`;`src/plugin-host.ts` 保留为规范化公开面;
  `verify:compat-removal` 扫描 `src/`/`scripts/`/`bin/`/生成 `lib/` 与
  package export 图,`verify:package` 拒绝 tarball 旧 shim;长期兼容别名已标注。
- 所有 adapter 门禁已并入 `npm run verify:build`。

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
