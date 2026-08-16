# 来源归属审计报告

本报告回答「仓库里每个文件是谁写的」：DeepSeek 官方、开源移植、泄漏移植、
项目自写、生成物，还是无法确证。结论全部基于只读证据，不包含推测。

## 方法与口径

审计分四步（WORKFLOW 2A-2D）：

1. **基线复核**：HEAD 确认 `b2f4087`、分支 main、工作树干净，origin/main 一致。
2. **全仓扫描**：每个文件采集「引入提交」与归属线索（`git log --follow` 与
   `--diff-filter=A` 组合，避开 `--follow --reverse` 的 git 缺陷）。
3. **采集与合成**：4 个采集 agent（ink/native-ts、components/screens/hooks/
   bootstrap、src 根+cc+utils+types、scripts/.github/skills/启动器）逐文件
   阅读并给出判定与证据，主循环复核关键文件并修正 8 处。
4. **对抗核验**：3 个对抗 agent 抽查 45 个文件（16%），逐条给原文行号，
   改判 10 处（6 降级、4 升级，见改判表），全部留档。

**覆盖范围**：282 个非构建产物条目（src 209、scripts 48、skills 7、.github 2、
根 16）。`lib/` 625 个文件是构建产物（`tsc` 输出，`docs/contributing.md:105-106`），
排除；`node_modules` 未安装。数字由脚本程序化重算（`apply-corrections.js`，
18 处覆盖全部命中，总数 = 282），不是手工统计。

