# Adapter Notes

Adapter Note 记录**某一宿主/运行时版本**与公共 contract 的适配细节：contract 到宿主机制（如 Cordis 的 service / event / ctx 模型）的映射、宿主已知的偏差、版本适用范围和证据。

边界（见 [`../governance/rules.md`](../governance/rules.md)）：

- Adapter Note **不改变标准语义**——发现语义冲突时回到上游 `dsh-std` 处理，不在 Note 里私自调和；
- Adapter Note 只约束其所描述的宿主版本，**其他宿主不被要求遵守**；
- 实现细节（内部函数名、私有 service id、框架内部 API）可以出现在 Adapter Note 中——这正是它与公共 contract 的分工（SPEC-WRITING-RULES §6）。

## 已收录 Notes

| Note | 宿主 | 状态 |
| --- | --- | --- |
| [dsh-tui-v0.15.md](dsh-tui-v0.15.md) | dsh-tui 本体（参考 TUI 宿主） | Current |
| [dsh-tui-vscode-v0.15.md](dsh-tui-vscode-v0.15.md) | dsh-tui-vscode（VS Code companion） | Draft / Experimental |

插件开发者的操作指南见 [版本内的 dsh-TUI 插件开发指南](../docs/plugins.md)（与 dsh-TUI 仓库同步）。

## 模板

```text
# Adapter Note — <宿主> <版本范围>

**Status:** Draft / Current / Superseded
**Spec version:** 适配的 TUI Profile / 上游 dsh-std 版本
**Host:** 宿主与版本范围（如 dsh-tui 0.8.x / Cordis 4.x）

## Contract 映射
<公共 contract → 宿主机制的对照表：能力、事件、权限各落到什么 API>

## 已知偏差
<宿主行为与 contract 的偏离，逐条说明原因与收敛计划>

## 证据
<支撑该 Note 的测试、fixture 或运行记录链接>
```
