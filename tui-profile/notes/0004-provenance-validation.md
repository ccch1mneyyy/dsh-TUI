# 0004 — TUI Conformance Evidence Profile

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

公共 provenance 与 conformance 术语采用 dsh-std 的 [`provenance`](../../vendor/dsh-std/docs/proposals/provenance.zh.md) 和 [`conformance`](../../vendor/dsh-std/docs/proposals/conformance.zh.md) 提案。本 profile 只定义 dsh-TUI 展示和准入所需的 evidence profile。

TUI claim 绑定插件 artifact digest、Host Descriptor digest、固定的 dsh-std submodule revision、TUI suite version、测试结果和 evidence level。声明信息、解析结果、协商结果、测试结果和运行时观察必须分别记录，不能互相冒充。

effect ledger 只记录 activation owner、runtime generation、resource identity、操作和 cleanup 结果，不记录消息正文、credential、token 或 secret。`cleanup-failed` 保留为可重试状态。

这些资产用于 TUI 的 Verified 展示，不表示安全、无漏洞、官方认证或对所有 DSH Host 的兼容性。
