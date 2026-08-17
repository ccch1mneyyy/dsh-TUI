# dsh-TUI 插件 UI API

[文档索引](README.md) · [现有插件开发指南](plugins.md)

> 状态：设计草案（Draft）
>
> 目标版本：随 dsh-TUI 主包发布
>
> 本文描述计划中的公共契约，不代表所有接口已经实现。

本文定义面向 **dsh-TUI 专属插件** 的 UI API。它的目的不是把 dsh-TUI 变成可任意
换壳的 UI 框架，而是让插件开发者能够用较少代码增加功能，并复用 dsh-TUI 已有的
通知、选择器、表单、工具卡和全屏页面效果。

Plugin UI API 保留在 dsh-TUI 主仓库和主 npm 包中，与 dsh-TUI 一起版本化和发布。
当前不拆分独立仓库、独立运行时或独立插件加载器。

## 1. 目标

Plugin UI API 必须满足以下目标：

1. 为插件提供足够的常用 UI 能力，使新增功能不需要复制 dsh-TUI 内部组件。
2. 由宿主控制布局、主题、键盘、滚动、窄终端降级和错误边界，保持核心界面稳定。
3. 插件主要提交结构化数据和行为回调，而不是替换核心 React 组件。
4. API 只补充 DSH 官方没有的 UI 能力，不重新设计命令、Session、Agent、Tool、
   Settings、Approval、Questions、Skill 或 System Prompt API。
5. 插件卸载后，所有 UI 贡献都能被完整移除，不留下焦点、页面或注册项。

## 2. 非目标

本轮不追求以下能力：

- 替换聊天主界面、消息列表、输入框或状态栏整体布局；
- 任意位置插入 React 组件；
- 覆盖内置消息、审批、问卷或工具卡的核心交互；
- 注册全局快捷键或改变 dsh-TUI 的键位优先级；
- 直接访问 `Channel`、`ChatRow`、modal 状态或 renderer 内部对象；
- 直接控制 alternate screen、stdout、光标或终端协议；
- 设计新的命令、Session、Agent、Tool、Settings 或权限 API；
- 建立独立插件 SDK 仓库、独立版本线或跨前端 UI 标准。

## 3. 与 DSH 官方 API 的边界

| 需求 | 所有者 | dsh-TUI 插件的使用方式 |
| --- | --- | --- |
| 注册和执行 Slash Command | DSH `commands` | 使用官方 API；dsh-TUI 只补充菜单和子命令展示 |
| 读取 Session/Agent 状态 | DSH Session/Agent | 使用官方事件；dsh-TUI 只提供当前界面选中的会话引用 |
| 注册 Tool、Skill、Prompt 或 preset | DSH 对应服务 | 直接使用官方 API |
| 保存设置和凭据 | DSH Settings/Credentials | 使用官方存储；dsh-TUI 只声明设置页面的展示信息 |
| 模型问用户问题 | DSH `userQuestions` | 使用官方问卷流程 |
| 工具审批 | DSH `approval` | 使用官方审批流程 |
| 状态栏文本槽位 | 官方 `tuiPrompt` | dsh-TUI 提供兼容实现 |
| 通知、选择器、表单、补全、附加展示和完整页面 | dsh-TUI | 使用本文定义的 UI API |

## 4. 设计原则

### 4.1 收敛为 `ctx.tui`

对外 UI 能力统一收敛到 `ctx.tui`。现有 `tuiScenes`、`tuiSettingsSections` 和
`tuiCommandTrees` 可以保留为兼容入口，但新文档和新插件统一使用聚合服务。

`ctx.tui` 只负责组织 dsh-TUI UI 服务，不接管 DSH 官方服务，也不改变 Cordis 的插件
生命周期。

### 4.2 宿主托管优先

通知、确认、选择、输入、表单、transcript 附加内容和工具展示优先由宿主渲染。
插件只提供标题、描述、选项、状态、结构化正文和回调。

