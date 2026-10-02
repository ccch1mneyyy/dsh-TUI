# Specification Writing Rules

本文件约束 `tui-profile/` 自己的写法，防止"规范着规范又乱了"。

前置口径：本目录是 dsh-TUI 自己的 Profile，**随本仓库代码随时修订**；它没有提案/批准
流程，也不定义公共语义。公共协议正文在仓根 `vendor/dsh-std`（固定 revision），本目录
只写 dsh-TUI 的准入要求与私有定义（`tui.dsh/*`）。

## 1. Normative language

本目录的准入与接口要求使用以下术语：

- **MUST / 必须**：不满足即不符合 dsh-TUI 的准入要求；
- **MUST NOT / 禁止**：不满足即违规；
- **SHOULD / 应**：一般要求；只有明确理由才能偏离；
- **SHOULD NOT / 不应**：一般不允许；
- **MAY / 可以**：实现自主选择。

“建议”“最好”“尽量”不能单独承担 normative requirement。

## 2. 文档分区规则

### `docs/plugin-admission-and-development.md`

唯一整合文档：TUI 基线依赖声明、TUI Admission、接口与兼容性协定、插件开发指南与
准入检查清单都汇总在这里。

### `notes/`

放独立主题的设计说明。编号 `0001`-`0008` 是稳定锚点（代码与文档里的 `RFC 000x` 指
同一份说明），只增不改号。

### `proposals/`

放 TUI 独有、实验性或尚未定案的方向。

### `governance/`

只放归属、边界与修订方式。

### `conformance/`

只放验证、fixtures、证据与结果定义。

### `registry/`

只放机器可读 contract 的注册与生命周期规则。

### `adapters/`

只放 Adapter Note：某一宿主/运行时版本（如 dsh/Cordis 的具体版本）与契约的适配细节。
Adapter Note 不改变协议语义，不被其他宿主要求遵守。

### 不放进本目录的东西

公共协议语义（Manifest、元协议、composition、lifecycle、command、storage、messages、
presentation 等）一律以上游 dsh-std 为准，本目录只引用其固定 revision，**不复制正文**。

## 3. 禁止越权写法

任何文档不得使用以下含义不清的句子：

- “官方标准规定”；
- “dsh 官方认证”；
- “TUI 验证所以安全”；
- “TUI Profile 就是标准实现”；
- “所有 dsh 插件都必须遵守”。

必须改写为：

- “dsh-TUI 的准入要求”；
- “TUI Profile 的当前口径”；
- “参考实现”；
- “实验性能力”；
- “上游 dsh-std 定义”。

## 4. 每项规范必须绑定测试

新加一个 MUST / MUST NOT 时，必须同时指出：

- schema / contract 在哪里；
- fixture 在哪里；
- conformance test 如何证明；
- 失败时市场/Host 如何展示。

写不出测试的要求，只能作为说明写进 `proposals/`，不得写成 MUST。

## 5. 每项能力必须有边界

写一个 capability 时必须回答：

1. 它解决什么问题；
2. 谁可以调用；
3. 需要什么授权；
4. 输入 / 输出 schema；
5. 生命周期；
6. 错误语义；
7. 并发 / 超时；
8. cleanup / rollback；
9. privacyClass；
10. 是否构成安全边界。

v0.15 起每项能力/事件还必须携带与 registry 一致的坐标身份（`coordinates.apiVersion` +
`coordinates.kind`），且 `securityBoundary` 在 trusted-in-process 档位下必须为 `false`。
contract profile 与 registry 条目的坐标不一致视为 CONTRACT_INVALID。

## 6. 不允许把实现细节冒充 contract

以下内容属于实现层，不能直接成为对外契约：

- 内部函数名；
- private service id；
- mixin target；
- DOM / React / Ink / Node 内部 API；
- 某一版本 dsh 的具体调用栈。

Adapter 可以依赖这些东西，但插件契约不可以。

## 7. 每项 breaking change 必须写迁移

至少包含：

```text
Affected versions
Old contract
New contract
Migration path
Compatibility window
Removal date
```

不能仅写“更新到新版即可”。profile 与代码在同一个 PR 里一起改，迁移说明写进
`CHANGELOG.md` 与相关准入章节。

## 8. 实验性能力的要求

在 `proposals/` 里提一项实验能力时必须明确：

```text
能力名（含私有坐标 tui.dsh/*）
为什么必须是 TUI 私有（不能进 dsh-std 公共语义的理由）
进入条件
退出条件（转正式 / 删除）
回滚方案
```

未写清退出条件的实验能力不得写进 `docs/plugin-admission-and-development.md` 的正式准入
章节，也不得出现在 registry 的 `definitions` 里。
