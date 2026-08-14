<p align="center">
  <strong>简体中文</strong> | <a href="../en/contributing.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# 贡献指南

感谢你愿意为 dsh-TUI 做贡献。无论是修复缺陷、改善终端兼容性、补充文档，还是实现新的交互功能，都欢迎提交讨论和改动。

## 开始之前

开发环境需要：

- Node.js `^22.19` 或 `>=24`
- npm（仓库同时保留 pnpm workspace 配置，但 `package.json` 中的开发命令可直接通过 npm 运行）
- 可用的 DeepSeek Harness 环境；实际启动 TUI 时还需要有效的模型配置和交互式终端（TTY）

克隆仓库并安装依赖：

```sh
git clone https://github.com/ybh618618/dsh-TUI.git
cd dsh-TUI
npm install
```

## 了解代码结构

主要代码位于 `src/`：

- `src/index.ts`：Cordis 插件入口和配置 Schema。
- `src/plugin.ts`：创建或恢复 Agent、装配服务、挂载 TUI 和清理终端。
- `src/channel.ts`：连接 Agent 会话事件与界面状态。
- `src/screens/Chat.tsx`：聊天主界面和顶层交互编排。
- `src/components/`：消息、输入框、选择器、状态组件和设计系统。
- `src/ink/`：移植并扩展的终端 React 渲染核心，包括布局、输入事件和 ANSI 处理。
- `skills/`：随包发布的内置 Agent 技能。
- `scripts/`：启动、冒烟测试、回归验证和性能诊断工具。
- `cordis.patch.yml`：作为 dsh bundle 安装时使用的配置补丁。
- `cordis.yml`：从仓库直接运行时使用的完整 Cordis 配置。

更完整的目录说明见仓库根目录的 [`AGENTS.md`](../../AGENTS.md)。

## 本地开发

编译项目：

```sh
npm run build
```

从源码启动 TUI：

```sh
npm run tui
```

运行基础冒烟测试：

```sh
npm run smoke
```

`scripts/verify-*.mjs` 和 `scripts/verify-*.tsx` 对应具体的布局或交互回归场景。修改相关功能时，请运行最接近改动范围的验证脚本：

```sh
node scripts/verify-themes.mjs
node --import tsx/esm scripts/verify-askpanel-layout.tsx
```

部分脚本需要真实 TTY、特定终端能力或已经安装的 DeepSeek Harness。若无法运行某项验证，请在 Pull Request 中说明环境限制和已经完成的替代检查。

## 开发约定

- 项目使用 TypeScript、React 19 和 ESM。相对导入使用 `.js` 后缀，以便编译结果能够被 Node.js 正确加载。
- 优先使用 `src/ui.ts` 暴露的主题化组件和 `src/components/design-system/` 中的设计原语。
- 不要手工修改 `lib/types/` 中由 TypeScript 生成的文件；修改 `src/` 后运行构建命令。
- 修改 `src/ink/` 时，同时考虑 Unicode 显示宽度、ANSI 序列、键盘和鼠标事件、终端状态恢复，以及 inline/fullscreen 两种渲染模式。
- 修改会话恢复、Agent preset 或工具装配时，同时核对 `src/plugin.ts`、`src/channel.ts` 和 Cordis 配置。
- 用户可见文案或行为发生变化时，请同步更新 `docs/zh/`、`docs/en/` 以及必要的 README 内容。
- 保持改动聚焦，不要在同一个 Pull Request 中混入无关的重构或格式化。

## 建议的贡献流程

1. 先搜索现有 Issue 和 Pull Request，确认问题是否已经有人处理。
2. 对较大的功能或架构变更，先创建 Issue，说明使用场景、交互方案和兼容性影响。
3. 从最新代码创建独立分支，并提交范围明确的小步改动。
4. 添加或更新与改动对应的验证脚本和双语文档。
5. 至少运行 `npm run build`；涉及渲染或交互时，再运行 `npm run smoke` 和相关回归脚本。
6. 提交 Pull Request，并清楚描述问题、实现方式、验证结果和已知限制。

## Pull Request 清单

提交前请确认：

- [ ] 改动只包含当前问题所需的内容。
- [ ] `npm run build` 已通过。
- [ ] 已运行适用于本次改动的冒烟测试或回归脚本。
- [ ] 新增行为有相应测试、验证脚本或可复现步骤。
- [ ] 用户可见变化已同步更新中英文文档。
- [ ] 终端 UI 改动已在适用的 inline/fullscreen 模式和目标平台上检查。
- [ ] Pull Request 描述包含验证命令和结果；未执行的检查也注明了原因。

## 报告问题

提交缺陷时，请尽量提供：

- 操作系统、终端模拟器及其版本
- Node.js、dsh 和 dsh-TUI 版本
- 使用的 inline 或 fullscreen 模式
- 最小复现步骤、预期结果和实际结果
- 必要的日志、截图或终端输出（请先移除 API Key、访问令牌、路径中的隐私信息及其他敏感数据）

终端渲染问题通常与终端能力、窗口尺寸、Unicode 字符宽度或 ANSI 支持有关，完整的环境信息会显著加快定位。