这样可以统一：

- 主题、颜色和间距；
- `Esc`、`Enter`、方向键和搜索行为；
- loading、empty、error、disabled 和 cancelled 状态；
- 长文本、全宽字符和窄终端布局；
- 列表虚拟化、滚动和焦点；
- inline/fullscreen 差异；
- 插件异常和卸载清理。

### 4.3 只允许附加，不允许替换

普通 UI API 只能添加内容，不能替换核心界面。例如：

- transcript renderer 可以展示插件事件，但不能替换用户或 assistant 正文；
- tool presentation 可以补充插件工具的卡片内容，但不能改变内置审批语义；
- input completion 可以提供候选，但不能拦截 Enter 或改写整个 prompt；
- settings section 可以添加字段，但不能替换 `/settings` 页面。

### 4.4 全屏场景是受控逃生舱

只有无法由宿主托管控件表达的功能才使用 Scene，例如 Dashboard、浏览器或监控页。
Scene 与聊天主界面隔离，由宿主管理进入、退出、错误边界和 alternate screen。

Scene 可以使用稳定 UI Kit，但不能获得完整 `Channel`，也不能改变聊天主界面的布局。

### 4.5 API 缺失时必须降级

插件必须先检查宿主能力。某个可选 UI API 不存在时，应退化为命令文本结果、普通通知
或不显示附加内容，不能阻止 dsh-TUI 启动。

## 5. 实现优先级和里程碑

工程量按单人估算，包含公共类型、实现、自动化测试、示例和对应文档：S 不超过 2
人日，M 为 3–5 人日，L 为 6–10 人日。

| 顺序 | 里程碑 | API | 描述 | 用户效果 | 当前状态 | 工程量 | 价值 |
| ---: | --- | --- | --- | --- | --- | ---: | ---: |
| 1 | M0 服务收敛 | `ctx.tui` | 聚合全部 dsh-TUI UI 服务和能力检测 | 插件只依赖一个稳定入口 | 计划新增 | M | 5/5 |
| 2 | M0 服务收敛 | `tui.activeView` | 提供当前界面选中的 agent/session 和页面状态 | 插件 UI 自动跟随 `/new`、`/resume` 和切换 | 内部已有状态 | S | 5/5 |
| 3 | M0 服务收敛 | `tuiPrompt` 兼容 | 实现官方状态文本槽位 | 现有状态插件可直接显示在 dsh-TUI | 尚未提供 | M | 5/5 |
| 4 | M0 服务收敛 | `tui.commandTrees` | 为 DSH 命令提供层级菜单和补全信息 | Slash 菜单显示插件子命令 | 已实现 | S | 4/5 |
| 5 | M0 服务收敛 | `tui.settingsSections` | 声明插件设置区块 | 插件配置进入统一 `/settings` 页面 | 已实现 | S | 4/5 |
| 6 | M1 托管交互 | `tui.presentation.notify()` | 显示托管通知 | 统一成功、警告、错误和超时效果 | 可复用现有通知 | S | 5/5 |
| 7 | M1 托管交互 | `tui.presentation.confirm()` | 显示托管确认框 | 统一确认、取消和危险操作提示 | 计划新增 | M | 5/5 |
| 8 | M1 托管交互 | `tui.presentation.select()` | 显示托管单选或多选列表 | 自动获得搜索、滚动、空状态和键盘导航 | 可复用现有 Picker | L | 5/5 |
| 9 | M1 托管交互 | `tui.presentation.input()` | 显示托管文本输入 | 自动获得光标、校验、提交和取消行为 | 可复用 PromptInput | M | 5/5 |
| 10 | M1 托管交互 | `tui.presentation.form()` | 显示声明式表单 | 插件向导无需自建页面和焦点状态机 | 可从 Settings 抽取 | L | 4/5 |
| 11 | M2 对话扩展 | `tui.transcript.registerEventPresentation()` | 为插件事件提供受控展示 | 插件状态自然进入 transcript | 计划新增 | L | 5/5 |
| 12 | M2 对话扩展 | `tui.transcript.registerToolPresentation()` | 为插件工具提供受控 ToolCard 内容 | 工具调用与内置工具保持一致 | 计划新增 | L | 5/5 |
| 13 | M2 对话扩展 | `tui.inputCompletions.register()` | 注册非 Slash 输入候选 | 支持自定义资源、实体和远程对象补全 | 计划新增 | M | 4/5 |
| 14 | M3 高级页面 | `tui.scenes` | 注册和打开受控全屏页面 | 支持 Dashboard、浏览器和监控页 | 已实现，需移除 `Channel` | M | 4/5 |
| 15 | M3 高级页面 | `tui.sceneUi` | 提供 Scene 使用的有限稳定组件集合 | Scene 不需要复制主题、列表和状态组件 | 内部组件待收敛 | L | 4/5 |
| 16 | M3 稳定化 | UI fixture/test helpers | 提供固定终端尺寸和交互测试辅助 | UI 文档和真实效果保持同步 | 计划新增 | M | 4/5 |

