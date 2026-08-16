# dsh-cc-tui 架构文档

本目录是 dsh-cc-tui（`@deepseek-ai/dsh-cc-tui`）的架构文档集，与 `docs/` 下
的用户指南（getting-started / configuration / interaction / themes /
architecture / contributing）互补：用户指南面向使用与配置，本目录面向源码
结构、运行链路与来源归属审计。

## 审计信息

| 项 | 值 |
| --- | --- |
| 审计基线 | main / `b2f408740a544f92a1e6e5ca8e07017793cabd63`（git describe：v0.4.1-48-gb2f4087） |
| 审计日期 | 2026-08-15 |
| 审计模式 | 严格只读：未构建、未运行、未安装依赖；`lib/` 为构建产物，不阅读内容 |
| 覆盖范围 | 282 个非构建产物条目（src 209、scripts 48、skills 7、.github 2、根 16）；`lib/` 625 个文件按构建产物排除 |

## 文档索引

| 文档 | 用途 |
| --- | --- |
| [overview.md](overview.md) | 总览：项目定位、运行链路、分层与模块边界 |
| [lifecycle.md](lifecycle.md) | 插件生命周期与装配：cordis 配置、启动顺序、命令注册、退出漏斗 |
| [ink-core.md](ink-core.md) | 移植 Ink/Yoga 渲染内核：渲染管线、布局引擎、终端协议、组件与 hooks 地图 |
| [rendering.md](rendering.md) | 渲染链路与性能：双层节流、虚拟化、残影修复、CJK 截断与文本测量 |
| [input-commands.md](input-commands.md) | 输入处理、IME 避让与命令系统（/rewind、/new、/compact 等） |
| [model-route.md](model-route.md) | 模型路由与状态栏：原子解析、resume 跟随、/model 命令 |
| [session-context.md](session-context.md) | 会话持久化与上下文：resume 契约、JSONL/SQLite 文档冲突、teardown |
| [mcp-stderr.md](mcp-stderr.md) | MCP 集成与子进程 stderr 聚合（issue #17） |
| [update.md](update.md) | 更新系统：版本检查、/update 链路与已确认缺陷 |
| [theme-i18n.md](theme-i18n.md) | 主题系统与界面国际化 |
| [origin.md](origin.md) | 来源归属审计：282 条目分类、证据等级、硬标记法 |
| [unknowns.md](unknowns.md) | 未验证事项与文档冲突清单 |
| [architecture.mermaid](architecture.mermaid) | Mermaid 架构总图：配置层 → 入口 → 通道 → 应用层 → 渲染内核 → 文本测量 → 输入链 → 主题/i18n → 系统功能 → 归属审计；所有信息内嵌节点 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收报告与交付清单：修改文件、统计口径、验证记录、Git 状态、交付判定 |

## 关键结论速览

- 归属分布（282 条目）：无法确证 116、项目自写 81、泄漏移植 57、开源移植
  23（port-ink 18 + port-pi 3 + port-yoga 2）、生成物 5；无文件可归为
  DeepSeek 官方编写（详见 [origin.md](origin.md)）。
- 会话持久化存在文档冲突：当前配置 `cordis.patch.yml:147` 与 `cordis.yml:162`
  均挂载 `@deepseek-ai/dsh-session-persistence-jsonl`（JSONL）；旧文档
  （docs/configuration.md:154-155、docs/architecture.md:77、docs/getting-started.md:71）声称
  profile 模式使用 SQLite。以当前配置为准，SQLite 声称标为「文档冲突/待确认」
  （详见 [session-context.md](session-context.md#会话持久化后端与-jsonlsqlite-文档冲突)）。
- 更新系统存在已确认代码缺陷：`src/update.ts:232` 在更新完成后才读取版本写入
  `DSH_CC_UPDATED_FROM`，成功更新也会触发「版本未变化」告警（详见
  [update.md](update.md#已确认缺陷)）。
- /rewind 命令与 /new 一次生效（pr-55，合并提交 dc678d8）位于 v0.4.1 tag
  （eeca418）之后，当前基线已包含（详见 [input-commands.md](input-commands.md#rewindissue-43pr-55)）。

## 链接与引用约定

- 文档间互链使用相对路径；指向源码与配置的引用使用 `相对路径:行号` 文本形式
  （如 `src/plugin.ts:35`），行号均以审计基线 b2f4087 为准。
- 证据等级分三档：explicit evidence（源码注释、提交记录或精确上游对应）、
  strong indication（多项间接证据）、unverified（无法确证）。归属结论的证据
  等级见 [origin.md](origin.md)。
- 未验证事项一律标记 unknown/unverified，不补猜；清单见
  [unknowns.md](unknowns.md)。
