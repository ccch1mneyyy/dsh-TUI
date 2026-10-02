# 0007 — TUI Channel Capability

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

**Coordinates:** `tui.dsh/v1alpha1` `Channel`  
**Experimental capability name:** `tui.channel`

## Scope

`Channel` 是 TUI renderer 与执行端之间的有状态能力。Provider 拥有 Agent、Session、Workspace 与运行时服务；Consumer 拥有可见终端。传输实现不得复制或解释 TUI 的业务方法。

本协议不规定 SSH、端口、HTTP、WebSocket、QUIC 或进程启动。连接建立、端点认证、协商、取消与 progress delivery 使用 connection protocol。

## Declaration

Requirement 与 support spec 必须声明 `wireRevision` 和 `features`。完整 dsh-TUI consumer 必须要求机器定义中 `TUI_CHANNEL_FEATURES` 的全部 feature。Provider 不得声明未实现的 feature。

同一 consumer 在一个 connection scope 内只能绑定一个 `Channel` provider。多个可用 provider 构成歧义，连接不得按发现顺序选择。

## Operations

Provider 必须实现以下 operation：

- `open`：创建或附着一个 Channel，返回完整 snapshot；
- `subscribe`：从指定 version 开始订阅，先返回或通过 progress 发送不早于该 version 的完整 snapshot；
- `invoke`：调用 Channel method，并返回 JSON value；产生状态变化时应同时返回最新 snapshot；
- `close`：释放 consumer 对 Channel 的附着。

`open.workspace` 与 `open.sessionId` 是 consumer 请求附着的远端资源标识。Provider 必须按自身 Workspace 与 Session authority 解析；不得把它们解释为 consumer 本机路径。`open.options` 只可协商终端呈现或 provider 明确允许由 consumer 选择的参数。`locale` 属于终端呈现参数；Provider 为不同 Channel 生成文本时必须保持各自 locale，不得用进程全局语言使一个 consumer 改变另一个 consumer 的输出。Sandbox、approval、plan mode、插件组成及其他执行策略由 provider 配置决定，不得从 consumer 的本地 profile 隐式继承。

`subscribe` 是长调用。Provider 必须在 Channel 变化后发送单调递增 version 的 snapshot；connection 取消、Channel 关闭或 facet deactivate 必须终止该调用。Consumer 检测到 version 缺口、倒退或 wire revision 改变时，必须重新 `open` 或重新 `subscribe`，不得把不连续状态拼接为当前状态。

## State projection

Snapshot 必须包含 renderer 所需的可序列化 Channel 状态，包括 transcript、agent/session identity、working state、usage、context、pending input、command catalog、workspace、authority home directory、path case-sensitivity、model、mode、preset、settings section、scene identity、diagnostic state 和 trace data。Consumer 对 workspace 与 session path 的归类、缩写和比较必须使用 provider 投影的路径语义，不得使用 consumer 进程的平台或 home directory。

Snapshot 禁止包含函数、进程句柄、renderer node 或 secret value。

Settings section 必须投影 namespace、title、localized descriptions、field path、field kind、options、placeholder 与 credential reference。可执行 formatter 或 parser 不得跨 endpoint 传输。本端注册的同 namespace section 可以替换远端声明，以提供本端呈现实现；否则 Consumer 必须使用字段 kind 的默认转换。

Scene 只传输 identity 与静态 metadata。Consumer 只能打开本端已注册的同 identity Scene；本端缺少实现时必须保持会话可用并报告 unavailable。可执行 Scene handler 不得跨 endpoint 传输。

## Invocation

`invoke.method` 必须对应 provider 声明 feature 中的 Channel operation。参数、progress 和结果必须为 JSON value。JavaScript binding 返回 `undefined` 时，output 必须设置 `valueDefined: false` 并以 `null` 占据 `value`；Consumer 必须恢复 `undefined`，不得把它解释为业务返回的 `null`。图片等二进制输入必须使用带 media type 的编码对象；provider 必须在进入 Agent input 前重新验证大小、media type 与内容。

`sideQuestion` invocation 的参数必须只包含问题文本。Consumer 不得传输 `AbortSignal` 或回调函数；取消使用 connection invocation cancellation。Provider 应把增量文本按顺序报告为 `{ "type": "side-question/text", "delta": string }` progress，最终结果仍由 invocation result 返回。

`commandCompletions` invocation 接受当前完整输入并返回 completion rows。Consumer 可以缓存结果，但 command catalog 或 workspace command catalog 变化后必须使缓存失效。Snapshot 中的 `providerSetupMethods` 必须只列出当前 Channel 实际可调用的方法；Consumer 不得据此合成未列出的可选方法。

`runWorkspaceCommand` 可以返回 target，或者只含数据与 opaque action token 的 choice 列表。Consumer 选择条目或提交其输入时，必须调用 `workspace.continue`，传入 action token 与可选 value；不得传输 provider callback。Provider 以新的 target 或 choice 列表完成 invocation，并可发送 `{ "type": "workspace/progress", "value": WorkspaceProgress }` progress。Action token 只在创建它的 Channel 内有效；完成下一阶段、Channel 关闭或 provider contribution 释放后必须失效。插件只实现 `WorkspaceProvider` handler，不实现 Channel 或 transport。

Agent question 与 approval 不进入 Channel snapshot，也不使用通用 Channel invocation 回传。DSH adapter 必须把原生请求映射为当前 connection 协商的 `presentation.dsh/v1alpha1` `UserInteraction` 调用；映射及其失败策略属于 adapter，不构成新的 TUI protocol。

Provider 禁止调用自身 endpoint 的终端、剪贴板或浏览器作为远端 consumer 的替代品。Secret response 只允许出现在对应 Presentation capability 的结果中，不得写入 snapshot。

## Authority and security

Channel provider 按当前 Agent、Session、Workspace、Settings、Credential、Filesystem、Execution 与 Permission authority 执行操作。本协议不扩大这些权限，也不构成独立安全边界。

Snapshot 与调用结果的 privacy class 至少等同于对应 Session。Credential operation 只允许传输引用、配置状态以及用户主动提交的 secret input；secret value 禁止出现在 snapshot、progress、日志或普通错误文本中。

## Concurrency and errors

同一 Channel 的状态变更必须线性化。只读调用可以并发；互相冲突的 session switch、rewind、workspace switch 与 close 必须按 provider 接收顺序执行。取消只撤销对应 invocation，不得隐式关闭 Channel。

未知 method、缺失 feature、失效 channel id、revision mismatch、permission denial 与 provider failure 必须作为调用错误返回。错误不得使其他 Channel 或 connection capability 失效。

## Lifecycle

Channel implementation 属于发布 support 的 active facet。Facet deactivate 必须停止订阅、取消未完成调用并释放所有 Channel attachment。Connection 断开可以保留远端 durable Session，但必须释放该 connection 的 presentation binding 与临时上传。

## Conformance

机器定义位于 [`protocols/tui-channel.js`](../protocols/tui-channel.js)，contract profile 位于 [`registry/contracts/tui-channel-v1alpha1.json`](../registry/contracts/tui-channel-v1alpha1.json)。Conformance 必须验证声明、四项 operation envelope、JSON-only snapshot、单调 version、取消清理以及完整 feature 集。

## Entry criteria

实现必须通过协议 conformance，并证明无 connection provider 时 dsh-TUI 保持本地行为。

## Exit criteria

当 community protocol 覆盖同一状态与 invocation 语义，或本协议在两个独立 transport implementation 上保持兼容后，可提议迁移或稳定化。

## Rollback

移除 `Channel` requirement 与 support 即停用远端投影；本地 Channel 不依赖本协议。