## 6. M0：服务收敛

### 6.1 `ctx.tui`

`ctx.tui` 是 dsh-TUI UI API 的唯一推荐入口，负责：

- 暴露当前 API 版本；
- 查询可用能力；
- 提供 `activeView`、`presentation`、`commandTrees`、`settingsSections`、
  `transcript`、`inputCompletions` 和 `scenes`；
- 将注册项绑定到插件生命周期；
- 在插件卸载时统一清理。

Plugin UI API 与 dsh-TUI 主包一起版本化，不建立独立版本线。破坏性变更随 dsh-TUI
主版本处理，实验性能力必须明确标记。

### 6.2 `tui.activeView`

`activeView` 只提供当前界面选择状态，例如 agent ID、session ID、当前是否处于 Scene、
终端宽高和 fullscreen 状态。

它不复制 Session 内容、Agent 状态、模型信息或工具数据。插件需要这些业务数据时，
继续使用 DSH 官方 API。

### 6.3 `tuiPrompt`

dsh-TUI 实现官方 `tuiPrompt` 文本槽位协议，用于状态栏中的短文本贡献。宿主负责槽位
排序、宽度分配、截断和隐藏策略。

插件不能通过槽位改变状态栏整体布局，也不能写入多行内容。

### 6.4 Command Trees

`tui.commandTrees` 只负责 DSH 命令的菜单展示和子命令补全，不注册、不代理也不执行
命令。

宿主负责 loading、empty、error、取消和插件卸载后的菜单关闭。

### 6.5 Settings Sections

`tui.settingsSections` 只声明字段如何显示。设置值、Schema、revision、凭据和持久化
继续由 DSH Settings/Credentials 服务拥有。

首版只支持常用字段：文本、数字、布尔、单选和 secret reference。复杂数组、字典和
自定义 React 字段不进入首版。

## 7. M1：托管交互

### 7.1 Notification

通知支持普通、成功、警告和错误语义，以及可选超时和去重标识。宿主控制通知位置、
颜色、宽度和生命周期。

通知只属于当前 UI，不写入 Session、transcript 或模型上下文。

### 7.2 Confirm

Confirm 用于普通插件操作确认。宿主控制焦点、确认/取消键位、危险态和异步取消。

模型问卷和工具审批禁止通过 Confirm 实现，必须使用 DSH 官方 API。

### 7.3 Select

Select 接收标题和结构化选项，支持单选、多选、搜索和禁用项。宿主控制列表布局、
虚拟化、滚动、键盘和空状态。

插件不能传入自定义行组件、行高或方向键处理器。

### 7.4 Input 和 Form

