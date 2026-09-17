# Web 交互预览

[README](../README.md#界面预览) · [English](web-preview.en.md)

## 预览形态

这不是录屏或 HTML 仿制界面。浏览器里的 xterm.js 接收真实 Ink 渲染器生成的
ANSI 输出，键盘、鼠标与尺寸变化传回仓库的 `Chat` 组件。演示 channel 提供
固定的思考、工具结果和回复，不创建 DSH Agent、不请求模型、不执行系统命令。
界面行为来自当前检出源码；演示内容不代表真实推理或工具执行。

GitHub README 不运行脚本或交互 iframe，GitHub Pages 也不运行 Node 进程。
因此首页提供此入口，交互界面在独立网页运行。此版本是本地预览工具，
没有公共托管地址，也不是可暴露到公网的远程终端服务。

## 启动

使用 Node.js 24 和仓库指定的 pnpm 版本。先检出 PR 分支，确保三个子模块齐全：

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm compile
pnpm preview:web
```

打开终端打印的网址，默认是 `http://127.0.0.1:4173`。端口被占用会明确报错；
用 `DSH_TUI_PREVIEW_PORT` 指定新端口，或设为 `0` 由操作系统分配空闲端口。
预览脚本属于源码开发工具，不随 npm 包发布。

## 可操作范围

| 操作 | 行为 |
| --- | --- |
| 输入任意普通文本并发送 | 固定演示回合：流式思考、Read 工具卡、Markdown 回复 |
| `/theme`、`/model`、`/effort` | 原生选择菜单；模型与推理强度只改变演示状态 |
| `/vim`、全屏编辑、历史输入 | 使用真实输入组件 |
| `/thinking`、Ctrl+O、滚动 | 使用真实展示与导航逻辑 |
| `/new`、`/clear`、回溯 | 仅修改临时演示会话，不保存正式会话 |
| `/settings` | TUI 显示选项；没有真实 DSH 设置服务 |
| 网页重置按钮 | 结束旧进程并创建全新的演示会话 |
| 模型账号、文件、插件、MCP、后台 Agent | 未连接；相关操作明确提示不可用 |

每次浏览器连接使用独立进程与临时 HOME，不继承用户密钥或正式 DSH 配置。
Node 权限限制只允许读取仓库/临时目录、写入临时目录，禁用子进程、Worker
与原生扩展。服务只监听 `127.0.0.1`，验证 Host、Origin 和同源会话 Cookie，
限制消息大小、速率、终端尺寸及并发连接。断开时终止演示进程并清理临时目录。
这不是面向不可信代码的完整系统沙箱，不应代理或转发到公网。

## 验证

```sh
pnpm verify:web-preview
pnpm exec playwright install chromium
pnpm verify:web-preview-browser
```

第一项检查协议边界、资源路由、跨源连接拒绝、真实渲染、输入、缩放和进程回收。
浏览器测试覆盖桌面及移动视口、流式回复、菜单、重置和布局，并将截图写入
`.validation/web-preview/`。已有 Chrome 的环境可设置 `PLAYWRIGHT_CHANNEL=chrome`。
