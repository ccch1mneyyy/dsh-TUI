# 插件开发指南

[文档索引](README.md) · [English](plugins.en.md)

本文档面向想在 dsh-TUI 生态里做插件/扩展的开发者。`@deepseek-harness-tui/dsh-tui`
是单包、纯 ESM 的 TypeScript 项目，通过 Cordis 挂载到 DeepSeek Harness。
生态插件与主包的关系：**主包只负责交互与呈现，插件负责在既有接缝上补充能力**。

生态起点：

- 插件作者指南（本文档）
- 组织：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)（社区插件与模板的家）
- 模板仓库：[plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)
- 参考实现：`dsh-working-activity`（实时工作状态行，双出口：TUI 槽位 + 会话事件）

## 插件形态

dsh-TUI 生态里有三种插件，难度递增：

| 形态 | 例子 | 需要代码 |
| --- | --- | --- |
| 静态资产 | 主题 JSON（`~/.dsh-tui/themes/<名字>.json`） | 否 |
| 打包技能 | `skills/<name>/SKILL.md` 随包分发 | 否（只要 Markdown） |
| Cordis 运行时插件 | `dsh-working-activity` | 是（TypeScript） |

本文档重点讲运行时插件，因为它是能力最强的形态；静态资产见
[主题系统](themes.md) 与下文"技能接缝"。

## 插件契约

每个运行时插件就是一个 Cordis 插件，导出固定的三个面：

```ts
export const name = 'my-plugin'          // Cordis 行 id 使用的名字
export type Config = { … }               // 配置类型
export const Config: Schemastery<Config> = Schema.object({ … })  // 配置 Schema
export function apply(ctx: Context, config: Config): void { … }  // 入口
```

- **无默认导出**；包根只导这三个面。
- 所有配置键必须有默认值（`Schema.…().default(…)` 或 apply 内的 `??` 兜底），
  插件缺失时行为退化为"什么都没发生"，绝不能让 TUI 启动失败。
- 资源清理走 `ctx.effect(() => () => { … })`，插件卸载时一并释放。
- 可选接缝用 `ctx.get('service', false)` 探测，不存在时静默降级，不要报错。

