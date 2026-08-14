
## 项目代码结构

```text
dsh-TUI/
├── src/                         # TypeScript 主源码
│   ├── index.ts                 # Cordis 插件公共入口、配置 Schema 与 apply 转发
│   ├── plugin.ts                # TUI 启动、Agent 创建/恢复、服务装配与退出清理
│   ├── channel.ts               # Agent 会话事件、消息提交及 TUI 状态之间的通道
│   ├── commands.ts              # 斜杠命令解析与分发
│   ├── questions.ts             # ask_user_question 请求状态管理
│   ├── presets.ts               # Agent preset 解析、组合与恢复
│   ├── packaged-skills.ts       # 仓库内置技能的注册入口
│   ├── history.ts               # 对话历史相关逻辑
│   ├── sessionHistory.ts        # 会话恢复目标等本地历史记录
│   ├── *Prefs.ts                # 模型、主题、推理强度、活动样式等偏好持久化
│   ├── theme.ts                 # 主题定义与语义色
│   ├── customTheme.ts           # 自定义主题加载
│   ├── ui.ts                    # 对外导出的 TUI/Ink 组件与 Hooks 门面
│   ├── screens/                 # 页面级界面
│   │   ├── Chat.tsx             # 主聊天界面与交互编排
│   │   ├── StatusLine.tsx       # 底部状态栏
│   │   └── StatusMetrics.ts     # 状态指标计算
│   ├── components/              # 业务 UI 组件
│   │   ├── design-system/       # 主题化基础组件与视觉规范
│   │   ├── messages/            # 用户、助手、思考和工具调用消息
│   │   ├── questions/           # 用户问答面板
│   │   └── Spinner/             # 工作动画及停滞检测
│   ├── ink/                     # 项目内置的终端 React 渲染核心
│   │   ├── components/          # Box、Text、ScrollBox、AlternateScreen 等原语
│   │   ├── hooks/               # 输入、终端尺寸、选区、焦点等 Hooks
│   │   ├── events/              # 键盘、鼠标、粘贴、焦点和窗口事件
│   │   ├── layout/              # 布局节点、几何计算与 Yoga 适配
│   │   └── termio/              # ANSI/CSI/OSC 等终端控制序列解析
│   ├── native-ts/yoga-layout/   # Yoga 布局 API 的 TypeScript 实现/适配
│   ├── cc/                      # Claude Code 风格格式、Markdown 和终端表现辅助
│   ├── hooks/                   # 项目级 React Hooks
│   ├── utils/                   # 日志、环境、剪贴板、ANSI、国际化等通用工具
│   ├── bootstrap/               # 启动期共享状态
│   └── types/                   # 外部模块或兼容层类型声明
├── skills/                      # 随 npm 包发布的内置 Agent 技能
├── scripts/                     # 构建、启动、冒烟测试、回归验证和性能诊断脚本
├── docs/
│   ├── en/                      # 英文专题文档
│   ├── zh/                      # 中文专题文档
│   ├── Index_EN.md              # 英文文档索引
│   └── Index_ZH.md              # 中文文档索引
├── screenshots/                 # README 使用的界面截图
├── lib/                         # TypeScript 构建产物（主要输出到 lib/types）
├── cordis.patch.yml             # 安装为 bundle 时叠加到 dsh-base 的配置补丁
├── cordis.yml                   # 从仓库直接启动时使用的完整 Cordis 配置
├── dsh-cc.cmd                   # Windows 启动脚本
├── install.sh                   # 安装辅助脚本
├── package.json                 # 包元数据、依赖与 npm scripts
└── tsconfig.json                # TypeScript 编译配置
```

## 核心调用关系

1. Cordis 加载 `src/index.ts`，校验配置后动态导入 `src/plugin.ts`。
2. `src/plugin.ts` 创建或恢复 Agent，注册问答 Provider 和内置技能，并建立 `channel`。
3. `src/screens/Chat.tsx` 通过 `channel` 消费会话事件、提交用户输入并组织各业务组件。
4. `src/ui.ts` 暴露主题化组件；底层由 `src/ink/` 完成布局、事件处理和 ANSI 终端渲染。
5. `cordis.patch.yml` 定义作为正式 dsh bundle 使用时的服务组合；`cordis.yml` 用于仓库内独立运行和调试。

## 常用命令

```sh
npm install          # 安装依赖
npm run build        # 使用 tsc 编译，输出到 lib/types
npm run tui          # 通过 scripts/run.ts 启动本地 TUI
npm run smoke        # 运行终端渲染冒烟测试
```

`scripts/verify-*.mjs` 和 `scripts/verify-*.tsx` 是针对特定交互或布局问题的回归验证脚本，可用 `node`（JS）或 `node --import tsx/esm`（TS/TSX）单独执行。

## 修改约定

- 项目使用 ESM；源码中的相对导入保留 `.js` 后缀，以匹配编译后的模块路径。
- UI 代码优先复用 `src/ui.ts` 暴露的主题化组件，避免绕过设计系统直接依赖底层 Ink 原语。
- 修改 `src/ink/` 时要同时关注终端状态恢复、Unicode/ANSI 宽度、输入事件和 inline/fullscreen 两种模式。
- 修改会话、恢复、preset 或工具装配逻辑时，应同时检查 `src/plugin.ts`、`src/channel.ts` 与 `cordis.patch.yml` 的职责是否仍一致。
- 不要手工编辑编译生成的声明文件；源码改动后通过 `npm run build` 更新构建产物。
- 提交前至少运行 `npm run build`；涉及渲染或交互时，再运行 `npm run smoke` 以及相关的 `scripts/verify-*` 回归脚本。
- 仓库可能包含用户尚未提交的改动；只修改当前任务涉及的文件，不覆盖或回退无关变更。
