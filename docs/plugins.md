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
