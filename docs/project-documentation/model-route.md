# 模型路由与状态栏

本文覆盖模型路由的原子解析模型、/model 命令的 fork 切换、/resume 的状态栏
跟随（4d48eb6 修复）与 /new 路由语义。行号均以审计基线 b2f4087 为准。

## 原子路由模型

`ModelRoute` 是 `{ provider, model }` 两字段整对（`src/modelRoute.ts:1-23`），
注释明确 "The `(provider, model)` pair is a single value: every source either
supplies the WHOLE route or is skipped"。不存在集中式「会话→模型」映射表；
路由按会话事件时解析。

优先级链（`src/modelRoute.ts:40-61` `resolveModelRoute`）：

```text
完整 cordis.yml 路由（两半都钉住）整对胜出
  > 持久化 ~/.dsh-cc/model.json 的 /model 选择整对胜出
  > DEFAULT_MODEL_ROUTE 整对胜出（src/modelRoute.ts:19-23：
    provider 'deepseek-official' / model 'deepseek-v4-flash'）
```

半钉配置整体忽略，不与其他来源拼接（issue #67）：`explicitModelRoute`
（:27-38）仅在两半都非空时返回路由，"A half-pinned config counts as unset
here so it cannot override half of the persisted preference"。仓库自带
`cordis.yml:12-15` 恰为半钉场景（仅 `provider: deepseek-official` 无 model
键）。

Schema 不设默认值的动机（`src/index.ts:64-71`，issue #30）：".default() here
would make an unset key indistinguishable from an explicit cordis.yml choice
and the persisted `/model` preference could never win"。

持久化（`src/modelPrefs.ts`）：`~/.dsh-cc/model.json`（:16-22），写为
{ provider, model } JSON；parseModelPref 对两半均要求非空字符串，任何异常/
缺半/非对象一律返回 undefined（:24-41，best effort 读取）。

## 启动路由解析

```text
src/plugin.ts:129  startupRoute = resolveModelRoute(configuredRoute, readModelPref())
  -> resolveAgent（src/plugin.ts:352-429）：
     resume 分支（:363-391）route: resumeRoute ?? recordedModelRoute(...)
     create 分支（:400-433）validateModelRoute 校验目录，被拒整对回退
  -> displayRoute = createdRoute ?? startupRoute 传入 createChannel
     （src/plugin.ts:143-147）
  -> ChannelState.model/provider 初始化为 options（src/channel.ts:1055-1062）
  -> StatusLine 左组首字段渲染 channel.model（src/screens/StatusLine.tsx:91-94；:57-87
     为 TPS 读数区）
```

## /model 命令链路

```text
/model -> src/screens/Chat.tsx case 'model'（:463-473）：开 picker，channel.listModels()
  拉全 provider 目录，初始焦点对齐当前 provider/model
  -> listModels 遍历 llm.listProviders() 并发 listModels 后扁平化
     （src/channel.ts:1827-1838，无 llm 服务返回空数组）
  -> ModelPicker Enter -> channel.switchModel(model.provider, model.id)
     （src/screens/Chat.tsx:979-990，先 notify 'Switching model to …'）
  -> switchModel（src/channel.ts:1575-1686）：
     working 中拒绝
     -> 无边界 fork 整个日志（继续会话）
     -> 以 agentOptions: { provider, model } 创建新 agent
     -> 重置并回放历史；显式 state.model = model / state.provider = provider
     -> touchSession(childId) 使切换后的 fork 成为 MRU
     -> writeModelPref 持久化（:1677-1684 注释："Persist the choice so the
        next boot and `/new` start on it (same contract as /preset and
        Shift+Tab effort; issues #14/#30)"；写失败仅警告不阻止实时切换）
  -> state.emit() 后 StatusLine 重渲染显示新 channel.model
```

此链路**不调用 resolveModelRoute**——切换直接赋值，解析只发生在启动 / /new /
resume。

## /resume 状态栏跟随（4d48eb6 修复）

修复前行为（提交信息）：resumeTo 从不重置 state.model/state.provider，
request/header 回放只消费 reasoningEffort，resume 不同路由的会话后状态栏仍
显示启动解析的旧路由，与真实请求路由不一致。

修复后两条路径：

