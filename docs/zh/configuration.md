<p align="center">
  <strong>简体中文</strong> | <a href="../en/configuration.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# 配置（profile cordis.patch.yml）

官方 profile 模型下没有独立的 cordis.yml 启动文件：`$DSH_HOME/profiles/cc-tui/`
下只有 `cordis.patch.yml`（你的补丁层，顶层 YAML 数组，`!!js` 可用）。
以下是「想改什么怎么写」的示例，不是完整配置：

```yaml
# 覆盖某行的 config：整段替换，想保留的 key 都要重写
- id: cc-tui
  config:
    provider: deepseek-official   # LLM 路由
    model: deepseek-v4-flash      # 模型
    effort: max                   # 顶栏/状态栏启动显示的思考深度
    activity: true                # 工作状态行开关（默认开）
    activityFrames: claude        # 指示器预设：claude/moon/comet/dots/…/random
    cwd: !!js process.cwd()       # 工作目录
    fullscreen: false             # 备用屏幕全屏模式（默认关）
    preset: !!js process.env.CC_TUI_PRESET ?? undefined  # Agent preset（见下节）
    sessionId: !!js process.env.DSH_CC_RESUME_SESSION ?? undefined  # --resume

# 调优实时工作状态行数据源（与 Web UI 共享）：随 add 已自动挂载（bundle
# patch 自 insert），按 id 覆盖 config 即可——不要再 insert 同名行；
# 500 让状态栏计时更跟手（先装 dsh-working-activity 时本包 patch 已带 500）
- id: working-activity
  config:
    publishIntervalMs: 500
```

依赖（除注明外均由 dsh-base 层提供，无需手工挂载）：llm-deepseek（thinking
开启）、session（SQLite 持久化由本包 patch 插入 `sessions` 行）、bash、fs、
**commands（命令注册表）+ command-goal（`/goal`）**、token-meter 以及
dsh-working-activity（工作状态行，随 add 自动挂载，见上）。模型侧的工具/
提示词行（tool-fs、tool-todo、subagent、plan-mode、compaction-basic 等）
自 0.3 起由会话的 agent preset 组合提供（见下节），不再挂在 host 层。

> 配置注意：覆盖 `plan-mode` 时 `section` 必须给非空值（空值会导致整树加载
> 失败）；`subagent` 核心服务必须先于 spawn/fork 行挂载（base 层顺序已保证，
> 在自己 insert 相关行时保持同样顺序）。