最小 `package.json` 骨架（完整参考
[dsh-working-activity](https://github.com/ccch1mneyyy/dsh-working-activity)）：

```jsonc
{
  "name": "my-plugin",
  "type": "module",
  "main": "lib/types/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/types/index.js" } },
  "files": ["lib", "skills"],
  "engines": { "node": "^22.19 || >=24" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

TypeScript 相对导入必须带 `.js` 后缀（ESM）；构建用 `tsc` 输出到 `lib/types/`。

## 接缝总览

| 接缝 | 形态 | 用途 |
| --- | --- | --- |
| 一 · 会话事件 | cordis 事件 | 观察模型/会话状态；追加 log-only 事件 |
| 二 · TUI prompt 槽位 | 官方宿主服务 | 官方 TUI 的提示行槽位（dsh-TUI 不提供） |
| 三 · 技能打包 | 静态资产 | 随包分发 SKILL.md |
| 四 · 主题 | 静态资产 | JSON 配色 |
| 五 · system prompt 段 | cordis 服务 | 注入稳定提示词段 |
| 六 · 设置区块 | `ctx.tuiSettingsSections` | `/settings` 声明式编辑区块 |
| 七 · profile 组合 | cordis.patch.yml | 安装/配置行 |
| 八 · 全屏场景 | `ctx.tuiScenes` | 整屏 React 页面（`/trace` 形态） |
| 九 · 决策事件 | cordis serial/parallel 事件 | 拦截/改写输入、rewind、会话切换、压缩 |
| 十 · 托管对话框 | `ctx.tuiDialogs` | select / confirm / input 弹窗 |
| 十一 · 状态行 | `ctx.tuiStatus` | 提示框上方的键控状态行 |
| 十二 · 键盘快捷键 | `ctx.tuiShortcuts` | 注册全局组合键 |
| 十三 · 条目渲染器 | `ctx.tuiRenderers` | 自定义会话事件 → transcript 文本行 |

接缝九~十三统称**扩展面**（dsh-tui-extensions）。类型增强（`Context` 上的
四个服务、`Events` 上的决策事件）从一个导入获得：

```ts
import type {
  TuiInputEvent, TuiInputDecision,
  TuiRewindPromptEvent, TuiRewindPromptDecision, TuiRewindMode, TuiRewindDoneEvent,
  TuiSessionSwitchEvent, TuiSessionSwitchDecision, TuiSessionSwitchedEvent,
  TuiCompactEvent, TuiCompactDecision,
} from '@deepseek-harness-tui/dsh-tui/extensions'
```

四个服务由主包的 `dsh-tui-extensions` 行挂载（cordis.patch.yml 已带），插件
无需也不应自己再挂。消费一律走 `ctx.get('tuiDialogs', false)` 软探测——旧版
profile 可能还没有这一行，探测不到就静默降级（#183 原则），绝不要让可选服务
缺席拖垮启动。

扩展面的统一纪律（每个接缝一节里不再重复）：

- **本地优先**：插件永远遮蔽不了内建——快捷键保留位、内建事件类型、内建
  命令全都先于插件生效；冲突注册被拒绝并告警，不抛错。
- **渲染路径字符串按不可信输入处理**：宿主统一剥离 C0/C1 控制字符、折叠
  空白、按 terminal cell（不是 `string.length`）截断。
- **插件崩溃不拖垮 TUI**：监听器/处理器抛错被宿主捕获、告警、按"无意见"
  或"跳过该条目"处理。

## 接缝一：会话事件（dsh-TUI 原生消费）

dsh-TUI 的 Channel 把持久化会话事件投影为 transcript。**会话事件是真源**：
`session/event`、`agent/status` 是观察模型状态的标准入口。

```ts
ctx.on('session/event', (session, event) => {
  // event.type: 'turn/start' | 'assistant/chunk' | 'tool/call' | 'tool/result' | 'turn/end' | …
})
ctx.on('agent/status', ({ agent, status }) => { /* agent.session、status */ })
ctx.on('session/disposed', (session) => { /* 清理 per-session 状态 */ })
```

### 自己发 log-only 事件：两条铁律

插件可以向 `session.append(type, payload)` 追加自己的事件类型，供其他 UI 消费
（dsh-TUI 就是这么消费 `activity/status` 的）。但有两条铁律，踩了会让整个会话
**无法 resume**：

1. **必须是 log-only 事件**（无 `surfaceOp`）：模型永远看不到，只做 UI 状态。
2. **必须注册事件类型**：dsh-session 的严格读取路径会拒绝包含"未知且不可忽略
   事件类型"的日志。`session.append()` 不暴露 ignorable 标记，所以插件必须像
   `dsh-working-activity/src/registration.ts` 那样，把类型名写进**每个可达的**
   dsh-session 副本的 `KNOWN_SESSION_EVENT_TYPES`（锚点：`import.meta.url` 与
   `process.argv[1]`，幂等、永不抛错）。

类型声明用 `declare module` 合并：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'my/event': MyEventPayload
  }
}
```

> dsh-TUI 的 profile 自身带兼容修复（`src/compat/sessionLog.ts`），会修补第三方
> 事件类型，所以在 dsh-tui profile 里 resume 依然可用；但裸组合、Web 或其他
> headless 消费者没有这层修复——注册仍然必须做。

## 接缝二：TUI prompt 槽位（官方宿主接缝）

官方 DSH TUI 宿主会在 `ctx.tuiPrompt` 上提供槽位注册服务。组合存在时：

```ts
const prompt = ctx.get('tuiPrompt', false) as TuiPromptLike | undefined
const handle = prompt?.register('my-slot', undefined)  // { set(value?), dispose() }
handle?.set('实时内容')  // 模板里 ${my-slot} 的值
```

槽位名出现在 `theme.leftPrompt` 模板里（如
`'${cwd}${git/worktree}${activity}${model}…'`）；模板没有该槽位时插件静默无效果。

注意：**dsh-TUI 本身不提供 `tuiPrompt` 服务**——它直接消费 `activity/status`
事件渲染工作状态行（见 `src/channel.ts` 与 `src/components/ActivityLine.tsx`）。
如果你的插件同时面向官方 TUI 和 dsh-TUI，就采用 `dsh-working-activity` 的
**双出口**模式：槽位给官方 TUI，log-only 事件给 dsh-TUI 与其他消费者。

## 接缝三：技能打包

`dsh-working-activity` 之外的另一个零代码出口。把 `SKILL.md` 放进包的
`skills/<名字>/SKILL.md`，在 apply 里通过 DSH 技能注册表注册：

```ts
const registry = ctx.get('skills') as SkillRegistryLike | undefined
registry?.register({
  name: 'my-skill',
  description: '一行描述（前端单行标量）',
  content: 'SKILL.md 正文',
  path: 'skills/my-skill/SKILL.md',
  provider: 'my-plugin',
  source: 'bundled',
})
```

参考主包 `src/packaged-skills.ts`：单行标量 frontmatter（`name`、`description`），
重复或无效条目跳过，**绝不让技能注册失败拖垮 TUI 启动**。注册成功后技能即可
通过 DSH 的 `/skill` 面使用。

## 接缝四：主题（静态资产，零代码）

用户把 JSON 放进 `~/.dsh-tui/themes/<名字>.json` 即可热切换：

```json
{
  "name": "sakura",
  "displayName": "樱花粉",
  "base": "dark",
  "colors": { "claude": "#FF9EC7", "text": "#E8E6E0", "selectionBg": "#5C3A44" }
}
```

- `base`（`light`/`dark`/`dark-ansi`）是必填的未覆盖颜色来源；`colors` 是
  `Theme` 语义键的部分覆盖，完整键表见 [`src/theme.ts`](../src/theme.ts)。
- 主题文件按**不可信输入**处理：未知键/非法颜色被跳过并警告，损坏文件整体
  丢弃，文件名不能逃出主题目录——你的主题插件也要遵守同样的宽容度。
- 完整契约见[主题系统](themes.md)。

## 接缝五：system prompt 段注入

稳定的提示词段通过 `systemPrompt` 服务注入，随插件 fiber 自动移除：

```ts
ctx.inject(['systemPrompt'], (promptCtx) => {
  promptCtx.systemPrompt.section({
    name: 'my-plugin:narrate',
    order: 60,          // 段排序；别和既有段冲突
    text: '…',
  })
})
```

注入的内容会进入每个请求的 system prompt（计入上下文/token），**默认影响
KV 缓存稳定性**——非必要不要注入，注入也要保持文本完全稳定。

## 接缝六：插件设置区块（tuiSettingsSections）

带配置命名空间的插件可以向 `/settings` 设置屏声明一个可编辑区块（issue #165）。
契约是**声明式**的：插件只描述"哪些字段可编辑"，渲染、草稿编辑、保存/放弃、
revision 冲突重试全部由 TUI 宿主负责；存储、schema 校验、分层解析仍在 dsh
settings 服务（内核）侧——TUI 只做展示。

```ts
import type { TuiSettingsSection } from '@deepseek-harness-tui/dsh-tui/settings-sections'

ctx.inject(['tuiSettingsSections'], (settingsCtx) => {
  const unregister = settingsCtx.tuiSettingsSections.register({
    ns: 'my-plugin',            // 与 ctx.settings.register 的命名空间一致
    title: 'My plugin',         // 英文标题（也是回退文案）
    descriptions: { zh: '我的插件' },
    fields: [
      { path: ['enabled'], label: 'Enabled', kind: 'boolean' },
      { path: ['limit'], label: 'Retry limit', kind: 'number', hint: 'Attempts before giving up' },
      { path: ['mode'], label: 'Mode', kind: 'select', options: [
        { value: 'fast', label: 'Fast' },
        { value: 'safe', label: 'Safe' },
      ] },
      // 密钥字段：永不过 settings 文档——空白草稿不写入，输入了才走 credentials 接缝
      { path: ['apiKey'], label: 'API key', kind: 'text', secret: { ref: 'MY_PLUGIN_API_KEY' } },
    ],
  } satisfies TuiSettingsSection)
  ctx.effect(() => () => unregister())
})
```

语义（与 web 前端的插件设置卡片一致）：

- 编辑是**草稿式**的：用户打字只改草稿，按 `s` 保存才落成一次 revision 栅栏的
  `settings.mutate` path ops（冲突自动用新 revision 重试一次）。
- 字段的"已覆盖"标记按 **user 层存在性**判断（值等于默认也算覆盖）；清空文本
  字段会在保存时生成 `unset`，让字段回退到组合层。
- `kind` 目前支持 `text` / `number` / `boolean` / `select`；复杂嵌套结构（dict/
  数组编辑器）暂不支持，用户仍可手工编辑 `~/.dsh/settings.yaml`——未声明区块的
  命名空间在设置屏里就是只读 + YAML 提示。
- 命名空间未注册（插件未挂载 settings section）时区块显示为不可用，不报错。

## 接缝七：profile 组合（cordis.patch.yml）

插件包通过自己的 `cordis.patch.yml` 声明要在 profile 里插入/覆盖的行：

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: 'my-plugin'
      config:
        myKey: myValue
```

要点（与主包 `cordis.patch.yml` 同规则）：

- 覆盖行（`- id: …` 无 `insert`）会**整块替换**目标行的 `config`——必须复述该行
  拥有的每个键，别只写你要改的那一个。
- 行有依赖顺序；新行插在 `insert` 里，不要重复挂 base 已有的服务行。
- 发布前把包装进 profile 验证：`dsh plugin --profile dsh-tui add my-plugin`，
  再在真实 TTY 里跑 `dsh --profile dsh-tui`。
- 已知坑：profile 里 pnpm 的隔离 node_modules 不会把**传递依赖**链接进 profile
  根，所以主包把自己的工作状态行插件以
  `@deepseek-harness-tui/dsh-tui/working-activity` 子路径再导出后挂载。你的插件
  如果也要被别的 bundle 组合，提供同样的显式子路径导出。

## 接缝八：插件全屏场景（tuiScenes）

插件可以把一个**整屏 React 场景**注册给 TUI，再从自己的 slash 命令里打开它——
就是 `/trace`（轨迹时间线）和 `/settings` 那种"接管整个终端、退出后原样归还"
的页面形态。命令执行权仍在 dsh-commands（`command/run`/`command/done` 日志对
照记），TUI 只提供渲染面与键盘所有权；场景的打开/关闭不碰会话流，不落任何
session 事件。

### 三步接入

**1. 注册场景**（`id` 全局唯一，kebab-case；重复或非法 id 注册即抛错）：

```ts
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'

ctx.inject(['tuiScenes'], (sceneCtx) => {
  const dispose = sceneCtx.tuiScenes.register({
    id: 'my-dashboard',
    title: 'My dashboard',        // 可选，调试/日志用；标题栏由场景自绘
    component: MyDashboard,
  })
  ctx.effect(() => () => dispose())   // dispose 当前打开的场景会自动关屏
})
```

**2. 注册打开它的命令**（执行与日志仍归 dsh-commands；handler 返回静默
`success`，转录里只留下命令本身的一行）：

```ts
ctx.inject(['commands'], (commandCtx) => {
  const dispose = commandCtx.commands.register({
    name: 'dashboard',
    description: 'Open my dashboard',
    handler: () => {
      const opened = sceneCtx.tuiScenes.open('my-dashboard')
      return opened
        ? { kind: 'success' as const }
        : { kind: 'error' as const, text: 'dashboard scene is not registered' }
    },
  })
  ctx.effect(() => () => dispose())
})
```

**3. 写场景组件**——props 注入宿主的 `React` 与 `ui` kit，**这是硬契约**
（原因见下节）：

```tsx
// tsconfig: "jsx": "react-jsx",
//           "jsxImportSource": "@deepseek-harness-tui/dsh-tui"
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'

export function MyDashboard({ React, ui, channel, close }: TuiSceneProps) {
  // hook 必须用注入的 React；JSX 经 jsxImportSource 走宿主 jsx-runtime
  const { Box, Text, useInput, useTerminalSize } = ui
  const { columns, rows } = useTerminalSize()
  // channel 是响应式的：照 Chat 的用法订阅 version，数据随会话实时刷新
  React.useSyncExternalStore(channel.subscribe, () => channel.version)
  // 场景打开期间独占键盘——Esc/q 关闭这类约定由场景自己实现
  useInput((input, key) => {
    if (key.escape || input === 'q') close()
  })
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Text bold>My dashboard</Text>
      <Text>{channel.rows.length} rows · {columns}×{rows}</Text>
    </Box>
  )
}
```

不用 JSX 也可以：`React.createElement(ui.Box, …)` 完全合法（`React` 就是宿主
实例，`createElement`/`Fragment` 都安全）。

### React 契约（必读，违反即首渲染崩溃）

TUI 的 reconciler 是 **React 19**，场景组件运行在宿主的 React 实例上：

- **hook 必须用 props 注入的 `React`**。插件从自己 node_modules 里 import 一个
  React 副本调 hook，dispatcher 对不上，第一次渲染就是 invalid hook call。
- **元素必须过宿主 runtime**。React 19 的 JSX 工厂产出
  `Symbol.for('react.transitional.element')` 元素；插件自带的旧版 React（18 及
  更早）编译出的 JSX 是 `Symbol.for('react.element')`，宿主 reconciler 直接拒绝。
  所以 JSX 作者必须把 tsconfig 的 `jsxImportSource` 指向
  `@deepseek-harness-tui/dsh-tui`（它的 `./jsx-runtime` 子路径原样 re-export 宿主
  的 `react/jsx-runtime`），或者干脆只用注入 `React` 的 `createElement`。
  插件自带的 React 副本**仅当同为 19.x 时**产出的元素才合法，且 hook 依然禁用。

### 运行时语义

- **屏幕栈**：插件场景位于 Chat early-return 链的最顶端——在 `/settings`、
  `/resume` 浏览器、轨迹场景之上。场景打开期间这些屏幕保持挂载但让出屏幕与
  键盘；`close()` 后落回之前所在的屏幕。
- **inline / fullscreen 通吃**：inline 模式下 TUI 自动为场景包
  `<AlternateScreen>`（DEC 1049 进出、帧 churn 不进 scrollback）；fullscreen
  模式直接复用宿主已有的 alt screen，场景组件**不要**自己再包一层。
- **命令异步打开也安全**：handler 是 async 的，命令结束后才 `open()` 也没问题——
  打开动作经 channel 的 version bump 驱动重渲染，不依赖命令的返回时机。
- **服务缺失时静默降级**：`ctx.get('tuiScenes')` 探测；旧版 patch 未挂
  `dsh-tui-scenes` 行时 `open()` 打 warn 并返回 `false`，TUI 侧永不打开，
  绝不拖垮启动（#183 原则）。
- **生命周期**：场景注册与打开状态不随 `/new`、`/resume`、rewind 的 agent
  切换重置；`channel` 始终指向当前 live agent。场景组件卸载（关屏）时 hook
  状态随之销毁，重开是全新挂载。

### 场景的红线

- 场景打开期间**独占整个终端**：布局用 `flexGrow`/`useTerminalSize()` 自适应，
  别假设固定行列数；也别往 stdout 写任何东西（调试走 `DSH_TUI_DEBUG` 的
  stderr）。
- 场景是会话的**观察者**：数据从 `channel` 读（rows、tokens、working、
  traceEvents……），写操作（submit/steer/cancel）也能用，但打开/关闭本身
  不产生任何 session 事件——别在场景里 append 事件，要发就走接缝一的
  log-only 铁律。
- 每一帧的重渲染成本由场景自己兜着：高频动画用 `ui.useAnimationFrame`，
  别在渲染路径里做同步 I/O。
- **渲染期异常有边界兜底**：场景组件 render/生命周期里抛错会被
  `PluginSceneBoundary` 接住——转录里报一条错误、场景自动关闭，不会拖垮整个
  TUI。但 boundary 管不到 effect 与异步回调里的异常，那些仍是场景自己的责任。

## 接缝九：决策事件（tui/input · rewind · session-switch · compact）

pi 风格的 before-event：TUI 在关键动作的**执行前**把决策权交给插件。决策
事件按注册顺序**逐个 await（serial 顺序）**，**第一个返回有效决策的插件
生效**；与裸 `ctx.serial` 不同，宿主做了逐监听器归一化与隔离：

- 返回 `undefined`/`null`/`false` = 无意见，链继续；
- **畸形返回不算决策**——空白 `{ text }` 改写、非对象值、空的 `modes`
  列表等会被忽略并告警，链**继续**（一个写错的插件不可能把后面的安全
  否决插件跳过去）；
- 监听器抛异常只跳过该监听器并告警，链**继续**；
- 全部无意见则按默认行为放行。

配套的通知事件（`tui/rewind-done` 的摘要返回值除外）是 **parallel** 语义：
事后广播，无决策权。

### 契约表

| 事件 | 时机 | payload（均含 `sessionId`、`cwd`） | 返回（首个非 undefined 生效） |
| --- | --- | --- | --- |
| `tui/input` | 用户输入投递前（submit 与 steer 都走） | `text`、`delivery: 'followup'\|'steer'` | `{ text }` 改写 · `{ handled: true, notice? }` 插件已自行处理 · `{ cancel: true, reason? }` 丢弃 |
| `tui/rewind-prompt` | rewind 选中消息确认后、fork 前 | `text`、`seq` | `{ cancel: true, reason? }` 否决（picker 保持打开）· `{ modes: TuiRewindMode[] }` 在确认页提供额外回退模式（≤8 个，需 `id`+`label`） |
| `tui/rewind-done` | rewind 完成、agent 已切换 | `text`、`mode: string\|null`、`boundarySeq`、`sourceSessionId`、`childSessionId` | 第一个非空 `string` 作为摘要 toast（6s）；其余返回忽略 |
| `tui/session-switch` | `/new`、`/resume` 执行前（无任何副作用时） | `kind: 'new'\|'resume'`、`targetSessionId?` | `{ cancel: true, reason? }` 否决 |
| `tui/session-switched` | `/new`、`/resume`、rewind 完成后 | `kind: 'new'\|'resume'\|'rewind'`、`sessionId`、`previousSessionId?` | 通知（parallel），返回值忽略 |
| `tui/compact` | `/compact` 执行前 | — | `{ cancel: true, reason? }` 否决 |

公共语义：

- `cancel.reason` / `handled.notice` 以 toast 呈现；缺省时宿主给本地化兜底文案。
- `tui/input` 的 `{ text }` 会被 trim；trim 后为空按"无意见"处理。改写只在
  **投递前**生效，等待期间如果用户切了会话，这条过期输入会被丢弃并提示
  （stale-drop），绝不会把旧会话的话发进新会话。
- `tui/rewind-prompt` 的 modes 会在确认页渲染为选项列表（第一项恒为宿主的
  "仅回退会话"）；用户选中后，该 `mode` id 原样出现在 `tui/rewind-done` 的
  payload 里——插件在 done 事件里执行真正的模式逻辑（比如恢复文件）。
- 决策监听器里**不要**做慢 I/O 而不自知：`tui/input` 在投递链之前，会实打实
  延迟发送；要弹窗就用接缝十（它就是为此设计的）。

### 示例：输入守卫 + 自定义命令输出

```ts
import type { TuiInputEvent, TuiInputDecision } from '@deepseek-harness-tui/dsh-tui/extensions'

