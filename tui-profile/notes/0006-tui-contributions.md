# 0006 — TUI Contribution Surfaces

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

**Coordinates:** `tui.dsh/v1alpha1` `SettingsSection`, `Scene`

**Base protocol:** [`@dsh-std/ui`](../../vendor/dsh-std/docs/proposals/ui-contribution.zh.md)

## Scope

本提案定义 dsh-TUI 的两个 UI surface：由 shell 呈现的设置区段与由本地模块实现的全屏场景。它们使用 `@dsh-std/ui` 的 facet ownership、registration、view lifecycle 与 content-mode 语义；本提案只规定 TUI surface 的 descriptor、handler 绑定和冲突规则。

Workspace、Command、Presentation、Agent 与 Session 是独立领域协议。TUI 使用这些协议不产生新的 UI surface，也不改变其 authority。

## `SettingsSection`

`SettingsSection` 是 `host-rendered` surface，registration policy 为 `declared-handler`。Manifest extension 提供静态 descriptor；active facet 发布同 identity 的 handler 以完成注册。Handler 不取得渲染器所有权。

Descriptor 必须包含：

- `namespace`：设置项所属的稳定命名空间；
- `title`：默认标题；
- `titles`：可选的本地化标题；
- `fields`：宿主能够呈现的字段列表。

字段类型限于 `text`、`number`、`boolean` 与 `select`。字段 path、label、可选 hint、placeholder、select options 与 secret reference 必须符合机器定义。未知字段或字段类型必须使该 contribution 以 `SECTION_INVALID` 失败，不得由 shell 猜测其语义。

Shell 拥有布局、字符消毒、终端 cell 宽度、输入、主题、parse 与 format。字段写入必须通过当前 agreement 授予的 Settings 或 Credential 能力；descriptor 不是设置值的权威来源。

Secret 字段只能包含 credential reference。Secret value 禁止进入 Manifest、contribution descriptor、普通 settings document、view state 或 diagnostic。

每个 active `namespace` 只能有一个 owner。发生重复时，composition 或 registration 必须返回 `NAMESPACE_CONFLICT`，不得以 activation 顺序覆盖既有 section。移除 section 只移除 UI metadata，不删除对应设置或 credential。

## `Scene`

`Scene` 是 `local-module` surface，registration policy 为 `declared-handler`。Manifest extension 声明稳定 identity、默认标题与可选本地化标题；active facet 以相同 identity 绑定本地 scene handler。

Scene handler 只能在与 TUI shell 相同的信任域和执行环境中使用。Surface ABI 必须向 handler 提供：

- 与 shell 兼容的 renderer 与 UI kit；
- 该 facet 已协商的 scoped domain clients；
- 当前 view instance 的关闭操作；
- cancellation 与 lifecycle signal。

Handler 禁止把自带 renderer instance 当作 shell instance，也不得通过 scene ABI取得全局 service container。Renderer 或 ABI 不兼容时，shell 必须在打开 view 前返回 `RENDERER_INCOMPATIBLE`。

全屏 surface 同时只能由一个 scene view 占用。第二项互斥打开请求必须返回 `SCENE_CONFLICT`，或按显式 shell policy 先关闭原 view；不得静默叠加两个输入 owner。

Scene identity 与纯数据 metadata 可以进入 catalog。可执行 handler、renderer value、component element、callback 与本地 module path 禁止跨 endpoint 传输。远端请求只能引用 consumer 端已经安装、协商且 identity 相符的本地 Scene contribution。

## Profile selection

TUI profile 选择提供本提案 surfaces 的 shell facet，并可以选择实现这些 surfaces 的插件 facets。安装 component 不表示其 TUI facet 必然激活；当前 composition 无相应 surface support 时，其 TUI facet不得进入 active plan。

同一 component 的非 UI facets 独立选择。TUI surface 不可满足不得令无依赖关系的 Host 或其他 UI facets 失败。

## Lifecycle and failure

Contribution 与发布 handler 的 activation instance 具有相同 owner。Facet deactivate、activation rollback、composition replacement 或 registration lease close 时，shell 必须停止新 view、关闭现有 view、取消订阅并移除 contribution。

一项 contribution 的注册、打开、调用或 cleanup 失败必须归属于 component、facet、surface 与 contribution identity。失败不得移除其他 contributions，也不得终止基础 TUI shell。

`SettingsSection` 的错误集合为 `SECTION_INVALID`、`NAMESPACE_CONFLICT` 与 `NAMESPACE_UNAVAILABLE`。`Scene` 的错误集合为 `SCENE_INVALID`、`SCENE_CONFLICT` 与 `RENDERER_INCOMPATIBLE`。

## Permissions and security

本协议不是安全边界。Contribution 只能使用其 facet 另行协商并取得 permission 的领域能力。Scene 运行于 trusted in-process 环境不表示它获得 Filesystem、Execution、Workspace、Session、Settings 或 Credential authority。

Shell 必须把 descriptor 中的文本与引用视为不可信数据，并限制字段数量、字符串长度、更新频率和并发 view 数。控制字符不得直接进入终端输出。

## Machine definitions and conformance

Manifest extension definitions 与 handler assertions 位于 [`protocols/tui-contributions.js`](../protocols/tui-contributions.js)。Contract profiles 位于：

- [`registry/contracts/settings-section-v1alpha1.json`](../registry/contracts/settings-section-v1alpha1.json)
- [`registry/contracts/scene-v1alpha1.json`](../registry/contracts/scene-v1alpha1.json)

Registry coordinates 必须与本提案坐标一致。Conformance fixtures 必须覆盖合法 descriptors、未知字段、namespace 冲突、缺失 handler、renderer 不兼容以及 owner cleanup。失败的 admission 必须报告对应 contract error，不得以一般加载错误代替。