Input 支持单行、多行、secret、placeholder 和校验。Form 复用 Settings 的基础字段，
用于配置向导和临时操作参数。

宿主控制输入框、光标、错误提示、提交和取消。插件不直接复用内部 `PromptInput` props。

### 7.5 焦点和并发

dsh-TUI 同时只允许一个托管交互拥有键盘。Approval 和 userQuestions 的优先级高于插件
交互；插件交互被抢占时必须暂停或取消，不能继续消费按键。

插件卸载、宿主 teardown 或调用方取消时，打开和排队的交互必须全部结束。

## 8. M2：对话扩展

### 8.1 Event Presentation

Event Presentation 用于展示插件通过 DSH Session API 产生的事件。插件提交有限的
结构化内容，例如文本、状态、代码、Diff、表格、提示或折叠组，宿主负责最终布局。

该 API 只能增加展示，不能修改事件、替换用户/assistant 正文或影响其他前端。

同一事件类型首版只允许一个主展示提供者，避免加载顺序改变结果。

### 8.2 Tool Presentation

Tool Presentation 用于描述插件工具卡的标题、摘要、运行状态和结构化正文。宿主复用
统一 ToolCard 外框、状态点、折叠、长输出裁剪、Diff 和 verbose 模式。

插件不能改变工具执行、审批、取消或 Session 记录语义。

### 8.3 Input Completions

Input Completion 提供触发符、候选项和插入文本。宿主负责搜索、菜单、焦点、滚动和
Tab/Enter 行为。

该 API 不允许拦截发送、改写整个 prompt、接管输入框或注册全局快捷键。Slash Command
继续由 `commandTrees` 处理。

## 9. M3：高级页面

### 9.1 Scenes

Scene 用于无法由托管控件表达的完整页面。宿主负责打开、关闭、alternate screen、
错误边界、焦点归还和卸载清理。

Scene 不再接收完整 `Channel`。它只能获得当前界面引用、关闭能力、取消信号和有限的
Scene UI Kit。业务数据继续由插件通过 DSH 官方 API 获取。

Scene 不能覆盖聊天主界面，也不能在关闭后保留键盘或终端状态。

### 9.2 Scene UI Kit

Scene UI Kit 只提供构建 dsh-TUI 风格页面所需的有限组件：

- 主题化布局和文本；
- Pane、Divider 和标准提示行；
- List、Search、Select 和滚动容器；
- Loading、Empty、Error 和 Disabled 状态；
- Markdown、Progress、Diff 和只读 ToolCard；
- 终端尺寸和受控输入 Hook。

不公开 renderer root、alternate-screen 控制、原始 stdout、终端协议和内部消息组件。
Scene UI Kit 的目标是复用现有视觉，不是支持任意重构 dsh-TUI。

## 10. 核心界面稳定性红线

任何插件 API 都必须遵守以下红线：

1. 不能替换 `Chat`、`MessageList`、`PromptInput` 或 `StatusLine` 根组件。
2. 不能改变内置 modal、approval、questionnaire 和 input 的优先级。
3. 不能注册全局快捷键；Scene 只能在打开期间处理自己的局部输入。
4. 不能向活动 TUI 的 stdout 写入内容。
5. 不能绕过宿主的文本消毒、cell width、行数和条目数限制。
6. 不能让插件 renderer 或 Scene 异常终止聊天主界面。
7. 不能把 UI 状态自动写入 Session 或模型上下文。
8. 不能依赖私有 `src/*` 路径、内部 React props 或未公开 Ink API。

## 11. 文本、国际化和降级

插件提供的可见文本按不可信 UI 数据处理。宿主负责：

- 剥离控制字符；
- 按 terminal cell width 截断；
- 处理 ANSI、组合字符、emoji 和东亚全宽字符；
- 限制通知、列表项、表格、代码和工具输出的大小；
- 非法内容局部丢弃并记录非敏感警告；
- 在 80 列窄终端和 120 列宽终端下提供确定布局。

