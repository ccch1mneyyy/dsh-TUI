# 0000 — notes/ 的用途与编号约定

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

本目录放 TUI Profile 的设计说明：某个准入要求、私有坐标或校验**为什么**是这样。
**归属、修订方式与上游边界不在本文件定义**，见
[`../governance/rules.md`](../governance/rules.md)；本文件只讲"这里的文档怎么用"。

## 编号与别名

- `0001`–`0008` 是长期被代码注释与文档交叉引用的固定编号，用来保证链接可解析；
  编号顺序不代表提案顺序、成熟度或批准先后，也没有对应的晋级阶梯。新增说明在末尾续号。
- 代码注释与旧文档里出现的 `RFC 000x` 指的是同一份 `notes/000x`（历史称呼），
  不是另一套流程，也不代表曾经过社区批准。

## 效力

- 本目录的说明是**说明性（informative）**的：解释设计理由与取舍，自身不新增义务。
- 条目里出现的 MUST / MUST NOT 句子，只有在对应能力或事件已经进入
  [`../registry/registry-0.15.json`](../registry/registry-0.15.json) 与
  [`../docs/plugin-admission-and-development.md`](../docs/plugin-admission-and-development.md)
  的准入章节时才算准入要求；否则属于实验性描述，可能随时改。
- 与正式 profile 文本冲突时，以正式文本与其 normative assets（`registry/`、
  `schemas/`、`conformance/`）为准；registry / schema hash 不一致时 fail closed。

## 参考实现

参考实现可以验证可行性、提供 fixtures / benchmark / evidence，但不能用实现行为替代
profile 文本，也不因实现存在而自动获得"官方认证"。加载顺序不得仲裁
contribution / provider 冲突。