ctx.on('tui/input', (event: TuiInputEvent): TuiInputDecision | undefined => {
  // /my-command 由插件自己接管：不入会话、不发模型
  if (event.text.startsWith('/my-command')) {
    void runMyCommand(event.text.slice('/my-command'.length).trim())
    return { handled: true, notice: '已交给 my-command 处理' }
  }
  // 危险短语拦截
  if (event.text.includes('rm -rf /')) {
    return { cancel: true, reason: 'my-guard: 这条输入被安全策略拦截' }
  }
  // 快捷展开
  if (event.text === '@standup') {
    return { text: '总结这个仓库昨天的提交，写成站会汇报' }
  }
  return undefined // 无意见，照常投递
})
```

## 接缝十：托管对话框（tuiDialogs）

pi 的 `ctx.ui` 等价物：插件不碰渲染，只发请求；TUI 在提示框上方弹出一个
模态面板（打开期间独占键盘），用户作答后 Promise 落定。多个插件同时发请求
时 **FIFO 排队**，一次只显示一个。

```ts
const dialogs = ctx.get('tuiDialogs', false)

// 单选：落定选项 id；取消/Esc/超时/中止 → undefined
const id = await dialogs?.select({
  title: '挑一个',
  options: [
    { id: 'fast', label: '快速模式' },
    { id: 'safe', label: '安全模式', description: '多一道确认' },
  ],
  signal: abortController.signal,  // 可选：外部中止
  timeoutMs: 30_000,               // 可选：自动取消（无头嵌入方兜底）
})

