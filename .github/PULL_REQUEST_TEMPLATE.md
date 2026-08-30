## 变更摘要 / Summary

<!-- 一两句说明改了什么、为什么。行为变更请写清楚用户可见的差异。 -->

## 关联 / Related

<!-- Closes #123 / Discussion 链接；纯内部改动可留空。 -->

## 变更类型 / Type

- [ ] fix — 修复缺陷
- [ ] feat — 新增能力
- [ ] docs — 仅文档
- [ ] refactor / perf — 不改变外部行为
- [ ] ci / chore — 构建、工作流、仓库维护

## 验证 / Verification

<!-- 贴出实际跑过的命令与结果。没跑就别勾。 -->

- [ ] `pnpm build`（compile + 全部构建门禁）
- [ ] 按改动面选的聚焦回归脚本（对照表见 [docs/contributing.md](../docs/contributing.md)）
- [ ] 终端可见改动：在 inline 与 fullscreen 两种模式、窄终端宽度下手动演练过

```text
<!-- 命令与输出 -->
```

## 自查 / Checklist

- [ ] 只改了 `src/`，没有手改或提交 `lib/` 下的生成产物
- [ ] 官方 `@deepseek-ai/*` 的 import 仍只出现在 `src/dsh-adapter/` 内
- [ ] 行为、配置、快捷键与限制的改动已在 `README.md` 与 `README_EN.md` 双语同步
- [ ] 改了 `cordis.patch.yml` 的话，`patch-surface.snapshot.json` 已同步
- [ ] 只暂存了显式路径，没有用 `git add .` / `git add -A`