**证据文件**（审计工作目录 `%TEMP%\dsh-docs-work\`）：`collect-tsv.txt`
（282 行原始采集，每行 path / verdict / evidence）、`collect-final.tsv`
（18 处改判后最终版）、`buckets-final.txt`、`adversarial-findings.txt`
（45 文件逐条对抗证据）、`intro-commits.txt`（每文件引入提交映射）。

## 归属分类定义

| 分类 | 判定标准 |
| --- | --- |
| DeepSeek 官方 | 可正面证明由 DeepSeek 官方编写（本审计结论：空桶） |
| 泄漏移植 cc-port | 文件自身显式自述源自 Claude Code 泄漏源码，或含硬标记（见下） |
| 开源移植 port-ink / port-pi / port-yoga | 明确自述移植自发布版 Ink / pi 扩展 / 开源 yoga-layout |
| 项目自写 project-self | 显式自研表述（"cc-tui ships/does/keeps…"）或功能提交引入 + 作者仓同步证据 |
| 生成物 generated | 内嵌编译 sourcemap 的构建产物、锁文件 |
| 无法确证 unverified | 证据不足：初始提交引入且无显式标记的文件 |

**cc-port 硬标记**（explicit evidence 类）：

- 显式头注释："ported from the leaked Claude Code source"、"the leak's X"、
  "verbatim from the leak"、"ported CC build"；
- `import { c as _c } from "react/compiler-runtime"`（React Compiler 变换产物）；
- `CLAUDE_CODE_*` 环境变量读取（CC 内部变量）；
- `anthropic.slack.com` 内部链接。

**不构成证据**（用户明确收紧的规则）：`import '@deepseek-ai/*'` 只证明依赖官方
包；没有 "ported from" 头注释不等于项目自写；结构与 Ink/Claude Code 相似不
等于已证明移植；"in the CC … style" / "in the shape of the leak's X" 是风格
引用而非移植声明。

## 最终分布

程序化重算结果（`buckets-final.txt`，基线 b2f4087）：

| 归属 | 数量 | 占比 |
| --- | --- | --- |
| 无法确证 unverified | 116 | 41.1% |
| 项目自写 project-self | 81 | 28.7% |
| 泄漏移植 cc-port | 57 | 20.2% |
| 开源移植 port-ink | 18 | 6.4% |
| 生成物 generated | 5 | 1.8% |
| 开源移植 port-pi | 3 | 1.1% |
| 开源移植 port-yoga | 2 | 0.7% |
| DeepSeek 官方 deepseek-official | 0 | 0% |

## cc-port 57 的标记构成

程序化分类（`bucket-breakdown.js`）：

| 标记类 | 文件数 |
| --- | --- |
| 显式 "ported from the leaked/leak" 类头注释 | 37 |
| `react/compiler-runtime` import（React Compiler 变换） | 12 |
| `CLAUDE_CODE_*` 环境变量读取 | 5 |
| "ported CC build" 自述 | 2 |
| `anthropic.slack.com` 内部链接 | 1 |

口径说明（脚本 `bucket-breakdown.js` 实况为 7 类，本表合并为 5 行）：5 =
4 个纯 `CLAUDE_CODE_*` 标记文件 + `src/ink/ink.tsx`（与 "ported CC build"
并存，同一文件计入两行）；2 = 1 个纯 "ported CC build" 文件 +
`src/ink/ink.tsx`（同上双计）；`src/cc/markdown.ts` 因头注释大写
"Ported from the leaked Claude Code source" 不命中区分大小写的脚本正则，
归入脚本的"其他"类——语义上属显式泄漏移植标记，五类之和 57 恰好正确。

分布区域：

- `src/cc/`：src/cc/figures.ts:2-3（"ported from the leaked Claude Code source
  (`src/constants/figures.ts`)"）、src/cc/markdown.ts:18-20、format.ts、terminal.ts；
- `src/ink/` 子系统：src/ink/reconciler.ts:192/202（读取 CLAUDE_CODE_DEBUG_REPAINTS /
  CLAUDE_CODE_COMMIT_LOG）、src/ink/termio/osc.ts:138/162（anthropic.slack.com 链接 + iTerm2
  内部知识）、src/ink/render-to-screen.ts:74/90/92（"ported CC build"）、src/ink/Ansi.tsx:1/32
  （compiler-runtime + `_c(12)` 效果槽）、colorize.ts、App/Box/Text 等组件、
  hooks/use-terminal-size.ts:7（"ported from the leak"）、dom.ts、ink.tsx；
- `src/screens/`：Chat.tsx:1410/1483/170/183/257（多处 "ported from the
  leak's/CC's X"）；
- `src/components/` 与 design-system：WorkingSpinner.tsx:11/65、
  StreamingMarkdown、Markdown、PromptInput、HelpMenu、Spinner/* 等；
- `src/theme.ts:261-263`："(verbatim from the leak)"，初版 809591d 头部自述
  "Claude Code theme, ported verbatim from the leaked source (`src/utils/theme.ts`)"
  （双重证据，主循环已用 `git show 809591d:src/theme.ts` 复核）。

## 关键改判（对抗核验 10 处）

| 文件 | 改判 | 依据 |
| --- | --- | --- |
| src/types/cc.d.ts | cc-port → project-self | L1-2 自称 "Typing shims"；L18-19 明言泄漏包不含 global.d.ts，本文件是自补；compiler-runtime 仅为 `declare module` 增强 |
| src/components/HistorySearchDialog.tsx | cc-port → unverified | L12-13 "in the shape of the leak's X" 为形态引用；但初始提交引入、无功能提交，不满足 project-self |
| src/components/SearchBox.tsx | cc-port → unverified | L6 "in the round-bordered box of the leak's SearchBox" 为外观引用；实现为自写（IME 避让）但初始提交引入 |
| src/components/Select.tsx | cc-port → unverified | L13 "in the CC CustomSelect style (ported visual: …)" 引导短语即风格引用；ported 仅限视觉 |
| src/components/shimmer.ts | cc-port → project-self | L33 "CC's original cadence" 为风格参考；功能由 5ba1d01 引入（非初始提交） |
| src/components/ActivityLine.tsx | port-pi（推断）→ unverified | 无 "ported from the pi" 头注释；仅风格引用；ac7833f 引入但自认移植 200ms cadence |
| src/ink/constants.ts | port-ink（推断）→ unverified | unpkg ink@5.2.0 完整 137 路径无 constants.js，文件名对应断裂 |
| src/ink/stringWidth.ts | port-ink（推断）→ unverified | 无 stringWidth.js 对应；依赖 Bun.stringWidth（Bun 系渊源）但无显式标记 |
| src/theme.ts | unverified → cc-port | 现行 L263 "verbatim from the leak" + 初版 809591d 自述（双重证据） |
| src/plugin.ts | unverified → project-self | `git log --diff-filter=A` 证明引入提交为 d55dc3b（同步自作者仓），809591d 只是 --follow 的 rename 血统 |

## 作者身份链（deepseek-official 空桶的依据）

「同步自 test-ccch1mneyyy」的提交只证明作者私有仓同步，不证明 DeepSeek 官方
编写。三重证据：

1. `LICENSE:3`："Copyright (c) 2026, chimney (ccch1mneyyy)"；
2. 硬编码本机路径：`scripts/perf-probe.cjs:6/10` 与 `scripts/leak-pty-stress.cjs:7/15`
   均含 `D:/code/projects/test-ccch1mneyyy`；
3. `README.md` 将本仓库定位为被官方收录的社区插件。

据此，5 个「官方候选」（index.ts、utils/loaded-context.ts、
components/LoadedContextPanel.tsx、scripts/header-probe.tsx、scripts/probe.ts）
归为 project-self。

## 关键提交

| 提交 | 内容 |
| --- | --- |
| 809591d | 初始提交：承载大部分移植树（含 src/cc/ 与 src/ink 的泄漏移植、theme 初版） |
| d55dc3b | cordis rescope：入口改 index.ts + plugin.ts（去 JSX），依赖同步为 @deepseek-ai/*；同步自 test-ccch1mneyyy 21923a68 |
| 330087a / cee58dd | 作者仓同步（loaded-context 功能、probe 脚本族） |
| 5ba1d01 / ac7833f / 7b425de / 8c2429b / 0530a99 / 6868601 | 功能/修复提交（shimmer、ActivityLine、虚拟化、stderr 守卫、CJK 截断、perf-probe） |

## 证据等级说明

- 本报告全部结论为 explicit evidence（原文引用、git 提交号）或按规则降级为
  unverified；没有 strong indication 猜测性升级。
- unverified 116 个的主体是初始提交 809591d 带入、无显式标记的文件——无法与
  泄漏原文逐文件对照（无对照手段）是硬限制，不是证据缺失。
- SPINNER_VERBS（`src/cc/spinnerVerbs.ts`，187 个动词，程序化数行）是高疑似
  泄漏移植：被显式标注泄漏移植的 WorkingSpinner.tsx:11/65 引用，但文件自身
  无显式归因，维持 unverified。

相关文档：[overview.md](overview.md)（源码分布）、
[ink-core.md](ink-core.md)（ink 内核归属）、[unknowns.md](unknowns.md)
（未验证清单）。
