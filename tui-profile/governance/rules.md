# Governance Boundary

> 归属：本目录是 **dsh-TUI 仓库里的 TUI Profile**（插件准入 + 私有协议定义），由
> dsh-TUI 维护者**随本仓库代码一起修订**。它不是社区 RFC，没有独立治理流程或状态
> 晋级门槛；公共协议语义不在本目录定义。

## 1. Sources

`vendor/dsh-std`（固定 submodule）是公共协议基线；本目录只写 dsh-TUI 自己的准入
要求与私有协议定义。TUI policy 不修改 dsh-std 的协议含义，也不要求其他 Host 采用。
上游生态入口是 `dsh-ecosystem-spec`（只做挂载与索引，不再承载 TUI 准入正文），
两边正文互不复制。

本目录不代表 dsh 官方接受、认证或背书。

## 2. 修订方式

- **随代码修订**：实现变了就把这里改到与实现一致——一次 PR 内可以同时改 `src/`、
  `tui-profile/`、验证脚本与用户文档，没有"先提案、再批准、再落地"的两段流程。
- **没有状态晋级门槛**：不存在 Draft→Experimental→Candidate→Stable 的批准阶梯，
  也不需要在别处获得许可后才生效；版本变化看 [`../CHANGELOG.md`](../CHANGELOG.md)。
- **改 profile 数据等于改契约**：`registry/registry-0.15.json` 钉死了
  `registry/contracts/*.json` 的 sha256；`protocols/` 常量由 `src/adapter/spec/`
  派生；`conformance/` 的 fixture 与期望值必须同步。这条约束由
  `pnpm verify:build`（plugin 系列 + `verify:protocol-single-source`）执行，红了就是
  漂移，不许绕过。
- **保持纯文件**：本目录不得重新变成 submodule 挂载点（`verify:protocol-single-source`
  会直接失败），也不得加回 standalone 仓库的脚手架（`.github/`、`CODE_OF_CONDUCT.md`
  等）。
- **`notes/` 的编号约定与阅读方式**见 [`../notes/0000-maintenance.md`](../notes/0000-maintenance.md)：
  编号是稳定锚点，不是提案流程；说明性文档不新增义务。

## 3. Baseline updates

更新 `vendor/dsh-std` revision 必须记录受影响的 Manifest version、protocol definitions、admission decision 和迁移要求，并完整运行 conformance suite。不得在本目录复制旧的 std schema 后继续以同一名称维护。**pin 的是上游 `dsh-std`，不是 `tui-profile/`**——后者没有 revision，随本仓库提交走。

## 4. TUI-owned definitions

TUI 自有协议使用 `tui.dsh/*` namespace。新 definition 必须提供 `apiVersion + kind`、协议专属校验与协商器、contract profile、immutable digest 和 fixtures，并注册进 dsh-std `ProtocolCatalog`。目录或 package 的存在不等于 live support。

TUI-only 要求使用稳定的 `TUI-*` ID，并说明适用 profile、影响范围和兼容变化。

## 5. Evidence

参考实现和 TUI Host 只能提供 evidence，不能自我认证。claim 必须绑定 std revision、profile、Host、artifact 和 suite，并区分 declared、parsed、negotiated、tested、observed 与 attested。任何 evidence 都不是安全保证。
