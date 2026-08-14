<p align="center">
  <strong>简体中文</strong> | <a href="README.md">English</a>
</p>

<p align="center">
  <img src="screenshots/splash.png" alt="dsh-cc-tui — DeepSeek Harness 的 Claude Code 风格终端 TUI" width="100%">
</p>

# dsh-TUI

> DeepSeek Harness 官方目前还没有终端 TUI（只有 Web UI） 因此！我制作了这个dsh-cc-tui！

![类型](https://img.shields.io/badge/type-cordis%20plugin-blue) ![状态](https://img.shields.io/badge/status-公测-blue) ![官方收录](https://img.shields.io/badge/DeepSeek%20Harness%20官方公众号-收录-brightgreen)

## 🎉 官方收录

本插件被 **DeepSeek Harness 官方公众号** 推文收录，作为"内测用户精选插件"展示：

<p align="center">
  <img src="screenshots/wechat-official.png" alt="DeepSeek Harness 官方公众号推文收录 dsh-cc-tui" width="560">
</p>

## 界面预览

![首屏：像素鲸鱼顶栏](screenshots/splash.png)

![工作状态行 + 上下文进度条](screenshots/working-line.png)

## 为什么值得装：美观、易用

- **实时工作状态行**：工作时输入框上方常驻模型的实时动态——包含数十种状态

- **一眼看穿模型状态**：底部状态栏
  右侧 `git 分支 · 工作目录 · 会话标题`
  
- **思考过程流式可见**：thinking 块边生成边展开，回合结束自动折叠，Ctrl+O 随时展开全文

- **双击 Esc 时间回溯**：把对话回滚到任意一条历史消息

- **还有更多特性等你发现......**

## 如何安装

```sh
  # 1. 安装DeepSeek Harness（已装可跳过）
  npm install -g @deepseek-ai/dsh
  
  # 2. 装入本插件
  dsh plugin --profile ds-tui add dsh-cc-tui
  
  # 3. 启动
  #    Windows 也可用仓库里的 dsh-cc.cmd（等价，且 --resume 恢复上次会话）
  dsh --profile ds-tui
```

## And More......

配置、使用说明、技术细节和已知限制请参阅
[文档索引](docs/Index_ZH.md)       
