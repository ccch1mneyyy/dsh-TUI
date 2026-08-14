<p align="center">
  <a href="README_ZH.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <img src="screenshots/splash.png" alt="dsh-cc-tui — Claude Code-style terminal TUI for DeepSeek Harness" width="100%">
</p>

# dsh-TUI

> DeepSeek Harness currently has no official terminal TUI (only a Web UI), so I built dsh-cc-tui!

![Type](https://img.shields.io/badge/type-cordis%20plugin-blue) ![Status](https://img.shields.io/badge/status-public%20beta-blue) ![Official feature](https://img.shields.io/badge/DeepSeek%20Harness-featured-brightgreen)

## 🎉 Featured by DeepSeek Harness

This plugin was featured by the **official DeepSeek Harness WeChat account** as a selected early-access community plugin:

<p align="center">
  <img src="screenshots/wechat-official.png" alt="dsh-cc-tui featured by the official DeepSeek Harness WeChat account" width="560">
</p>

## Interface Preview

![Start screen with pixel whale header](screenshots/splash.png)

![Live activity line and context meter](screenshots/working-line.png)

## Why Install It: Beautiful and Easy to Use

- **Live activity line**: the model's live activity remains visible above the input while it works,
  with dozens of status variations.
- **Model state at a glance**: the bottom status bar shows the current model state and
  `git branch · working directory · session title` on the right.
- **Streaming thoughts remain visible**: thinking blocks expand while they are generated,
  collapse at the end of a turn, and can be expanded at any time with Ctrl+O.
- **Double-Esc time rewind**: roll the conversation back to any historical message.
- **And more features waiting to be discovered...**

## How to Install

```sh
  # 1. Install DeepSeek Harness (skip if already installed)
  npm install -g @deepseek-ai/dsh

  # 2. Install this plugin
  dsh plugin --profile ds-tui add dsh-cc-tui

  # 3. Start it
  #    On Windows, you can also use dsh-cc.cmd from this repository
  #    (equivalent, with --resume to restore the previous session)
  dsh --profile ds-tui
```

## And More......

For configuration, usage details, technical notes, and known limitations, see
[the documentation index](docs/Index_EN.md).
