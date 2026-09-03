# 跨仓库待同步说明（dsh-ecosystem-spec）

> 本文件由 dsh-tui adapter 蓝队生成，仅作为本地备忘/待办，不修改子模块。
> 子模块 `dsh-ecosystem-spec` 内的文档仍引用已删除的旧路径，需要在跨仓库单独提交中同步。
> 可直接应用的 unified diff 见：`docs/adapter-cross-repo-sync.patch`

## 需同步的旧路径

以下位置仍把 `src/plugin-spec/*` 描述为当前实现：

- `dsh-ecosystem-spec/docs/plugin-admission-and-development.md:132`
- `dsh-ecosystem-spec/adapters/dsh-tui-v0.15.md:6`

建议改为指向 dsh-tui adapter 当前 canonical 路径：

```text
src/adapter/standard/*
```

## 补丁内容摘要

1. `docs/plugin-admission-and-development.md`

```diff
- `src/plugin-spec/` — 校验/协商纯库...
+ `src/adapter/standard/` — 校验/协商纯库...
```

2. `adapters/dsh-tui-v0.15.md`
   - 仓库路径标注从 `src/dsh-adapter/`、`src/plugin-spec/`
   - 改为 `src/dsh-adapter/`、`src/adapter/standard/`

## 说明

- 本轮严格遵守“不改子模块”纪律，未在 `dsh-ecosystem-spec` 内做任何修改。
- 上述改动应作为 dsh-ecosystem-spec 仓库的独立 PR/补丁提交。
- `docs/adapter-cross-repo-sync.patch` 为可直接 `git apply` 的 unified diff 文本。
- dsh-tui 本地侧无需额外代码变更，仅保留本同步说明与补丁。