宿主渲染的标题、标签、描述、提示和空状态应支持当前 `/lang`。缺少翻译时使用插件
提供的默认文本。

API 不可用或贡献无效时，宿主应隐藏该贡献或使用普通文本降级，不能影响核心 UI。

## 12. 生命周期和错误处理

每个注册 API 都必须返回幂等清理函数，并绑定到插件的 Cordis 生命周期。

宿主必须隔离以下失败：

- 重复 ID：拒绝后来注册项；
- renderer 返回非法数据：忽略该贡献并使用默认展示；
- Scene 渲染异常：关闭 Scene 并显示通知；
- 异步交互取消：结束 Promise 并释放焦点；
- 插件卸载：清理其通知、菜单、设置区块、renderer、补全和 Scene。

单个 UI 插件不得让 dsh-TUI 启动失败或退出聊天主界面。

## 13. 文档和验收要求

每个公开 API 必须同时具备：

1. 主包导出的 TypeScript 类型；
2. 简短用途说明和最小使用示例；
3. loading、empty、error、cancelled 和 unavailable 状态说明；
4. 80 列和 120 列终端 fixture；
5. 中文、英文、超长文本和全宽字符 fixture；
6. 注册、重复注册、卸载和异步取消测试；
7. 关键效果的确定性 ANSI snapshot 或截图；
8. API 状态和适用的最低 dsh-TUI 版本。

测试辅助保留在 dsh-TUI 主仓库和主包中，不建立独立 testkit 仓库。

## 14. 里程碑验收

### M0：服务收敛

- `ctx.tui` 和能力检测可用；
- 现有三个 registry 可通过统一入口访问；
- `activeView` 和 `tuiPrompt` 可用；
- 旧入口保持兼容，不要求已有插件立即迁移。

### M1：托管交互

- 插件可使用通知、确认、选择、输入和表单完成常用交互；
- 至少两个示例插件不自行实现 modal、Picker 或输入状态机；
- 所有交互覆盖 inline/fullscreen、80/120 列终端和卸载清理。

### M2：对话扩展

- 插件事件和工具可以使用宿主统一展示；
- renderer 失败不会破坏 transcript 或虚拟化；
- 输入补全可与 Slash 和文件补全共存；
- 插件不能替换核心消息或输入行为。

### M3：高级页面和稳定化

- Scene 不再暴露 `Channel`；
- Scene 使用有限 UI Kit 并通过错误边界；
- 公共 API 的文档 fixture 和回归测试进入 CI；
- 形成随 dsh-TUI 发布的 UI API compatibility matrix。

## 15. 现有接缝迁移

| 现有接缝 | 处理方式 |
| --- | --- |
| `tuiCommandTrees` | 保留，内部接入 `ctx.tui.commandTrees` |
| `tuiSettingsSections` | 保留，内部接入 `ctx.tui.settingsSections` |
| `tuiScenes` | 保留 registry 语义，在稳定前移除 `Channel` props |
| `jsx-runtime` | 保留，继续作为 Scene 的宿主 React runtime |
| `src/ui.ts` | 只选择 Scene 必需的稳定组件进入公共出口 |
| 自定义主题 JSON | 继续作为现有静态资产能力，不增加运行时主题定制 API |
| 插件 Session 事件 | 继续由 DSH API 产生，dsh-TUI 只增加受控展示 |

## 16. 待确认决策

实现前需要确认：

1. `ctx.tui` 聚合服务的首批 capability 名称；
2. 托管交互采用 FIFO 排队还是 busy-fast-fail；
3. Event/Tool Presentation 的首批结构化内容类型；
4. Scene 移除 `Channel` 是否需要一个短期兼容窗口；
5. Scene UI Kit 的最小稳定组件集合。

这些决策冻结后，文档从 Draft 进入 Experimental，并随实际实现更新“当前状态”和
最低版本信息。