// 确认：落定 true/false；取消按 false 计（不区分"点了否"和"按了 Esc"）
const ok = await dialogs?.confirm({
  title: '确认覆盖？',
  message: '目标文件已存在',
  confirmLabel: '覆盖',   // 缺省走宿主本地化"是/否"
  cancelLabel: '保留',
})

// 单行输入：落定文本；取消 → undefined
const name = await dialogs?.input({
  title: '起个名字',
  placeholder: '回车确认，Esc 取消',
  initial: '默认名',
})
```

契约要点：

- **永不抛错**：无标题、无有效选项等畸形请求直接落定取消值并告警——插件
  的 await 方永远能继续。
- 入参即被消毒：控制字符剥离、空白折叠；标题/标签 ≤120 cell、message
  ≤400、输入 ≤500、选项 ≤100 个（超出截断）。
- 面板按键：↑/↓ 移动、Enter 确认、Esc/Ctrl+C 取消；input 是对话框内部的
  单行编辑（左右/Home/End/退格/删除），与主输入框互不影响。
- 服务缺席（旧 profile）时 `ctx.get` 返回 `undefined`——插件自己决定跳过
  交互还是走无头默认值；`timeoutMs` 是"有服务但没有 TUI 消费者"场景的
  保险丝。

典型搭配：决策事件监听器里弹窗——`ctx.on('tui/rewind-prompt', async () => … await dialogs.select(…))`，用户答完再返回决策。

## 接缝十一：状态行（tuiStatus）

键控的状态行贡献——pi 的 `setStatus(key, text)`。所有插件的贡献按"首次
设置顺序"拼成一行（` · ` 连接），渲染在提示框上方：

```ts
const status = ctx.get('tuiStatus', false)
const dispose = status?.set('my-plugin', '构建中 42%')   // 设置/更新
ctx.effect(() => () => dispose?.())   // 清理挂在【调用者】自己的 fiber 上
status?.set('my-plugin', undefined)      // 主动清除（传 '' 同效）
```

- key 规则：`/^[a-z][a-z0-9_-]*$/`（约定用插件名或 `插件:子项`）；最多 20
  个 key，文本 ≤200 cell；违规拒绝并告警，不抛错。
- **生命周期是调用者的责任**（与 tuiShortcuts/tuiScenes 同一契约）：
  `set` 返回的 disposer 只会在 key 仍持有该文本时清除（后被覆盖的值不受
  旧 disposer 影响）；不用 `ctx.effect` 挂清理的话，插件卸载/热重载后旧
  状态会永久留在界面。
- 状态行是**纯展示**：要可点/可按键的东西请用快捷键（接缝十二）或场景
  （接缝八）。

## 接缝十二：键盘快捷键（tuiShortcuts）

pi 的 `registerShortcut`：把组合键绑到处理器。

```ts
const shortcuts = ctx.get('tuiShortcuts', false)
const dispose = shortcuts?.register('ctrl+shift+p', {
  description: '打开我的面板',          // 必填，可发现性用
  handler: () => { void openMyPanel() },
})
ctx.effect(() => () => dispose?.())     // 清理挂在【调用者】自己的 fiber 上
```

组合键语法：`ctrl`/`alt`（`meta`/`option` 同义）/`shift` + 一个字符或命名键
（`enter`、`esc`、`tab`、`backspace`、`delete`、`up/down/left/right`、`home`、
`end`、`pageup`、`pagedown`、`space`），如 `ctrl+shift+p`、`alt+k`、
`ctrl+space`。**例外：`escape` 组合一律拒绝**——输入层给每个 Esc 都置
`meta`，`alt+escape` 会命中所有裸 Esc 按下（清空输入、双击 Esc rewind 全
被遮蔽），没有无歧义的绑法。

规则（全部"拒绝 + 告警，不抛错"）：

- **必须带 ctrl 或 alt**——裸字母是打字，裸方向键是导航。
- **保留位不发**：TUI 内建绑定（ctrl+c/d/t/r/x/o/l/e/v/a/u/k/w、ctrl+←/→、
  ctrl/alt+Enter、alt+↑、Esc、Tab、Shift+Tab）在注册时即被拒绝。这是
  "本地优先"的强制面：冲突永远到不了匹配器。
- 重复注册同一组合（规范形式）被拒绝。
- 只在**纯对话态**派发：任何浮层（picker、审批、问卷、托管对话框、场景、
  会话浏览器）打开期间键盘归浮层。
- 处理器 fire-and-forget：异步拒绝被捕获，toast 提示 `description` 归属的
  失败并告警，绝不弄坏别人的键盘。
- `register` 返回的 dispose 由**调用者**用自己的 `ctx.effect` 挂清理（与
  tuiScenes 同一契约）——服务方法看不到调用者的 fiber。

## 接缝十三：自定义会话条目渲染器（tuiRenderers）

pi 的 `registerMessageRenderer`：插件经接缝一追加的 log-only 会话事件
（`session.append('my-plugin/event', payload)`），注册一个渲染器映射成
**纯文本行**，Channel 就会把它投影进 transcript——实时流和回放（/resume、
rewind）走同一条路径：

```ts
const renderers = ctx.get('tuiRenderers', false)
const dispose = renderers?.register('my-plugin/note', (payload) => {
  const note = payload as { text: string; ts: number }
  return {
    title: '便签',                       // 可选标题行
    lines: [note.text, `记于 ${new Date(note.ts).toLocaleString()}`],
  }
  // 返回 undefined = 这条不渲染（按 payload 条件决定）
})
ctx.effect(() => () => dispose?.())
```

规则：

- 类型名必须 `plugin/event` 形（kebab、恰好一个 `/`）；内建事件类型
  （`KNOWN_SESSION_EVENT_TYPES`）与宿主特判的 `agent-preset/selected` 拒绝
  注册——内建投影永远优先。
- 渲染器**拿不到 React**：整屏交互面是场景（接缝八），transcript 行必须
  纯文本——回放路径上的一次崩溃会毁掉整个屏幕。
- 渲染器抛错：该条目跳过，每种类型**只告警一次**（粘性），回放长日志不会
  刷屏。
- 输出在渲染器边界内完成校验与消毒：title 必须是字符串（其他类型直接丢
  弃——非字符串进 React 渲染路径会崩）、行只保留标量、控制字符剥离、按
  cell 截断；行数上限 100、行宽 400 cell、标题 120 cell，回放路径不会被
  一个超大数组同步撑爆。
- 事件类型注册的两条铁律（log-only + 写入 `KNOWN_SESSION_EVENT_TYPES`）仍
  是接缝一的责任——渲染器只管"怎么显示"，不管"能不能持久化"。

## 命名与发布规范

- **包名**：生态约定 `@dsh-tui-ecosystem/<name>`（发布前先查 npm 是否被占）；
  官方核心包保持 `@deepseek-harness-tui/*`。仓库放
  `github.com/dsh-tui-ecosystem/<name>`。
- **许可证**：MIT（与主包一致）。
- **版本**：语义化版本；发布由 `v*` tag 驱动（参考主包 publish workflow）。
- **Node**：`^22.19 || >=24`，纯 ESM。

## 质量与安全红线

- 不追加 surface 事件、不注入凭证；模型可见面只走既有服务（工具、prompt 段、
  preset）。
- TUI 活动期间 stdout 保持安静：不 `console.log` 诊断；调试用 stderr 的
  `DSH_TUI_DEBUG` 或 `DSH_TUI_RENDER_LOG`。
- 长会话内存有界：per-session 状态要随 `session/disposed` 清理，别无限累积。
- 用户数据只放既有 `~/.dsh-tui` 位置下；外部 JSON 一律校验，损坏时回退而不是
  崩溃。
- 插件配置/文件内容按不可信输入处理，特别是会进入渲染路径的字符串（宽度按
  terminal cell 计，不能依赖 `string.length`）。

## 验证清单

```sh
pnpm install --frozen-lockfile
pnpm build                       # tsc -> lib/types/
dsh plugin --profile dsh-tui add <你的包>   # 装进 profile
dsh --profile dsh-tui            # 真实 TTY 手动验证（无头断言不充分）
DSH_TUI_DEBUG=1 dsh --profile dsh-tui      # 需要调试时
```

改动渲染、键盘或终端协议时，还要跑主包的 CI 回归（见
[贡献指南](contributing.md#验证)）。

## 收录与推广

- 完成插件后，把链接提交到生态组织，让社区发现你：
  - 主仓库的 [`docs/links.md`](links.md)（PR 到 `ccch1mneyyy/dsh-TUI`）
  - 组织主页 README 的收录列表（PR 到 `dsh-tui-ecosystem`）
- 在 README 里注明依赖的 dsh-TUI 版本下限，随主包版本更新做兼容性说明。
