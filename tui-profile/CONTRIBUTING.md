# Contributing

本文件只讲**怎么改 `tui-profile/`**。dsh-TUI 仓库本身的贡献流程见
[`../docs/contributing.md`](../docs/contributing.md)；两者走同一个 PR 流程。

## 1. 口径

`tui-profile/` 是 dsh-TUI 自己的 Profile：**随本仓库代码一起修订**——不是社区 RFC，
没有征求意见与批准环节，也没有状态晋级档位。判断一次改动是否合规只看两条：

1. 它和 dsh-TUI 当前的实现一致吗？
2. 它和 dsh-std 的公共语义冲突吗？（有疑问时以仓根 `vendor/dsh-std` 的固定 revision 为准）

## 2. 改动落在哪

| 你要改的东西 | 落在哪 | 必须同步 |
| --- | --- | --- |
| 准入要求、插件开发与验证说明 | `docs/plugin-admission-and-development.md` | `PLUGIN-ADMISSION-CHECKLIST.md`、`conformance/requirements-v0.15.json` |
| 私有协议坐标与权限 | `registry/registry-0.15.json`、`registry/permissions-0.1.json` | `protocols/`、`schemas/`、`src/adapter/spec/` 派生常量、`conformance/` fixture |
| 私有 contract profile | `registry/contracts/*.json` | 重算 `registry/registry-0.15.json` 里对应的 `profileHash`（文件 sha256） |
| 某宿主/上游版本的适配细节 | `adapters/`（Adapter Note，不改变协议语义） | — |
| 校验方式、fixture、期望结果 | `conformance/` | `scripts/verify-plugin-*.ts` 的期望 |
| 设计说明 | `notes/`（编号 0001-0008 是稳定锚点） | 编号不重排、不复用 |
| 实验方向与未决项 | `proposals/` | — |
| 归属、边界与修订方式 | `governance/rules.md` | — |

## 3. PR 必须说明

```text
改了什么（本目录内）：
对插件作者的影响（兼容/破坏）：
同步改了哪些数据与代码：
验证方式与结果：
要不要迁移说明：
```

## 4. 一次提交做一类事

`tui-profile/` 内部，一次提交只改一类东西（准入文档 / 注册表 / fixture / 说明）。
但 **profile 数据与消费它的代码要在同一个 PR 里分别提交**——profile 必须和实现一起
演进，禁止"先改代码，profile 以后再说"。

## 5. 提交前必须跑

```sh
pnpm verify:build
```

它包含 plugin 系列门禁（`verify:plugin-spec` / `grants` / `storage` / `messages` /
`ledger` / `commands` / `negotiation` / `lifecycle`）与 `verify:protocol-single-source`。
红了就是 profile 与代码、派生常量或 fixture 漂移了：先判断哪一侧是真源，不要靠改期望值
绕过。

## 6. 禁止事项

- 不得在 `tui-profile/` 里重新声明 dsh-std 已定义的公共语义（重复定义即分叉）；
- 不得把 TUI 的准入要求写成"所有 DSH 宿主/插件都必须遵守"；
- 不得把实现细节（内部函数名、private service id、DOM/React/Ink/Node 内部 API、
  某一版 dsh 的调用栈）写成协议；
- 不得让本目录重新变成 submodule 挂载点，也不得加回独立仓库的脚手架
  （`.github/`、`CODE_OF_CONDUCT.md`、`SECURITY.md` 等）——它是随 dsh-TUI 分发的普通文件；
- 不得使用"官方标准规定""dsh 官方认证""TUI 验证所以安全"这类说法。

## 7. 对 dsh 官方的态度

本项目欢迎官方审阅、采用、反对、分叉或暂不处理。任何参与者不得把"提交给官方审阅"
描述为"官方已经接受"。本项目的价值来自可验证的契约与解耦，而不是来自官方背书。
