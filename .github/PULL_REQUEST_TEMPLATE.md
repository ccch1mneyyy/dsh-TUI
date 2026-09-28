Closes #<!-- issue 号；改动代码的 PR 必须关联 issue。纯文档 PR、或维护者打了 no-issue-needed 标签的 PR 可删掉这一行 -->

## Why the change

<!-- 一句话：这个 PR 解决什么问题、合并后能做什么。 -->

## Special things to note

<!-- 1–3 条给 reviewer 的提醒：兼容约束、迁移、刻意不做的事、出人意料的决定。没有就写「- 无。」 -->

## Change outline

<!--
用最少的图示讲清实现的形状，每个图配一句短说明，不写逐文件流水账：
- 浅层文件树：改了哪些职责（```diff，新增行用 +）
- 调用链 / 控制流 / 数据流的变化（```diff）
- 关键类型或配置形状（完整代码块）
- 终端可见的改动：贴一段无头渲染出的真实屏幕文本（```text），这就是截图
已有形状的改动用 diff，大部分是新东西就给完整形状；和这个 PR 无关的图不要放。
-->

## Verification

<!-- 只写真跑过的命令与结果；按改动面选的聚焦回归见 docs/contributing.md。没做的（例如真实终端 inline/fullscreen/窄屏演练）直接写没做。 -->

```text

```

<!--
提交前自查（不必勾选，确认即可）：
- 只改 src/，没有手改或提交 lib/
- 官方 @deepseek-ai/* 的 import 仍只在 src/dsh-adapter/ 内
- 行为、配置、快捷键、限制的改动已在 README.md 与 README_ZH.md 同步
- 改了 cordis.patch.yml 的话，patch-surface.snapshot.json 已同步
- 只暂存了显式路径
-->
