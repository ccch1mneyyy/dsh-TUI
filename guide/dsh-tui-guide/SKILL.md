---
name: dsh-tui-guide
description: Use when the user asks about dsh-tui itself (usage, shortcuts, config, themes, migration, VS Code). Load before answering; skip for normal coding tasks.
---

# dsh-tui 用户手册（索引）

用户手册全文就在**本文件所在目录**——`skill` 工具返回的 `resourceBase`。共 10 篇，
每篇中英各一份：中文文件名无后缀，英文加 `.en.md`。拿不到绝对路径时，用
`glob` 在 dsh-tui 包里搜 `guide/dsh-tui-guide`。

## 怎么用

1. **跟用户同语言**：中文提问读无后缀文件，英文提问读加后缀的那份；回答也用同一种语言。
2. **先定位再读**：20 个文件按主题分篇，整篇读既慢又挤上下文。先 `grep` 关键词拿到命中行，
   再用 `read` 带 `offset`/`limit` 只展开需要的那几段。
3. **一次一到两篇**：按下面的路由表挑最贴近的；跨主题时再补第二篇。
4. **给出处**：回答末尾写清来源（文件名 + 小节标题），用户能直接翻回去核对。
5. **别编**：手册没写的直说"手册没写"，再给保守建议；不要拿记忆里的旧行为顶替。

## 路由表

| 用户问的 | 文件 |
| --- | --- |
| 安装、首次启动、启动失败、排障 | `getting-started.md` |
| 日常使用、键位、斜杠命令、会话与工作流、设置 | `user-guide.md` |
| 输入框、鼠标、选中复制、粘贴、图片、问卷与审批 | `interaction.md` |
| 配置覆盖层、TUI 开关、agent preset、模型路由、MCP | `configuration.md` |
| Claude 后端：启用、登录、与 DSH 的差异、已知限制 | `claude-backend.md` |
| Codex 后端：安装、登录、渠道、Plan、会话与原生能力 | `codex-backend.md` |
| 主题、配色、自动检测、自定义主题 | `themes.md` |
| 从 Claude Code / Codex / OMP / zcode / Grok 迁移会话 | `migrate.md` |
| VS Code 集成、扩展、IDE 选区 | `vscode.md` |
| 插件生态、接缝稳定性分级 | `plugins.md` |

英文提问时把上表文件名接上后缀（例如 `user-guide.en.md`）。

> 除本文件外，这些副本由 `scripts/build-guide.mjs` 从仓库 `docs/` 逐字节同步生成，
> 不要手改；改文档请改 `docs/` 再跑一次构建。