```text
启动 --resume 路径：
  resolveAgent resume 分支返回 route: resumeRoute ?? recordedModelRoute(
  resumed.agent.session.events)（src/plugin.ts:386-391）
  -> displayRoute 落入会话记录

运行中 /resume 路径：
  resumeTo（src/channel.ts:1371-1426）：
  resumeRoute = explicitModelRoute(configured)（:1382-1385，仅完整 cordis.yml
    对可覆盖会话记录）
  -> agents.resume 以 resumeRoute?.provider/model 作为 agentOptions（:1387-1391）
  -> resumedRoute = resumeRoute ?? recordedModelRoute(handle.agent.session.events)
     （:1422）
  -> state.provider/state.model 写入 resumedRoute（:1423-1426）；空日志
    （从未开始回合）记录为 undefined，保持原显示（best effort）
```

recordedModelRoute（`src/modelRoute.ts:63-87`）：从会话 durable 事件日志倒序
取第一条 request/header 的 data.header.config 的 (provider, model)——"the
last request/header snapshot carries the call config the agent loop builds its
requests from, so it IS the route a resume continues on"。request/header 回放
分支只消费 reasoningEffort 与 header.system，不读取/回写 provider/model
（src/channel.ts:2816-2828）；修复靠显式赋值而非回放。

## /new 路由语义

`newSession`（src/channel.ts:1456-1573）：

```text
newResolved = resolveModelRoute(configured, readModelPref(),
  {provider: options.provider, model: options.model})（:1487-1491）
  ——刚切换的 /model 偏好已被 writeModelPref 写入并被 readModelPref 读到，
  故 /new 跟随当前模型；启动路由作 defaults 兜底
  -> validateModelRoute 目录校验，被拒整体回退启动路由并告警（:1492-1508）
  -> agents.create 以 route 为 agentOptions（:1510-1520）
  -> state.model/provider = route（:1548-1549）
```

## validateModelRoute

`src/modelRoute.ts:89-114`，best-effort 目录校验：非空目录中找不到该模型则
整对回退到 fallback；无 llm 服务/目录为空/查询失败一律信任路由，绝不阻塞
启动——"a stale persisted choice surfaces at startup instead of as a
server-side model-name error"。

## 回归

`scripts/verify-model-route.mjs`：9 场景 16 断言，直接对编译产物
lib/types/modelRoute.js 断言（需先 pnpm build）；CI 中 build 之后执行，失败
非零退出（.github/workflows/ci.yml:67）。覆盖：provider-only 配置+完整 pref→pref 整对胜出；
完整 config 整对胜出；model-only 半钉→pref 胜出；双无→默认路由；半钉无
pref→默认整对；空串视为未设置；/new 语义=启动路由作 defaults 兜底；
validateModelRoute 目录拒绝整对回退/空目录或失败信任；recordedModelRoute
最后一条 request/header 胜出、裸日志返回 undefined、畸形 header 跳过。

## 冲突

| 项 | 两侧 |
| --- | --- |
| ModelPicker 注释过时 | `src/components/ModelPicker.tsx:12-13` 注释称模型 "fixed at creation time, so a selection notifies restart to apply"；实际 Enter 立即调用 switchModel 实时 fork 切换（"switch the live model by forking the conversation at its current end"），代码路径中不存在任何 restart-to-apply 通知 |
| /config 文案过时 | i18n doctor-route-hint（`src/i18n.ts:153`）声称 /model 仅重启生效且路由由 llm-deepseek 段决定；实际 /model 即时 fork 切换并持久化（下次启动//new 生效）；且 llm-deepseek 段（cordis.yml:33-39）只有 apiKeyEnv/baseURL/thinking/reasoningEffort，provider 钉在 cc-tui 段（cordis.yml:15） |
| /doctor 新旧来源混合 | `src/channel.ts:2106`：模型取可变 state.model，provider 取启动配置 options.provider——/model 切换后展示错配的 provider/model 对；Channel 接口注释 "Resolved model id (from the plugin config)"（src/channel.ts:261）亦与 model 可被 resume/new/switch 三处改写的事实不符 |

## 未验证事项

- recordedModelRoute 依赖的 request/header 事件结构
  data.header.config.{provider,model} 的真实写入者（dsh-agent loop，本仓库
  只消费不写入；提交信息与注释断言是 strong indication 而非 explicit
  evidence）。
- src/plugin.ts:368-370 的 attach-existing 分支（ctx.agents.get(existing) 直接
  返回，无 route 字段）下状态栏是否跟随会话记录未确证。
- /model 切换后新会话产生的 request/header 是否携带新 provider/model（取决
  于 dsh-agent 对 agentOptions 的消费方式）。

相关文档：[lifecycle.md](lifecycle.md)（启动序与 agent 解析）、
[input-commands.md](input-commands.md)（/model 命令入口）、
[session-context.md](session-context.md)（/resume 契约）、
[unknowns.md](unknowns.md)。
