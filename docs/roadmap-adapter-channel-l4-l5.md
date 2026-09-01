# Adapter 后续大项 Roadmap：L4 Channel 物理拆分 / L5 完整 RFC State

> 状态：Planned（不阻塞当前 Adapter PR）
> 当前 Adapter 重构 P2-P6 已通过红队 A。本文档记录两个尚未完整完成、需要后续专门推进的大项。

---

## L4：`channel.ts` 物理拆分与生产 UI 全量迁移

### 目标
- 将当前约 7600 行 `src/dsh-adapter/channel.ts` 按垂直面真正物理拆分：
  - `projection`
  - `actions`
  - `state`
  - `plugins`
  - `transcript`
  - 以及其他必要子模块。
- 让生产 UI / Channel 内部动作全部经 `HostFacade.channel` 执行，不再保留“新 Port 平行存在、生产仍走原生 Channel”的双轨状态。
- 完整闭环 shadow / effect / owner / lifecycle 边界。

### 当前已完成
- 已新增 `src/adapter/channel/*` 投影层、Provider/Consumer、HostChannelPort 与 channel driver。
- `plugin.ts` 核心 `notify` / 初始 `submit` 已走 `HostFacade.channel`。
- shadow 模式下禁止原生回退；facade 缺失/拒绝时 dropped。
- 文档已诚实说明当前为部分迁移。

### 收益
- 消除巨石文件，降低架构腐化与评审成本。
- 让生产真实路径与 live / shadow / 权限 / 诊断使用同一套 Port 语义。
- 减少新增能力时对核心交互文件的连锁修改。

### 风险
- 涉及 TUI 核心交互，回归面大。
- 需要大量真实生产装配测试与红队多轮复验。
- 建议作为独立 PR / 多阶段推进，不塞进当前 Adapter PR。

### 里程碑
1. 拆分纯数据结构与状态投影；
2. 拆分 actions / notify / submit / steer / cancel；
3. 拆分 plugins / transcript；
4. 生产 UI 全量接入 HostFacade.channel；
5. 红队复验并更新文档。

---

## L5：完整 RFC 0007 Channel State 投影

### 目标
- 将 `session-projection` 从当前 minimal transcript replay 提升为完整 `tui.dsh/v1alpha1#Channel` state 投影。
- 补齐 RFC 0007 要求的状态字段：
  - usage
  - context
  - pending input
  - model / mode / preset
  - settings section
  - scene
  - diagnostic
  - trace
  - 以及其他需要随 Channel snapshot 发布的状态。

### 当前已完成
- 已增加可选 meta 字段：model、mode、agentPreset、settingsSections、scene、diagnostic、trace、context、pending。
- 已从 `assistant/message.usage` 提取 `usage`，从 `request/context` 提取 `context`。
- 保持诚实定位：仍为 minimal transcript replay，不宣称完整 RFC 0007 conformance。

### 收益
- 使 Channel Provider-Consumer 真正符合协议，可供外部消费者/插件可靠使用。
- 提高 replay 保真度，能完整还原真实 TUI / 会话状态。
- 为多前端、远程 Channel 互操作打基础。

### 风险
- 需要与 `dsh-ecosystem-spec` / `dsh-std` 规范对齐，可能跨仓库协调。
- 当前无外部消费者强依赖，短期用户收益有限。

### 里程碑
1. 确定 RFC 0007 完整 state 字段清单；
2. 从 DSH session / settings / scenes / diagnostics 建立真实投影；
3. conformance 使用官方完整 fixture；
4. 更新文档，移除 “minimal” 限制；
5. 红队复验。

---

## 跨仓库待同步（L6 已生成补丁）

- `docs/adapter-cross-repo-sync.patch` 已准备好，应用于 `dsh-ecosystem-spec` 仓库：
  - `docs/plugin-admission-and-development.md`
  - `adapters/dsh-tui-v0.15.md`
  - 将 `src/plugin-spec/*` 更新为 `src/adapter/standard/*`。
