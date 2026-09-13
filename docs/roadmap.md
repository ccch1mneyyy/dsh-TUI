# dsh-TUI Roadmap

> 本文档是长期方向；具体任务的实时状态应以 GitHub Roadmap tracker 为准。

## Goal

建设一个可靠、可恢复、可观察、可扩展的 DeepSeek Harness 终端工作台，帮助用户完成长时间的编码和 Agent 工作流。

## Current Focus

1. 建立公开、可追踪的社区协作流程。
2. 提升长会话、恢复、错误处理和终端兼容性的可靠性。
3. 把 DSH 的 Agent、session、model、preset、permission、workspace 和 plugin 能力呈现清楚。
4. 稳定扩展接缝，让社区可以构建主题、命令、场景、状态行和工作区插件。
5. 改善安装、诊断、文档、发布和贡献者体验。

## Non-goals

- 不以功能数量或外部产品的逐项对应作为项目目标。
- 不在 TUI 中重复实现 DSH 已经拥有的 Agent、session、sandbox 或策略服务。
- 不在公开 API 尚未稳定前大规模扩展插件数量。
- 不把动画、装饰或没有明确用户场景的功能列入关键路径。
- 不把 Star、PR 数量或 commit 数量当作主要进展指标。

## Status Legend

| 状态 | 含义 |
| --- | --- |
| `✅ Done` | 已合并并完成适用验证 |
| `🚧 In progress` | 已有负责人，正在实现或验证 |
| `🟡 Design` | 方向已确认，范围仍在讨论 |
| `⚪ Not started` | 已确认但尚未开始 |
| `🧪 Experimental` | 实验能力，不承诺稳定兼容 |
| `⏸ Deferred` | 暂缓，不在当前阶段关键路径 |
| `❌ Rejected` | 已讨论并决定不做 |

## Phase 0: Community Baseline

**目标：** 让公开工作都有入口、负责人、跟踪 Issue 和退出条件。

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| 发布社区管理框架 | Maintainers | - | - | 🚧 In progress | - | 框架文档合入并链接到文档索引 |
| 建立公开 Roadmap tracker | Maintainers | TBD | - | 🟡 Design | 社区管理框架 | 所有当前阶段任务都有状态和跟踪入口 |
| 统一 proposal、bug、Q&A 和 show-and-tell 分流 | Maintainers | TBD | - | ⚪ Not started | Roadmap tracker | 新用户能从仓库入口找到正确渠道 |
| 建立阶段总结和 Future Work 规则 | Maintainers | TBD | - | ⚪ Not started | Roadmap tracker | 阶段结束时能区分完成、延期和拒绝事项 |

## Phase 1: Reliability and Recovery

**目标：** 让用户可以稳定启动、工作、暂停、恢复并诊断问题。

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| 长会话稳定性与内存边界 | TBD | TBD | - | ⚪ Not started | Phase 0 | 聚焦回归覆盖长 transcript、流式和滚动 |
| session resume / rewind / fork 的错误提示 | TBD | TBD | - | ⚪ Not started | Phase 0 | 失败场景有明确原因和恢复路径 |
| `/doctor` 与模型、preset、permission 诊断 | TBD | TBD | - | ⚪ Not started | Phase 0 | 常见配置失败可在 TUI 内定位 |
| Windows Terminal / ConPTY / inline / fullscreen 验证矩阵 | TBD | TBD | - | ⚪ Not started | Phase 0 | 支持矩阵和已知限制公开记录 |
| 重启和异常退出后的终端清理 | TBD | TBD | - | ⚪ Not started | Phase 0 | 成功、失败、中断路径均有回归证据 |

## Phase 2: DSH-Native Workflows

**目标：** 让 DSH 的核心能力在终端里可理解、可操作、可恢复。

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| Agent / model / preset 状态呈现 | TBD | TBD | - | ⚪ Not started | Phase 1 | 用户能确认当前工作所使用的运行配置 |
| permission 与 approval 状态可解释 | TBD | TBD | - | ⚪ Not started | Phase 1 | 权限失败能说明策略、范围和下一步 |
| agent view、subagent 和 background jobs 统一工作流 | TBD | TBD | - | ⚪ Not started | Phase 1 | 后台任务可查看、恢复、停止和识别状态 |
| goals / todos / activity 的一致投影 | TBD | TBD | - | ⚪ Not started | Phase 1 | 状态来自 session/event 真源并有回归覆盖 |
| workspace 切换与 session 关联 | TBD | TBD | - | ⚪ Not started | Phase 1 | 工作区切换行为、持久化和错误路径有文档 |

## Phase 3: Extension Ecosystem

**目标：** 让社区能够在稳定边界内构建可维护的扩展。

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| 稳定 plugin API 与 test-utils 的公开说明 | TBD | TBD | - | 🟡 Design | Phase 2 | 每个公开接缝有稳定级别、示例和验证方式 |
| 主题、命令、场景和状态行插件模板 | TBD | TBD | - | ⚪ Not started | API 文档 | 新作者能从模板完成最小插件 |
| 插件兼容性检查和错误诊断 | TBD | TBD | - | ⚪ Not started | API 文档 | 不兼容插件能给出明确原因 |
| 生态插件目录和案例收录 | TBD | TBD | - | ⚪ Not started | 插件模板 | 社区插件有统一元数据和展示入口 |

## Phase 4: Documentation and Release Quality

**目标：** 让用户安装、升级、排错和贡献的过程可预测。

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| 安装、升级、恢复和常见故障文档 | TBD | TBD | - | ⚪ Not started | Phase 1 | 新用户路径与实际命令一致 |
| 支持平台和上游版本兼容矩阵 | TBD | TBD | - | ⚪ Not started | Phase 1 | 发布前能确认支持范围 |
| release checklist、变更摘要和已知限制 | TBD | TBD | - | ⚪ Not started | Phase 0 | 每次发布都有可审查的验证记录 |
| 安全、维护责任和贡献者文档 | TBD | TBD | - | 🚧 In progress | Phase 0 | 社区入口、责任边界和安全渠道清晰 |

## Future Work

以下事项暂不进入当前关键路径，只有在前置阶段稳定后才重新评估：

- 更复杂的远程运行时；
- 大规模官方插件集合；
- 更多终端图形协议和装饰能力；
- 跨前端的统一工作台；
- 超出 DSH 当前能力边界的独立 Agent 服务。

## Update Policy

- Roadmap 状态以 tracking issue 和合并后的验证结果为准。
- 阶段完成时更新本文件的总结和 Future Work。
- 任务范围变化、延期或拒绝时，在对应 Issue 记录原因。
- 团队内部的实现策略、重构计划和暂不公开的技术细节不写入本公开 roadmap。

最后更新：2026-09-07
