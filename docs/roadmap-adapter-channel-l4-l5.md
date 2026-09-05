# Adapter 后续大项 Roadmap：L4 Channel 物理拆分 / L5 完整 RFC State

> 状态：L4 第二阶段实施中，待独立审查；L5 Planned。
> 本文区分已落地代码与仍阻塞完成的工作，不将局部迁移等同于 L4/L5 完成。

---

## L4：`channel.ts` 物理拆分与生产 UI 全量迁移

### 目标
- 将 PR #705 基线约 9,138 行 `src/dsh-adapter/channel.ts` 按垂直面真正物理拆分：
  - `projection`
  - `actions`
  - `state`
  - `plugins`
  - `transcript`
  - 以及其他必要子模块。
- 让生产 UI / Channel 内部动作全部经 `HostFacade.channel` 执行，不再保留“新 Port 平行存在、生产仍走原生 Channel”的双轨状态。
- 完整闭环 shadow / effect / owner / lifecycle 边界。

### 已实施（待独立审查）
- `src/dsh-adapter/channel/` 提取 types、transcript 折叠/恢复、usage 辅助、
  mentions、paths、decision 归一化、permission 投影、preferences、settings/provider
  hosts、input actions 和 emitter。第二阶段继续提取唯一 live/replay projector、input FIFO/staging、
  binding cell、session tree 和 notifications；原入口保留导出，本体仍约 5,000 行，不是薄装配层。
- 生产 React 树及 scene props 改为 `ChannelUi`；命令、嵌套 settings/provider/OAuth、
  job/subagent handles 使用显式 effect 表和捕获生命周期的 guard。bootstrap display
  watcher 与初始输入/通知使用同一 capability；原对象只用于注册及宿主生命周期。
- kernel mount 前或 descriptor-only 组合使用同一 factory 的本地受保护 UI；一旦成功
  绑定 kernel Channel UI，丢失或拒绝不会退回本地 writer。
- 部分内部组合命令改经 `channelCommands`；bare `createChannel` 测试/嵌入接口保留。
- `verify:channel-ui` 覆盖真实 Channel 装配、shadow 命令拒绝、嵌套句柄、替换/卸载、
  descriptor-only 组合和流式 emitter 取消；已加入 `verify:build`。

### 完成前阻塞项
- **物理拆分**：session/model/workspace/agent-view actions、activity 和 skills/plugin
  装配仍共享较大闭包；projector 的私有缓存已统一 reset，Agent/handle 写入已集中到 binding cell，
  后续需继续收敛完整 adoption transaction 与域动作模块。
- **生命周期**：已覆盖延迟 input、mention、image staging、decision timer、provider retry、
  prepared handle 及早期 bootstrap 句柄撤销；这不等于全部异步域操作已可取消。
  不可取消的外部存储写只能阻止晚到结果继续发布，不能声称自动回滚。
- **类型与只读边界**：中性 `ChannelUi` 已迁入 ports，自有契约没有反向 import 例外；
  普通读取脱离后端并冻结，workspace 递归回调和 settings conversion 调用时检查 lifetime。
  此为 Channel 出口约束而非进程级插件沙箱；丰富进程内类型也不等于 JSON wire state。
- **shadow 呈现**：实际 Chat + 生产 capability 在两种 shadow 下挂载、订阅本地观察并禁止
  自动 recap；未放宽上游 Host Port subscribe 权限。真实 TTY 全流程尚未手工演练。
- 原七方法 Port 的 lazy root lookup/返回句柄仍需统一到最终 owner-bound 域 ports。
- 保留 L5 minimal replay 限制；本阶段不更新协议或子模块。

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
