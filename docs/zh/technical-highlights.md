<p align="center">
  <strong>简体中文</strong> | <a href="../en/technical-highlights.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# 技术要点

- **Gentle Mist Blue 配色**：雾蓝只承担品牌、焦点、交互与高亮，正文保持
  中性灰。启动时查询终端背景色（OSC 11）自动选色：浅色终端用严格的
  Gentle Mist Blue 色卡（墨色 `#343945` 正文 + 暖米白家族），深色终端用
  雾蓝适配版（暖灰白 `#E8E6E0` 正文 + 柔雾蓝 accent）；终端不响应时回退
  深色。`CC_TUI_THEME=light|dark|dark-ansi` 可钉死配色并跳过检测；也支持
  `~/.dsh-cc/themes/` 下的用户自定义主题（见「自定义主题」章节）。
- **事件驱动渲染**：`session/event` 事件流 → 增量差分渲染，滚动状态独立维护。
- **布局级虚拟化**：布局引擎是纯 JS 移植版 Yoga，每次提交都会全树重排——
  长会话的每帧成本随记录线性增长（越用越卡的根因）。消息列表按可视窗口
  挂载：屏幕外的行渲染为"量高占位符"（高度来自上一帧 Yoga 实测），其
  子树完全不参与布局，单帧成本从 O(全会话) 降到 O(可视窗口)；滚动几何
  （总高度/底部跟随/滚动条）、搜索跳转（未挂载行先强制挂载再寻址）保持
  不变。
- **上下文进度条**：参考 pi-nano-context 算法（最大余数法分段着色 + 右侧多级
  缩略读数），DeepSeek 蓝白配色。
- **TPS 仪表**：参考 pi-tps-meter——流式 1/8 格 gauge、历史 min-max sparkline、
  速度语义色（≥50 绿 / ≥20 黄 / <20 红）。
- **working-activity 生态**：工作状态行消费
  [dsh-working-activity](https://github.com/ccch1mneyyy/dsh-working-activity)
  的 log-only `activity/status` 事件（与 Web UI 同一数据源，cc-tui 只做渲染）；
  `⏵` 自述行自动从聊天正文剥离。
- **会话恢复**：`/resume` 列表标题 = 会话第一条 user 消息（最新 20 个会话），
  8 行滚动窗口；**按最近使用排序**（发消息/恢复/切换都会把该会话提到最前，
  记录在 `~/.dsh-cc/last-used.json`，缺失时退回按创建时间）；Enter **立即切换**
  到该会话并回放历史；`--resume` 启动同链路。
- **回滚语义**：fork 边界取消息所属 turn 的起点（DSH 事件序
  turn/start → user/message → turn/end），中断回合先等落盘再 fork。
- **终端粘贴**：raw 模式下 Ctrl+V 由应用接管——PowerShell `Get-Clipboard`
  读剪贴板：Explorer 复制的文件/图片返回 FileDropList → 插入文件路径（含空格
  自动加引号）；纯文本按原文插入光标处（含换行，不会误提交）。终端原生粘贴
  （Ctrl+Shift+V / 右键）走 bracketed paste，同样插入而非提交。

- **问卷（ask_user_question）**：DSH user-interaction 生态的 TUI 适配——模型
  调用 `ask_user_question` 时不再以工具卡片出现，而是弹出雾蓝风格问卷面板
  （每题一屏：进度头 `第 x/N 题`、题头徽标、选项 + 描述、多选勾选、Tab 自定义
  回答），按键流转走官方 dsh-tui 同款语义（↑/↓ 选择、Space 多选、Enter 提交、
  Esc 中断 → `ASK_ABORTED`）。问答结束后把 Q&A 摘要折叠进会话记录；批内多题
  与子代理并发提问按 FIFO 排队逐题呈现。服务行由 dsh-base 提供，插件在裸装
  时自建服务并注册 provider、挂载模型侧工具。
