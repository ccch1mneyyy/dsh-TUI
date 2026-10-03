# TUI Profile

> **dsh-TUI 的插件准入与私有协议定义**（仓内 `tui-profile/`）

这是 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 自己的 **Profile**：在
[dsh-std](https://github.com/T-Auto/dsh-std) 公共协议之上，说明「什么样的插件能被
dsh-TUI 装载、进市场」，以及 dsh-TUI 私有的协议坐标（`tui.dsh/*`）。

## 口径（先读这三条）

1. **归属**：它属于 dsh-TUI 仓库，由 dsh-TUI 维护者维护，**随本仓库代码一起修订**。
2. **不是社区 RFC**：这里没有「提交提案 → 征求意见 → 批准」的流程，也没有
   Draft / Experimental / Candidate / Stable 的晋级档位。实现变了就把这里改到与实现
   一致。公共/社区协议语义属于上游 [dsh-std](https://github.com/T-Auto/dsh-std)；
   生态入口与索引在 [`T-Auto/dsh-ecosystem-spec`](https://github.com/T-Auto/dsh-ecosystem-spec)。
3. **用途**：它是 **dsh-TUI 子插件的参考标注**——插件作者、插件市场与评审读它来了解
   当前 dsh-TUI 期望什么、有哪些私有坐标与权限、怎么自检。

本目录是**纯文件**：曾是指向 `T-Auto/dsh-ecosystem-spec` 的 git submodule，现已取消
挂载、改为随本仓库分发的普通文件。`verify:protocol-single-source` 会拒绝它被重新挂成
submodule——profile 必须和代码在同一个提交里演进。

## 从这里开始

| 我想… | 去这里 |
| --- | --- |
| 写一个 dsh-TUI 插件 | [`docs/plugin-admission-and-development.md`](docs/plugin-admission-and-development.md)（唯一整合入口） |
| 看准入检查清单 | [`PLUGIN-ADMISSION-CHECKLIST.md`](PLUGIN-ADMISSION-CHECKLIST.md) |
| 查私有协议坐标与权限 | [`registry/registry-0.15.json`](registry/registry-0.15.json) · [`registry/permissions-0.1.json`](registry/permissions-0.1.json) |
| 看协议定义真源 | [`protocols/`](protocols)（`tui-channel` · `tui-contributions` · `profile-definitions`） |
| 看某个版本的适配细节 | [`adapters/`](adapters)（Adapter Note，不改变协议语义） |
| 看数据结构 | [`schemas/`](schemas) |
| 跑准入校验 | [`conformance/`](conformance) |
| 看设计说明（编号 0001-0008） | [`notes/`](notes) |
| 看实验方向与未决项 | [`proposals/`](proposals) |
| 看归属、边界与修订方式 | [`governance/rules.md`](governance/rules.md) |
| 看历次变更 | [`CHANGELOG.md`](CHANGELOG.md) |

## 目录

```text
tui-profile/
├── README.md / CONTRIBUTING.md / SPEC-WRITING-RULES.md / PLUGIN-ADMISSION-CHECKLIST.md
├── docs/          唯一整合入口：准入、接口与兼容性协定、开发指南、验证清单
├── protocols/     TUI 私有协议定义（JS + d.ts），由 dsh-std core 装载
├── registry/      机器可读注册表：私有坐标、权限、contract profile（含 sha256 钉）
├── schemas/       Host Descriptor / effect ledger / conformance claim 的 schema
├── conformance/   fixtures、requirement matrix 与准入测试 runner
├── adapters/      Adapter Note：某宿主/运行时版本与契约的适配细节
├── notes/         设计说明；编号 0001-0008 是稳定锚点，不是 RFC 流程
├── proposals/     TUI 侧实验方向与未决项
└── governance/    归属、边界与修订方式
```

## 与上游的关系

```text
dsh-std（上游公共协议基座，仓根 vendor/dsh-std 固定 revision）
        ↑ 插件按公共坐标写代码；公共语义在上游定义
TUI Profile（本目录）    dsh-TUI 自己的准入要求 + 私有坐标 tui.dsh/*
        ↑ 读它来写 / 评审 dsh-TUI 子插件
dsh-TUI 子插件与插件市场
```

- 公共语义**不在这里定义**，也不在这里「顺手」扩展：要改公共语义，去
  [dsh-std](https://github.com/T-Auto/dsh-std)；
- 本目录**不倒灌**：TUI 的要求只约束 dsh-TUI 生态，不要求其他宿主采用；
- 本目录不代表 dsh 官方接受、认证或背书；参考实现与 dsh-TUI 本身只能提供 evidence，
  不能自我认证。

## 自检

在仓根执行：

```sh
pnpm verify:build                                              # 含 plugin 系列与 profile 一致性门禁
node --import tsx/esm scripts/verify-protocol-single-source.ts  # profile 边界与派生常量一致性
```

`tui-profile/` 自带的准入 conformance 套件见 [`conformance/README.md`](conformance/README.md)：
它复用仓根 workspace 已安装的 `@dsh-std/*`，回退路径也是仓根的 `vendor/dsh-std`。

改本目录请先读 [`governance/rules.md`](governance/rules.md) 与
[`SPEC-WRITING-RULES.md`](SPEC-WRITING-RULES.md)：`registry/registry-0.15.json` 钉死了
`registry/contracts/*.json` 的 sha256，`protocols/` 的常量由 `src/adapter/spec/` 派生，
`conformance/` 的 fixture 与期望值必须同步——profile 数据改动与代码改动属于同一个提交。
