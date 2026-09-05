# 审查报告固定结构
除用户明确要求机器可读 JSON 外，须以下结构；可压措辞，不删证据字段。R 为发现编号，Q 为澄清编号，A–E 分别为行为/契约/安全/流程/熵轴。

```markdown
# Review verdict
**结论**：Request changes | Merge with conditions | No blocking findings
**模式**：Review | Deslop report | Deslop apply；**对象**：PR/branch/range/绝对路径
**基线**：latest target `<sha>`；**Head**：`<sha>`
**信任级别**：trusted-maintainer | trusted-local | untrusted-fork

## Findings
### R1 [❌|⚠️|💡] [defect|slop] [A|B|C|D|E] 标题
- **定位**：绝对路径及行号（head `<sha>`；行号基：head/worktree/diff）
- **机制**：输入/状态 → 调用链 → 错误结果或维护熵
- **证据**：读码/搜索/规则/运行；给出命令、退出码或来源位置
- **影响**：用户、数据、契约、安全、平台或维护成本
- **置信度**：高 | 中
- **最小修法**：不扩大范围的具体改变
- **验证**：修复后要证明的独立不变量
- **删除证明**：仅 slop；引用、动态注册、副作用、公共 API、测试的处置

## Clarifying questions
- **Q1**：缺少的事实；补哪项证据后可升级为 finding。

## Validation record
| 检查 | SHA | 结果 | 覆盖/障碍 |
|---|---|---|---|
| `command` 或静态对照 | `...` | pass/fail/not run | ... |

## Coverage and residual risk
- 已审：...；未审：...；受限原因：...；残余不确定性：...

## Merge Conditions
1. 可验证条件一。
2. 可验证条件二。
```

## Verdict 规则
未解决 ❌ → `Request changes`；无 ❌ 但有合并前必须闭环的 ⚠️/缺验证 → `Merge with conditions`；无 blocking → `No blocking findings`，不称完全安全/无任何问题。Deslop report 无合并对象时末节改 `Cleanup conditions`。

## Finding 规则
按影响非发现顺序，先 defect 后 slop；同根因同修法才合并且列全位置，症状似不足。严重度依规则/实际影响，不依扫描置信提示/评论语气/作者身份；低置信入澄清而非 Findings；❌ 须当前 head 完整因果链，不能仅“可能/建议检查”。引用当前真源绝对路径/章节，参考仅索引；每个数字/状态/定性标当前 SHA/核验法，不可核则标估计。

## Slop 规则
作者来源禁猜及候选/可删分离依 /mnt/shared/_Projects/DSH-TUI/review/SKILL.md 全局及反制表；不写“AI-generated/bot-like”，单调用者/grep 零命中/unused/正则不等于可删。defect/slop 分类以 /mnt/shared/_Projects/DSH-TUI/review/references/deslop-gates.md “严重度与熵类型”为唯一真源；纯命名/排序/空行/审美仅违反仓规或造成大 churn 才报。缺删除证明只能写“核实 X 后删除/合并”，不写 auto-fix。

## 零 finding
仍输出 `Findings: none found in reviewed scope`、Validation record、Coverage and residual risk、Merge Conditions/Cleanup conditions；仅表示声明范围/证据下无可报告问题。

## 禁止章节
禁止“做得好的地方”、未核验 PR 摘要、纯 nitpick 清单、无当前 SHA 的“CI 已绿”、仅藏于 Merge Conditions 的 blocking 项。
