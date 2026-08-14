<p align="center">
  <strong>简体中文</strong> | <a href="../en/keyboard-shortcuts.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# 快捷键

| 键 | 功能 |
|---|---|
| `Enter` | 发送（`Shift+Enter` 换行）；命令菜单打开时执行选中项 |
| `Ctrl+C` | 中断当前回合；空闲时连按两次退出 |
| `Esc` | 关闭命令/文件菜单；空闲双击清空输入；**空输入双击 = 时间回溯** |
| `Ctrl+O` | 展开/收起详情（思考全文、工具参数与输出） |
| `Ctrl+R` | 历史消息搜索 |
| `/` | 会话内全文搜索（`n`/`N` 跳转） |
| `Tab` | 命令 / `@` 文件补全 |
| `Ctrl+V` | 粘贴：文本直接插入光标处；**Explorer 复制的文件/图片 → 插入文件路径** |
| `?` | 快捷键菜单 |
| `Shift+↑` | 消息选择模式（Enter 展开单条） |

**鼠标（`fullscreen: true` 全屏模式；默认关，profile 补丁层覆盖开启）**

| 操作 | 功能 |
|---|---|
| 拖拽选择 | 应用内文本选区，**松开即复制**（OSC 52 + `wl-copy`/`xclip`/`xsel` 原生兜底；tmux 内走 `load-buffer -w`），复制后自动取消选区并弹出「已复制 N 个字符」提示 |
| 双击 / 三击 | 选词 / 选行，同样即选即复制 |
| 滚轮 | 滚动消息列表 |
| `Esc` | 拖拽进行中取消选区（不复制） |

> 全屏模式用 alt-screen 渲染（退出 TUI 后内容回主屏）；设 `fullscreen: false`
> 退回 inline 模式，鼠标交还终端模拟器原生选择（"选择即复制"由终端自身
> 设置决定，如 kitty `copy_on_select yes`）。`CC_TUI_DISABLE_MOUSE=1` 可在
> 全屏模式下临时禁用鼠标点击处理。

**问卷（模型发起 `ask_user_question` 时）**

| 键 | 功能 |
|---|---|
| `↑/↓` | 选择选项 |
| `Space` | 多选题勾选/取消 |
| `Tab` | 切到自定义回答（不选选项直接打字） |
| `Enter` | 提交当前选择 |
| `Esc` | 中断提问（模型收到 ASK_ABORTED，可继续对话） |

**本地命令（CC 指令全集复刻，均走 DSH 官方链路）**

| 分组 | 命令 |
|---|---|
| 会话 | `/new` 新会话 · `/resume` 恢复 · `/clear` 清屏 · `/compact` 压缩 · `/export` 导出 Markdown |
| 状态 | `/status` 会话信息 · `/cost` token 用量 · `/doctor` 环境自检 · `/config` 配置来源 · `/init` 创建 AGENTS.md |
| 模型 | `/model` 选择器 · `/thinking` 思考显示 · `/tokens` token 明细 · `/theme` 主题选择器 |
| 账号/策略 | `/login` 凭证状态 · `/logout` 登出说明 · `/permissions` 权限说明 · `/add-dir` 文件策略范围 · `/hooks` · `/mcp` · `/memory` |
| 技能 | `/audit` 代码审计 · `/bug` bug 报告 · `/review` 代码评审 · `/practice` 编程练习 · `/pr_comments` PR 评论 · `/release-notes` 发布说明 · `/vuln-check` 漏洞检查 |
| 其它 | `/agents` 子代理列表 · `/vim` · `/terminal-setup` · `/connect` · `/help` · `/exit` |
| 注册表 | `/plan` `/goal`（DSH 命令注册表插件，随插件自动并入 `/` 菜单） |

> `/` 菜单 = 本地命令 + 注册表命令的并集（注册表描述来自插件本身）；
> `/plan [off|消息]` 切换计划模式，`/goal [create/edit/pause/resume/clear 目标]`
> 管理持久化目标。
> 技能命令通过 DSH 技能系统驱动：`skills/` 目录随 npm 包分发，插件启动时
> 自动注册进技能注册表，**无需手动复制**。也可把 SKILL.md 放入
> 技能发现目录（`~/.dsh/skills`、`~/.agents/skills` 或项目 `.dsh/skills`）覆盖同名技能，
> 命令只是把激活提示发给模型（模型用技能目录/加载工具取用）。npm 版
> install.sh 不再自动安装技能。
