# ecosystem-spec/ — vendored 社区互操作规范数据（只读）

本目录是 [T-Auto/dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec)
（Community Consensus v0.15）的**运行时数据子集**拷贝，供 dsh-TUI 代码消费：

- `registry/` — 契约注册表（坐标 + schemaHash）、权限注册表、三个 contract
  profile、TUI Host Descriptor 示例；
- `schemas/` — manifest / host descriptor / envelope / ledger / claim 五个
  JSON Schema；
- `conformance/fixtures/` — 一致性 fixtures（**仅仓库内测试消费，不进 npm 包**；
  `scripts/verify-plugin-spec.ts` 用它们跑全量 validate/negotiate 矩阵）。

同步基线：上游 `main@279cbba`（2026-08-17，v0.15 + 红队验收修复）。

## 更新流程

1. 上游发版后整目录覆盖拷贝（保持相对路径不变）；
2. 更新本文件的同步基线；
3. 跑 `node --import tsx/esm scripts/verify-plugin-spec.ts` —— fixtures 矩阵
   与 schemaHash 自检即漂移报警器。

本目录**不承载规范文档**；规范阅读与修订走上游仓库。任何手改都会在下次
覆盖时丢失——不要在这里改内容。
