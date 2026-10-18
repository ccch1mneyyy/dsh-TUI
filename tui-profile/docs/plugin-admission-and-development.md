# 终端交互生态插件准入与开发指南

> **接口与兼容性协定 · 插件准入规范 · 实施标准 · 开发指南 · 验证清单**
>
> 本文档是 **dsh-TUI 的 TUI Profile**（仓内 [`tui-profile/`](../README.md)）的
> **唯一整合入口**：它随 dsh-TUI 的代码现状随时修订，作为 dsh-TUI 子插件（插件作者、
> 插件市场、评审）的参考标注——不是社区 RFC，也不需要在别处批准后才生效。
> 公共/社区协议语义以上游 [dsh-std](https://github.com/T-Auto/dsh-std) 为准，
> 本文只写 dsh-TUI 自己的准入要求与私有协议定义；原先独立的 `spec/` 与
> `docs/plugins.md` 已并入本文档。文中指向 dsh-TUI 仓库内部文件/文档的链接以
> dsh-TUI 仓库为准。

[TUI Profile 总览](../README.md) · [设计说明](../notes/README.md) · [Adapter Note](../adapters/dsh-tui-v0.15.md)

本文档面向想在 dsh-TUI 生态里做插件/扩展的开发者，以及需要评审、收录或验证插件的
维护者。`@deepseek-harness-tui/dsh-tui` 是单包、纯 ESM 的 TypeScript 项目，通过
Cordis 挂载到 DeepSeek Harness。生态插件与主包的关系：**主包只负责交互与呈现，
插件负责在既有接缝上补充能力**。

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
[主题系统](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/themes.md) 与下文"技能接缝"。

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

## 上游公共基线（dsh-std · Community Consensus v0.15）

**Status:** 当前基线依赖（随 dsh-TUI 代码修订，无独立晋级流程）
**Normative source:** [dsh-std](https://github.com/T-Auto/dsh-std)
**Pinned source:** [`vendor/dsh-std`](../../vendor/dsh-std)

本 profile 不复制 Community v0.15 的 Manifest、元协议、composition 与 lifecycle 规范。
dsh-TUI admission v0.15 使用下列 dsh-std 文档和机器资产作为公共基线：

- [`@dsh-std/core` 元协议](../../vendor/dsh-std/docs/proposals/core.zh.md)；
- [`@dsh-std/manifest` 与 Community v0.15 Manifest](../../vendor/dsh-std/docs/proposals/manifest.zh.md)；
- [`@dsh-std/composition`](../../vendor/dsh-std/docs/proposals/composition.zh.md)；
- [`@dsh-std/lifecycle`](../../vendor/dsh-std/docs/proposals/lifecycle.zh.md)；
- [`@dsh-std/command`](../../vendor/dsh-std/docs/proposals/command.zh.md)；
- [`@dsh-std/storage`](../../vendor/dsh-std/docs/proposals/storage.zh.md)；
- [`@dsh-std/messages`](../../vendor/dsh-std/docs/proposals/message-observer.zh.md)；
- [`@dsh-std/presentation`](../../vendor/dsh-std/docs/proposals/presentation.zh.md)；
- [Community v0.15 Manifest schema](../../vendor/dsh-std/packages/manifest/schema/dsh-plugin-0.15.schema.json)。

`vendor/dsh-std` 的 submodule revision 是 dsh-TUI conformance suite 的规范依赖版本
（pin 的是上游 dsh-std；`tui-profile/` 自身没有 revision，随本仓库提交走）。更新该
revision 时，必须同时运行 dsh-TUI 的验证并记录 admission 行为变化。本 profile 继续规范
以下增量内容：

- 下方 TUI Admission v0.15 产品准入要求；
- Host Descriptor、验证声明与 effect ledger 的 TUI profile；
- `registry/registry-0.15.json` 收录的 TUI 私有 protocol definitions；
- `tui.dsh/*` 私有协议。

这些增量必须通过 dsh-std 的 `ProtocolCatalog`、Manifest projection、composition 与
lifecycle 机制参与协商和激活。私有命名空间不产生第二套协议系统，也不改变 dsh-std
公共协议的语义。

### 对 dsh-TUI 与实现的要求

dsh-TUI 对齐上游公共元协议 [dsh-std](https://github.com/T-Auto/dsh-std)，并在其上
声明本 profile 的 TUI Admission v0.15 增量。要点：

- 契约以**坐标**标识（`apiVersion + kind`，如 `commands.dsh/v1alpha1` +
  `Command`）；导入定义携带固定的 `@dsh-std/*` package identity，TUI
  私有定义携带不可变 profile hash，宿主声明与注册表不一致即视为不可用
  （fail closed）。
- 插件 manifest（`dsh-plugin.json`）声明 `facets.host`（entry + apiVersion）、
  `requires.contracts`（optional 引用必须带 fallback）、`permissions`、
  `subscriptions`；`provides`/`services` 与 client/worker facet 在 v0.15
  直接拒绝。
- 宿主以 **Host Descriptor** 声明自己支持的契约面、facet 版本与
  `runtime.generationId`。
- 协商结果为五态：`compatible / compatible_degraded /
  waiting_authorization / rejected / unknown`，优先级
  `unknown > rejected > waiting_authorization > compatible_degraded >
  compatible`——引用落在注册表之外时回答 `unknown` 而不是 `rejected`
  （无法判定不等于判定不兼容）。

仓库内的落地物：

- `vendor/dsh-std/` — 固定 revision 的官方协议包（manifest parser、
  projection、ProtocolCatalog 与各契约 validator）。
- `tui-profile/` — 仓内 TUI Profile：admission profile 的 registry / schema /
  conformance fixtures 与私有协议定义（**纯文件，随本仓代码修订**）；
  `pnpm verify:plugin-spec` 检查 profile hash、fixture 与 `src/adapter/spec/`
  派生常量是否漂移。
- `src/adapter/standard/` — 校验/协商纯库：官方 parser 负责 manifest 形状，
  `validatePlugin`/`validateHost` 负责 profile 语义，五态 `negotiate` 使用
  同一 `ProtocolCatalog`。

**边界声明**：插件的发现、安装与加载由 dsh CLI（`@deepseek-ai/dsh` 的
Loader）负责，**加载时强制不在 dsh-TUI**。dsh-TUI 提供的是校验库 + 诊断面 +
运行时降级——不合规插件在 TUI 内拿不到契约能力。信任模型为同进程信任
（trusted-in-process，C-070）：授权是行为约束，不是安全隔离边界。

当前对齐进度：校验/协商库、vendored 数据、统一授权存储、Host
Descriptor 构建、`storage.local` 与 `messages.observe` 契约面、
commands 错误码对齐、效果台账与 `/plugin` 诊断面已全部落地。

授权存储（`~/.dsh-tui/extension-grants.json`）统一回答全部 8 个注册
权限：默认值由 vendored 权限注册表驱动（7 个默认拒绝；
`commands.invoke` 默认允许——插件无法仅凭它被动读取数据）。`grants`
段显式授予默认拒绝的权限；可选 `denies` 段撤销默认允许的权限；未注册
的权限名一律拒绝（即使文件里显式授予）。三种文件状态严格区分：
**缺失**（ENOENT）= 全默认（尚未授权的自然姿态）；**语法或结构不可解析** =
fail closed，连默认允许也一并拒绝；**其他读取失败**（EACCES/EISDIR/
I/O——文件存在却无法求值）同样视同损坏 fail closed，绝不静默回落
全默认（否则 denies 会在一次 I/O 错误后悄然失效）：

```json
{
  "grants": {
    "my-guard": [{ "name": "session.input.intercept", "scope": "tui/input" }]
  },
  "denies": {
    "noisy": [{ "name": "commands.invoke", "scope": "com.example.noisy.run" }]
  }
}
```

每条规则保留 permission definition 的资源/session/command scope，并可带
`activationId`。没有真实 activation identity 的诊断调用会对
activation-scoped 规则 fail closed；授权文件由 live store 读取，变更会
立即影响下一次操作，并释放关联的 DecisionEvents/observer registration。

`dsh-tui-plugin-host` 行（cordis.patch.yml 已带，位于 extensions 行
之前）提供 `ctx.tuiPluginHost`：runtime generationId（C-050，每次激活
一个 UUID）、统一授权存储实例、Host Descriptor 构建（只声明运行代码
真实提供的契约——commands 服务未挂载的上下文里 Command 契约会被
剔除并告警；vendored 契约文件哈希漂移即 fail-closed 剔除并告警）
与注册表自检。vendored 数据本身也按不可信处理：可解析但结构错误的
registry/permissions 文件视同整体缺失（软降级为空契约面），绝不把
TypeError 留到自检里炸出来。消费一律 `ctx.get('tuiPluginHost', false)`
软探测（#183 纪律），不进入任何 inject 列表。

`storage.local`（C-040）：插件私有持久化，经
`ctx.get('tuiPluginStorage', false)` 的 `open(ctx)` 获得
`{ get, set, delete }`——namespace 来自 admission 后绑定的 Component
identity（没有参数可指名别的插件，跨插件读写按构造拒绝）。标准调用形状是
`get({ key }) -> { value }`、`set({ key, value }) -> { stored: true }`、
`delete({ key }) -> { deleted }`。`get` 需
`storage.local.read`、`set`/`delete` 需 `storage.local.write`，每次调用
现查。后端 `~/.dsh-tui/plugin-storage/<namespace>.json`（原子写 +
文件锁；配额 256 键 / 256 KiB；损坏文件永不自动覆盖，报
STORAGE_UNAVAILABLE 并保留字节供人工恢复）。错误带契约 code：
PERMISSION_NOT_GRANTED / INVALID_KEY / INVALID_VALUE / QUOTA_EXCEEDED /
STORAGE_UNAVAILABLE。值必须是**精确 JSON 值**——JSON.stringify 会
静默变形的输入（undefined、NaN/±Infinity、函数、Symbol、BigInt、类
实例、稀疏数组、环）一律拒绝（INVALID_VALUE），绝不往返出一个插件从未
存过的值；键名即使撞上 Object.prototype 的名字（`__proto__`、
`toString`、`constructor`）也只是普通数据（null 原型表 + 自有属性
判定，不读宿主原型、不伪造存在性）。key 与 value 永不进日志
（privacyClass sensitive）。同 namespace 的操作按调用序串行；插件
卸载即关闭其 handle，数据保留。

`messages.observe`（C-042）：消息观察 broker，经
`ctx.get('tuiMessageObserver', false)` 的
`subscribe(ctx, listener, { scope })` 订阅（身份=传入 ctx 的 verified
Component）。**scope 必须同时出现在 manifest 的 MessageObserver 声明中且
精确匹配**（如 `session:<id>`）——订阅
只收同 scope 的 envelope，跨会话的敏感内容按构造不可达（C-042 范围
隔离）；空/超长 scope 直接拒绝（noop disposer + 告警）。映射刻意收窄：
`user/message` → `message.received`、`assistant/message` →
`message.sent`；流式 chunk、工具与边界事件一律不产出。envelope 逐条
过固定 revision 的 `@dsh-std/messages` validator 才投递：`scope=session:<id>`、`sequence`=会话事件
自身 seq（单调可留洞；图片读取是异步的，broker 内构建串行化，投递
顺序恒等于发布顺序）、`eventId=<sessionId>:<seq>`；privacyClass 一律
`sensitive`（保守起步，细分留待后续）；content 是 text/image 子集
——纯文本消息保持单 text block；会话图片以 `{type:'image',
attachment}` 引用形式存在，broker 经 attachments 服务解析为 base64
image block（单图 192 KiB 预算，不可读/超大/坏媒体型即弃并打
`truncated`）；summary=消毒后前 200 cell。授权
`messages.observe.read`：订阅时快速失败（noop disposer + 告警），
投递时逐订阅复检——撤销即释放订阅（contract cleanup）；每个 callback 有
明确 timeout 与队列上限，超时关闭该 subscription。每个订阅者收到独立且
冻结的 envelope 副本，不能篡改其他订阅者的 payload。订阅成立与
释放（disposer、卸载、撤销三条路径汇一处）都会落效果台账
（bind/release subscription），/plugin 可反查活跃订阅。listener
抛错被隔离续投；at-most-once、无重放；broker 零持久化（contract
retention）。

`commands`（C-041）：插件注册命令应走 plugin-host 行的**托管面**
`ctx.tuiPluginHost.registerCommand(pluginCtx, definition)`——成功注册
会把命令归属打上 verified Component/activation 的印（dsh-commands 本身没有 owner
概念；归属台账见 `src/dsh-adapter/command-attribution.js`），重复注册
抛带 `code: 'DUPLICATE_CONTRIBUTION_ID'` 的映射错误（
`src/dsh-adapter/command-errors.js`），返回的 disposer 同时摘印。宿主
执行注册命令前过 invoke 检查点：先查 `root` 的 `commands.invoke`
（默认允许、可经 `denies` 撤销），再对**已归属**命令查其 owner 插件的
同一权限——denies 掉某插件的 `commands.invoke` 即关闭它的命令在
TUI 里的宿主调用入口（C-041 的撤销语义）。插件直调
`ctx.get('commands').register/execute` 不经归属与检查点（C-070 同进程
信任边界，已声明为平台行为；归属只会收紧、绝不放宽检查）。

效果台账（C-060）：`~/.dsh-tui/effect-ledger.jsonl` 追加式 JSONL，
经 `ctx.get('tuiEffectLedger', false)` 的 `record(entry, identity?)`
写入，永不向调用方抛错。每条带生命周期三元组：pluginId（传入
Component id；root fiber→`'host'`；未绑定→`'undeclared'`）+
activationInstance（按 fiber 首见分配，进程内稳定，热重载即新实例）+
runtimeGenerationId（C-050）。五种 operation：create / bind / replace /
release / cleanup-failed；覆盖场景、快捷键、状态行、渲染器、命令、
存储 namespace 与授权拒绝（PERMISSION_NOT_GRANTED）。每条写入前过
固定 revision ledger schema——记录按 allowlist 逐字段构造，叠加 schema 的
`additionalProperties: false`，结构性禁止夹带秘密材料；校验失败的
记录丢弃不落盘。sequence 跨重启续号；损坏行跳过不改写；schema
schema 缺失时全部写入被抑制（fail closed）。四个托管服务
（tuiScenes / tuiShortcuts / tuiStatus / tuiRenderers）的 register 系
方法带可选末参 `identity?: Context`——传自己的 ctx 即让台账归属
正确，省略记 `'undeclared'`，不传也完全可用（非破坏）。

`/plugin` 诊断面（C-070 + C-030）：首行固定为信任披露 banner（同进程
运行、授权非安全隔离、通过校验 ≠ 插件安全）；随后是 Host Descriptor
摘要（坐标、generation、漂移剔除项）、授权矩阵（8 个注册权限的有效
值；插件集合 = 授权文件键 ∪ 台账 pluginId ∪ 存储目录名的**足迹并
集**，标头如实声明这是足迹视图——profile 实际组合了哪些 bundle 与行是
另一个问题，由宿主的 profile 插件服务（`ctx.pluginManager`）回答，
`/plugin` 在诊断总览之后列出它）与台账尾 5 条。`/plugin check <path>` 先用固定 revision 的
`@dsh-std/manifest.parseManifest` 与 `projectManifest` 解析，再用统一
`ProtocolCatalog`、profile 语义校验与五态 negotiate；没有 activation
identity 时，activation-scoped grant 按 fail-closed 诊断。manifest 是
不可信输入，所有派生行过 cleanScalarText。`/doctor` 追加
插件运行时 generation 与注册表自检两行。

## 终端交互生态插件准入规范（TUI Admission v0.15）

**Status:** Experimental / Product Policy  
**Authority:** dsh-TUI ecosystem maintainers  
**Baseline:** [`Community Consensus v0.15`](#上游公共基线dsh-std--community-consensus-v015)

本部分规定进入 dsh-TUI 插件目录、市场或推荐集合的额外条件。Manifest、协议协商、
composition、lifecycle 以及 Community v0.15 的 Command、LocalStorage、
MessageObserver 和 Presentation 语义来自 dsh-std。

### TUI-PKG-001 Package identity

插件必须在包根目录提供唯一 `dsh-plugin.json`，并通过固定 revision 的
`@dsh-std/manifest` Community v0.15 parser。用于 Verified claim 的 artifact
必须绑定 SHA-256 digest。

### TUI-PKG-002 Declaration closure

Manifest 中的 required/optional protocol、permission、subscription 和 contribution
必须全部静态声明。每项 protocol 必须能由本 profile 导入或拥有的 definition 解析；
optional requirement 必须说明 TUI 可展示的 fallback。

私有 protocol 统一使用 `tui.dsh/*` namespace，必须经过同一 Manifest projection、
`ProtocolCatalog` negotiation、composition 和 lifecycle publication，不能由 TUI
loader 旁路注入。私有坐标固定为 `tui.dsh/v1alpha1`（`DecisionEvents`、`Channel`、
`SettingsSection`、`Scene`、`Backend`）。

`requires.contracts` 也可以引用 `registry/registry-0.15.json` 的 `extensions` 段里的
扩展坐标（今天就是 `tui.dsh/v1alpha1#Backend`，见 `TUI-BACKEND-001`）：解析、negotiation
与"宿主是否 live support"的判定和 protocol 定义走同一条路径，不存在第二套准入。

### TUI-HOST-001 Host descriptor

每个参与验证的 TUI Host 必须提供符合 `schemas/host-descriptor.schema.json` 的
descriptor。Descriptor 精确列出 facet API、protocol supports、definition source、
权限、runtime generation、运行位置、headless 条件、trust level 和平台。

导入的 dsh-std definition 记录 package identity；本 profile 自有 definition 记录
immutable contract profile digest。Host 不得仅凭 package 已安装宣称 live support。

### TUI-RUN-001 Remote determinism

插件不得假定运行机器具有浏览器或 GUI，也不得把 remote/local 或 Presentation 保存为
activation 全局状态。需要用户交互的 command 或 operation 应从 invocation context
取得 `@dsh-std/presentation` 定义的类型化 client，或明确拒绝当前无法呈现的操作。

声明 remote attach 兼容的插件必须覆盖 local runtime、remote runtime、attach/detach
和多 Presentation 场景。remote attach 不是基础 Manifest 的隐式承诺。

### TUI-RUN-002 Trust disclosure

信任档位必须在**装与启用这两个动作之前**对用户可见，不能只写在文档里：任何提供安装或启用的
界面都要写明插件将以本进程内代码运行（`trusted-in-process`：进程内全信任、无沙箱、不自动
更新），并指出声明的权限在哪儿查。**"来源已验证"不是可展示事实**：宿主不提供已装包的来源
证明，目录或 git 检出也能声称嫡系名称与版本，所以只有"精确命中首方 feed 的包"能少问一句，
其余一律走完整披露 + 确认。

dsh-TUI 的落点：`/plugin install` 的确认面板（第三方来源显示信任披露；`first-party` 且声明
可读是唯一跳过确认的分支，跳过后仍打一行"嫡系（feed 命中）……跳过装包信任确认"）与
`/plugin` 生命周期面板的**启用**确认（每次都问 `trust`，显示同一句口径）；声明的权限在
`/plugin` 的授权矩阵里可查。这是**披露**要求而不是隔离要求：permission 与 grants 是行为
约束，不是 OS、进程或 realm 安全边界（见 `TUI-TRUST-001`）。

### TUI-OBS-001 Ownership and cleanup

运行时 effect 必须归属到 component、facet activation instance 和 runtime
generation。deactivate 后不得遗留可调用 handler、订阅、timer 或 connection
attachment；cleanup failure 必须保留可诊断、可重试状态。

### TUI-OBS-002 Removal levels

`disable`（deactivate）、`remove`（uninstall）与 `purge`（删用户数据）是**三种不同效果**，
插件的文档、UI 文案与清理报告都必须区分，不得用一个"卸载"涵盖三种。清理报告只能陈述宿主
**实际**撤销了什么：包已移除 ≠ 资源已清空。

- `disable` 只把行标成 `disabled`：包仍在 profile 里，`enable` 即恢复，不动安装面。
- `remove` 改 profile 的 `dsh.profile.bundles` 与 lockfile（服务失败时回滚），并移除它的行与
  overrides；**不删用户数据**——`~/.dsh-tui/backends/<id>/`、已授予的 grants、storage 命名
  空间都保留，残留只**报告一次**（列出路径），由用户自己决定删不删。
- `purge` 今天**没有实现，也不承诺**：不存在"把痕迹删干净"的动作。宿主读不到包内声明时
  明说"判断不了"，不制造"已清理"的假象。

要求：任何清理报告都按资源类别（配置 / 缓存 / storage / native 与 build 产物）说明保留还是
删除，且只覆盖 ownership record 与 effect ledger 能证明的范围。

### TUI-DEP-001 Dependency closure

验证必须覆盖实际安装 artifact、依赖闭包、native/build step、override/patch 声明和
固定的 dsh-std revision。只验证源码仓库或只执行参考实现测试，不足以产生 artifact
claim。逐项的执行口径（六档 evidence、digest 与依赖闭包的具体范围、provenance 的否决
语义）见下一节。

### 供应链证据与 provenance（执行口径）

本节是 `TUI-DEP-001` 与 `TUI-CLAIM-001` 的执行口径，**不新增要求 ID**：它只把"证据"拆成
可分别记录、不能互相冒充的六档，并说明 claim 绑定在哪几样东西上。术语取自 dsh-std 的
[`provenance`](../../vendor/dsh-std/docs/proposals/provenance.zh.md) 与
[`conformance`](../../vendor/dsh-std/docs/proposals/conformance.zh.md) 提案，evidence profile 见
[说明 0004](../notes/0004-provenance-validation.md)。

**六档 evidence。** 每一档由不同角色产出，能证明的东西不同，**不能互相冒充**
（[governance §5](../governance/rules.md)）：

| 档 | 谁产出 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| `declared` | 插件作者（`dsh-plugin.json`） | 作者声称需要与提供什么 | 声明是否成立、运行时是否真的如此 |
| `parsed` | 固定 revision 的 `@dsh-std/manifest` | 清单能被该 parser 接受，字段与形状闭合 | 语义正确、协商会成功、行为符合声明 |
| `negotiated` | Host 的 protocol catalog 与 admission evaluator | 在本 Host、本 profile、本坐标下能达成 agreement 或降级结论 | 代码跑得动、权限已授权、用户已确认 |
| `tested` | 固定的 suite（`conformance/requirements-v0.15.json` 登记的那些） | 在该 suite 版本上这些用例按期望通过 | 用例没覆盖的路径、真实终端里的行为 |
| `observed` | Host 运行时（ownership record / effect ledger） | 这次 activation 实际注册了什么、清理了什么 | 作者意图、其他 Host 上的行为 |
| `attested` | 构建平台（npm provenance / SLSA attestation） | 这个 artifact 由谁、在哪次构建里产出 | 代码质量、有没有漏洞、与声明是否一致 |

六档都是 evidence，**没有一档是安全保证**（`TUI-TRUST-001` 与说明 0004 末段）。"有
attestation"不等于"已审计"，"通过 fixtures"不等于"没有缺陷"，"观察到一次"不等于"承诺
永远如此"。

**claim 绑定对象。** 一条 claim 必须同时绑定下列六项，缺一项即不成立；其中 Host / artifact /
suite / result / evidence level 有机器可读形状
[`schemas/conformance-claim.schema.json`](../schemas/conformance-claim.schema.json)
（`claimVersion: "0.15"`，`evidenceLevel` 的取值就是上表六档、schema 里首字母大写），字段对应
与缺口见 `TUI-CLAIM-001`：

| 绑定项 | 具体是什么 |
| --- | --- |
| std revision | `vendor/dsh-std` 的固定 revision，以及该 revision 下的 Manifest version 与 definition 来源 |
| profile | 本 profile 的坐标与内容摘要（`registry/registry-0.15.json` 的 `profileHash`，sha256 pin） |
| Host | 被验证的 TUI Host 及其 host descriptor digest（`TUI-HOST-001`） |
| artifact | 实际被安装的那份产物：包名、精确版本、SHA-256 digest |
| suite | 跑的哪套用例：suite 名与 version/digest，以及它覆盖的测试层 |
| result | 每项通过/失败，以及这一项来自哪一档 evidence |

**artifact digest 的口径。** digest 的对象是**会被安装的那个 tarball**，不是源码仓库，也不是
工作树：

- **npm 分发**：以 registry 上的 tarball 为准；本地用 `npm pack` 复现同一份产物后算
  SHA-256。registry 的 `dist.integrity` / `dist.shasum` 是同一产物的另一份摘要，可以交叉
  核对，**不能替代**自己算的那一份。
- **非 npm 分发**（本地目录、git、tarball 链接）：digest 只对**被冻结的那一份产物**有意义；
  给得出就记录，给不出就如实写"没有"（见 `TUI-CLAIM-001`），**不要拿 commit hash 冒充
  artifact digest**。
- digest 在**发布/评审时**计算并随 claim 记录；安装期与运行期都**不重算、不校验**（见下面
  的"执行点"）。

**依赖闭包的范围。** `TUI-DEP-001` 里的"实际安装 artifact + 依赖闭包"在这里具体指：

- **实际安装的 artifact**：用户机器上解析到的那份 tarball，包含 `files` 白名单决定的发布面
  （`dsh-plugin.json` 必须落在里面，否则装到用户机器上就没有声明面）；
- **依赖闭包**：`dependencies` / `peerDependencies` / `optionalDependencies` 的解析结果与
  锁文件一致；
- **native / build step**：需要编译或执行安装脚本的依赖单独列出——构建脚本被拦是安装期的
  一条独立门禁，**不因为"有 claim"而放行**；
- **override / patch**：`overrides`、profile 的 patch 层、bundle 的 `cordis.patch.yml` 都算进
  闭包，它们改变的是实际组合，而不只是依赖图；
- **std revision**：`vendor/dsh-std` 的固定 revision 与 `@dsh-std/*` 版本线对得上；TUI 私有
  坐标固定为 `tui.dsh/v1alpha1`。

只验证源码仓库、或只跑参考实现的测试，不产生 artifact claim（`TUI-DEP-001` 原文）。

**provenance 的否决语义。** provenance / attestation 在本 profile 里只有**否决权**，没有
放行权：

- **不得单独放行**：一份合法的 attestation 不能替代清单条目、不能替代准入、不能替代用户
  确认；它也**不能**把第三方变成嫡系——嫡系只看随包发布的
  [`feed/first-party.json`](../feed/first-party.json)，见 [`feed/README.md`](../feed/README.md)。
- **不一致 ⇒ 降级**：将来某个来源（registry 的 attestation、发布者身份、构建 provenance）与
  已记录的 claim 或清单条目**不一致**时，该次判定降级（嫡系 → 第三方、Verified → 未验证、
  `compatible` → `unknown`），并把原因记进 claim / 报告；**不是**清除字段，也不是静默忽略。
- **缺席 ≠ 失败**：拿不到 attestation 只是"没有这一档 evidence"，不是拒绝、不触发降级——
  除非某条 claim 明确要求了 `attested`（今天没有这样的要求者）。
- **本轮没有任何在线校验**：Host 服务面（`@deepseek-ai/dsh-plugin-manager`）的公开类型不含
  provenance / publisher / attestation，TUI 也没有网络客户端；安装与运行都不查这些。要接是
  后续版本的事，接的时候只接"否决"，不把它升格成"认证"。

**执行点。** 三档，别混：

| 场景 | 谁执行 | 执行什么 |
| --- | --- | --- |
| 本仓库的机器检查 | CI 与本地门禁 | `verify:plugin-spec`（registry pin / 坐标 / fixture 矩阵）、`verify:plugin-feed`（清单格式）、backend 族门禁与 profile 套件 |
| 准入评审 | TUI 团队按「官方准入检查清单」 | 逐条核对 evidence；**人工**，只在被要求准入/上架时发生 |
| 运行时 | 宿主 | **不验** artifact digest、**不验** provenance、**不验** attestation；只做 manifest 投影、协商、权限与组合 |

生态收录（`plugins.json` 与站外市场）**不是**上面任何一档执行点：它是发现渠道，判据与边界
见「收录与推广」。

**措辞。** 展示 verification level 时按档说（"通过本 profile 的 fixtures"、"npm provenance
可得"、"运行时观察"），**不合并成"安全"**，不使用"官方认证""安全插件"等措辞（准入清单
G 节）。

### TUI-CLAIM-001 Claim binding

任何"已验证 / Verified"表述都是一条 **claim**，必须同时绑定 `std revision`、`profile`、
`Host`、`artifact`、`suite`、`result` 六项（定义见上一节），并标明它来自哪一档 evidence。
缺任一项的表述不成立。

机器可读形状是
[`schemas/conformance-claim.schema.json`](../schemas/conformance-claim.schema.json)
（`claimVersion: "0.15"`），绑定项与必填键的对应关系：

| 绑定项 | schema 键 | 说明 |
| --- | --- | --- |
| claim 格式 | `claimVersion` | 固定 `"0.15"`，schema 必填 |
| Host | `hostDescriptorDigest` | `sha256:<64 hex>`；必须是 descriptor 的 digest，不是版本号 |
| artifact | `subject` + `artifactDigest` | `subject` 是 `包名@精确版本`，`artifactDigest` 是 `sha256:<64 hex>`；对象是实际安装的 tarball，两者一起才绑定完整 artifact |
| suite | `suiteVersion` | suite 名与版本的组合；失败项另列 `failedRequirements` |
| result | `result` + `failedRequirements` | `pass` / `fail`，失败项逐条列出 |
| evidence level | `evidenceLevel` | `Declared` / `Parsed` / `Negotiated` / `Tested` / `Observed` / `Attested` 之一 |
| spec 版本 | `specVersion` | 固定 `community-v0.15`，schema 必填；它只是 profile 接入的 spec 版本，**不承载** std revision 与 profile 摘要 |
| std revision + profile | —（schema 无独立键） | 必须随 claim 附上 registry pin（`profileHash`）；`additionalProperties: false` 使它不能内嵌进 claim，附件载体尚未定义，是本形状的已知缺口，接执行体时补 |
| 时间与签发 | `testedAt` / `signer` / `expiresAt` / `revoked` | `testedAt` 必填；其余可选，claim 可签发、可过期、可撤销 |

四条硬口径：

1. **一条 claim 只有一档 evidence level**。要同时说"parsed 过了、tested 也过了"，就是两条
   claim，各自绑定自己的 suite 与结果——这正是"不能互相冒充"的可执行形式。
2. **没有 `artifactDigest` 就没有 claim**（schema 里它是必填）。推论：拿不出产物 digest 的包
   **不能**被标成 Verified；它仍然可以被收录、被安装（两者都不要求 claim）。
3. **作者与参考实现不能自证**：`signer` 必须是不参与该实现的一方（评审方 / 目录运营方）；
   插件作者的自述只是 `declared` 档的输入，不是 claim。
4. **claim 随证据失效**：suite 版本变了、Host descriptor 变了、artifact 重新打包（哪怕只差
   一个字节）、或对应 registry 条目的 `profileHash` 漂了，旧 claim 都不再适用；不一致时按
   上一节的"不一致 ⇒ 降级"处理。

本 profile 今天只发布这个**形状**，没有任何生产者或执行体：宿主会把它读进 profile 的 schema
集合并检查结构完整性，但**不校验任何真实 claim**；准入与安装都不要求 claim。什么时候要求、
由谁签发，属后续版本（与 provenance 的在线校验同一批）。

- Source：`schemas/conformance-claim.schema.json`
- 术语：`vendor/dsh-std/docs/proposals/conformance.zh.md`（ConformanceReport）

### TUI-BACKEND-001 Backend contribution family

后端的公开声明是 `tui.dsh/v1alpha1#Backend`（接缝十四）：`id`、`label`（只收字面量）、
`shortLabel`、`product?`、`capabilities`、`grants`、`install?`、`unloadExport?`、
`confirmation?`。形状由 `protocols/tui-contributions.js` 的 `validateBackendSpec` 判定；
宿主侧再判一次"这个宿主能不能兑现"（`backendAdmission`）：未知的能力/权限名**降级不
拒绝**并记为待决项，已知权限名却没有授权则注册但不进 picker，声明宿主保留 id 时在
准入处被拒（`BACKEND_ID_RESERVED`）。`capabilities` 必须覆盖运行期
`AgentSession.capabilities` 实际返回的键集。

启动恢复只针对所选后端，恢复目标绑定后端身份；后端不可用、没有上次会话、指定会话
不存在一律明确报错并非零退出，不回落、不自动新建。`lastSession` 的接口与恢复目标的
传递方式不在协议内。

- Source：`protocols/tui-contributions.js`
- Fixtures：`conformance/fixtures/valid-backend-contribution.json`（SDK peer 形态：安装配方 + 池钩子）、
  `valid-backend-contribution-cli.json`（系统 CLI 形态：无安装配方 + 池钩子）、
  `valid-backend-contribution-trusted.json`（第二个已实现的确认策略 `trusted-source`）、
  `invalid-backend-unknown-field.json`（即 `nativeKey` 那条反例）、`invalid-backend-bad-id.json`、
  `invalid-backend-key-label.json`、`invalid-backend-capability-shape.json`、
  `invalid-backend-install-incomplete.json`、`invalid-backend-confirmation-policy.json`、
  `invalid-backend-grants-shape.json`
- Test："Backend contribution shape in both backend shapes (SDK peer with an install recipe,
  system CLI with a pool hook), both implemented confirmation policies (confirm, trusted-source),
  capability/grants declaration, the refusals, and resume binding semantics"（automated）

**这一层不校验 `install.executor` 的取值**：宿主不认识的执行器不是拒绝（见接缝十四的"声明形状"），
形状校验也不查执行器表，所以**没有** `invalid-backend-install-executor-unknown` 这条反例——它在
profile 层没有可红的期望，按"不能红的用例不写"的纪律就不写。这条语义由**宿主侧**承重：
`scripts/verify-backend-registry.ts` 有一条用例逐字写着「an executor this host does not implement
registers as "no install surface"」（不抛错、不开向导、配方保留）。

### TUI-TRUST-001 Trust disclosure

当前 profile 为 `trusted-in-process`。Manifest permission 用于兼容性、授权提示和
审计，不构成 OS、进程或 realm 安全边界。市场与安装界面必须明确展示这一点。

### Admission results

TUI admission evaluator 可以展示 `compatible`、`compatible_degraded`、
`waiting_authorization`、`rejected` 和 `unknown`。这些状态是 product policy 对
dsh-std validation、composition、negotiation 和 authorization 报告的投影，不是
另一套 core negotiation result。

私有协议的兼容性只能在 Host 和插件都声明相同 coordinate、definition 可解析且协议
evaluator 成功时成立。

### 接口与兼容性协定：Adapter 映射

宿主侧的真实接口与契约映射见
[`adapters/dsh-tui-v0.15.md`](../adapters/dsh-tui-v0.15.md)。该文件把
`commands.dsh/*`、`storage.dsh/*`、`messages.dsh/*`、`presentation.dsh/*`、
`workspace.dsh/*` 以及 `tui.dsh/v1alpha1#DecisionEvents` / `Channel` /
`SettingsSection` / `Scene` 映射到 dsh-tui 的 adapter 中介面（Cordis service id、
宿主 API、权限与实现模块）。

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
| 十四 · 后端 | 贡献族声明 + 注册 | 第三方后端接入（Backend 贡献族） |

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
  空白、按 terminal cell（不是 `string.length`）截断。只接受标量——
  string/number/boolean 会被强制为字符串，对象/数组等非标量**直接丢弃或
  拒绝**（绝不变成 `"[object Object]"` 出现在屏幕上）。决策事件的
  reason/notice/summary 等 toast 文本走同一套消毒。实现只有一个：
  `src/dsh-adapter/sanitize.ts`，所有接缝共用。
- **插件崩溃不拖垮 TUI**：监听器/处理器抛错被宿主捕获、告警、按"无意见"
  或"跳过该条目"处理。决策事件等待超过约 400ms 会 toast 一个"正在等待
  插件决定"的驻留指示（RFC 0005 D-8），慢插件不会让界面看起来像死了；
  该指示一直驻留到决策落定才撤下（不会中途自动消失），决策一天不定，
  等待状态就一天可见。

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

> dsh-TUI 的 profile 自身带兼容修复（`src/dsh-adapter/compat/sessionLog.ts`），会修补第三方
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
事件渲染工作状态行（见 `src/dsh-adapter/channel.ts` 与 `src/components/ActivityLine.tsx`）。
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

注册条目提供单行标量 frontmatter（`name`、`description`），重复或无效条目跳过，
**绝不让技能注册失败拖垮宿主启动**。注册成功后技能即可通过 DSH 的 `/skills`
面使用。不需要随包注册时，也可把 `SKILL.md` 放进项目 `.agents/skills/<名字>/`
由 DSH 文件系统 provider 直接发现（零代码，dsh-TUI 主包即采用此方式）。

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
  `Theme` 语义键的部分覆盖，完整键表见 [`src/theme.ts`](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/src/theme.ts)。
- 主题文件按**不可信输入**处理：未知键/非法颜色被跳过并警告，损坏文件整体
  丢弃，文件名不能逃出主题目录——你的主题插件也要遵守同样的宽容度。
- 完整契约见[主题系统](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/themes.md)。

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
    // 可选：在 /settings 里单独占一页（tab）。同 page.id 的区块共用一页，
    // 第一个声明决定页标题；省略则并入默认的「常规」页，与 TUI 自己的设置同页。
    page: { id: 'my-plugin', title: 'My plugin', descriptions: { zh: '我的插件' } },
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

- 设置屏按**页**组织：不声明 `page` 的区块都落在「常规」页；声明 `page` 的
  区块按 `page.id` 归组，同 id 的区块共用一页（第一个声明决定页标题），页签
  按注册顺序排在「常规」之后。`page.id` 用 `[a-z][a-z0-9_-]*`，标题不能为空。
  用户用 `Tab` / `Shift+Tab` 或**点击页签**切换页；整套组合只有一页时页签
  不显示，版面与只有一页时完全一致。字段、分组、保存语义都不受分页影响。

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

### preset 内的行（实验性）

Agent preset 里的行（如 `standard` 的 `compaction-basic`）运行在 preset 自己的
realm 里，按 id 的 patch 够不到。dsh-TUI 注册的 preset（`standard` / `ptc` /
`minimal` / `cordis` / `liangshen`）改用 preset-patch 行：

```yaml
- insert:
    - id: my-plugin-standard
      name: '@deepseek-harness-tui/dsh-tui/preset-patch'
      config:
        preset: standard
        config:
          compaction-basic: { auto: false }
```

- `config.config` 把 preset 里的行 id 映射到替换后的 `config`，语义同上面的覆盖行
  （**整块替换**）；嵌套在 group 里的行也能命中，找不到的 id 会告警。
- 与插件加载顺序无关；同一 preset 的多行合并，同一行 id 后者覆盖前者。
- profile 自己声明的 preset 归 profile 所有，不受影响。

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

pi 风格的 before-event：TUI 在关键动作的**执行前**把决策权交给已 admission
的 Component。决策事件按稳定的 `order -> componentId -> activationId`
顺序逐个 await，并受单 handler/总 deadline 约束；**第一个返回有效决策的
handler 生效**。宿主做了逐 handler 归一化与隔离：

- 返回 `undefined`/`null`/`false` = 无意见，链继续；
- **畸形返回不算决策**——空白 `{ text }` 改写、非对象值、空的 `modes`
  列表等会被忽略并告警，链**继续**（一个写错的插件不可能把后面的安全
  否决插件跳过去）；
- handler 抛异常或超时只跳过该 handler 并告警，链**继续**；总 deadline
  到期后剩余 handler 按 no-opinion 处理；
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

- **拦截类订阅需要显式授权（RFC 0005 D-7，默认拒绝）**：订阅 `tui/input`、
  `tui/rewind-prompt`、`tui/session-switch`、`tui/compact` 的插件必须在
  `~/.dsh-tui/extension-grants.json` 里持有对应 grant，否则订阅不进入决策
  链（视同未注册）并告警。权限命名 `domain.resource.intercept`：
  `tui/input` → `session.input.intercept`、`tui/rewind-prompt` →
  `session.rewind.intercept`、`tui/session-switch` → `session.switch.intercept`、
  `tui/compact` → `session.compact.intercept`。通知类事件
  （`tui/rewind-done`、`tui/session-switched`）仍要求私有 DecisionEvents
  contract，但不需要 intercept grant。授权文件按 verified Component id
  keyed，规则保留 event/session scope 并可绑定 activationId：

  ```json
  { "grants": { "my-guard": [{ "name": "session.input.intercept", "scope": "tui/input" }] } }
  ```

  授权门由 extensions 行与 channel 共同安装（按 cordis root 幂等），但
  GrantStore 对每次操作读取 live policy；改授权无需重启，撤销会主动释放
  handler。文件缺失 = 按注册表默认值（拦截类默认拒绝）；文件不可解析 =
  全部拒绝，连默认允许的权限也拒（fail closed）。该文件是统一的 8 权限
  授权存储（另有撤销段 `denies`），完整语义见"上游公共基线"一节。
- **顺序保证**：决策与投递按提交顺序串行——前一条输入的慢决策会拦住
  后一条的决策与投递，模型收到的消息顺序恒等于用户提交顺序。每条输入
  在**入队时**就绑定其来源会话：即使它排在慢决策后面、等到执行时用户
  已经切了会话，这条过期输入也会被丢弃并提示，绝不会发进新会话。
- `cancel.reason` / `handled.notice` / `tui/rewind-done` 的 summary 以 toast
  呈现；缺省时宿主给本地化兜底文案（裸 `{ cancel: true }` /
  `{ handled: true }` 不会让输入静默消失）。这些文本同样按不可信输入
  消毒（控制字符剥离、≤200 cell）。
- `tui/input` 的 `{ text }` 会被 trim；trim 后为空按"无意见"处理。改写只在
  **投递前**生效，等待期间如果用户切了会话，这条过期输入会被丢弃并提示
  （stale-drop），绝不会把旧会话的话发进新会话。`tui/session-switch` 与
  `tui/rewind-prompt` 同理：慢决策等待期间发生了别的会话切换，这条过期的
  切换/回退请求直接丢弃（按 agent 引用比较，会话 id 复用骗不过去）。
- `tui/rewind-done` 与回退结果**解耦**派发：被回退的消息文本立即回到输入框，
  摘要监听器慢或不返回都不会延迟草稿恢复，也不会挡住随后的
  `tui/session-switched`；摘要字符串在监听器落定后再 toast。
- submit、steer 与 Ctrl+Enter（interruptAndDeliver 的重排队）**都**经过
  `tui/input`——没有能绕过插件拦截的发送路径。
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
  ≤400、输入 ≤500、选项 ≤100 个（超出截断）。**例外：select 的选项
  `id` 不参与渲染**，只做类型+非空校验并**原样返回**——它是插件回查自己
  options 的 opaque token，消毒会把长 id 或带空白的 id 变成另一个值。
- 面板按键：↑/↓ 移动、Enter 确认、Esc/Ctrl+C 取消；input 是对话框内部的
  单行编辑（左右/Home/End/退格/删除），与主输入框互不影响。
- 粘贴防护：bracketed paste 进单行输入会被压平（换行/控制字符 → 空格）并
  与逐字输入同受 ≤500 cell 上限约束；纯换行的粘贴**不会**被当成 Enter——
  confirm 的默认焦点不会被一次粘贴误触发，select/input 同理。
- 服务缺席（旧 profile）时 `ctx.get` 返回 `undefined`——插件自己决定跳过
  交互还是走无头默认值；`timeoutMs` 是"有服务但没有 TUI 消费者"场景的
  保险丝。

典型搭配：在 admitted handler 里弹窗——`await dialogs.select(…)`。traceable
service 会把调用者 Context 绑定到 dialog 生命周期；插件 deactivate 后，排队
和 active dialog 都会以取消值结算，不会留下占键盘的请求。没有 traceable
proxy 的 embedder 可显式调用 `dialogs.select(ctx, request)`。

## 接缝十一：状态行（tuiStatus）

键控的状态行贡献——pi 的 `setStatus(key, text)`。所有插件的贡献按"首次
设置顺序"拼成一行（` · ` 连接），渲染在提示框上方：

```ts
const status = ctx.get('tuiStatus', false)
const dispose = status?.set('my-plugin', '构建中 42%')   // 设置/更新
ctx.effect(() => () => dispose?.())   // 清理挂在【调用者】自己的 fiber 上
status?.set('my-plugin', undefined)      // 主动清除（传 '' 同效）
```

- key 规则：`/^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/`（冒号分段即
  `插件:子项` 命名约定的语法化；大小写按既有纪律归一为小写）；最多 20
  个 key，文本 ≤200 cell；违规拒绝并告警，不抛错。文本只接受标量
  （string/number/boolean 强制为字符串），非标量**拒绝**而非清除。
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
- **保留位不发**：TUI 内建绑定（ctrl+c/d/t/r/g/o/l/e/v/a/u/k/w、ctrl+←/→、
  ctrl/alt+Enter、alt+↑、Esc、Tab、Shift+Tab）在注册时即被拒绝。这是
  "本地优先"的强制面：冲突永远到不了匹配器。内建匹配是**修饰键子集**
  判定（`isMod && 字符`，不排除额外 Shift），所以保留位的 shift 超集
  同样被拒——`ctrl+shift+g` 在不区分 Shift 的终端上就是 Ctrl+G，注册了
  只会遮蔽内建或永远不响。
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

## 接缝十四：后端（Backend 贡献族）

前十三道接缝说的都是"插件往 TUI 里加什么"；这一道声明的是**一个后端在宿主里长什么样**：
由它开进程、答话哪套会话能力、要哪些宿主权限、怎么装、退出时关哪个资源池。
与九~十三不同，它不是 `ctx.tui*` 服务：声明随 manifest 的
`x-dsh-tui` 进来（与设置区块、全屏场景同一个 extension catalog），注册与判定
发生在 profile 的准入层。字段语义、词表与恢复语义的完整口径见
[说明 0009](../notes/0009-backend-contribution.md)。

**当前状态：`alpha`，不承诺。** 类型面、definition、contract profile、conformance
与**准入链路**（清单 → registry → descriptor）、**装配链路**（装 → 重启 → 进 kernel picker）
都已可用，第三方 bundle 的声明过得了准入，也会在重启后出现在 picker 里。

### 声明形状

```json
{
  "apiVersion": "tui.dsh/v1alpha1", "kind": "Backend", "id": "com.example.backend",
  "name": "example_backend",
  "spec": {
    "id": "example-agent", "label": { "text": "Example Agent" }, "shortLabel": "Example",
    "product": "example-cli",
    "capabilities": ["permissions", "models", "rename"],
    "grants": [],
    "install": { "executor": "pnpm-profile-add", "specifier": "@example/agent-sdk@1.2.3", "version": "1.2.3" },
    "unloadExport": "closeExamplePool",
    "confirmation": { "policy": "confirm" }
  }
}
```

- `id`：`^[a-z0-9][a-z0-9-]{0,31}$`。宿主自己的 id（`dsh`/`claude`/`codex`）是保留字，
  贡献声明其中之一在准入处被拒（`BACKEND_ID_RESERVED`）。
- `label` **只收字面量**——宿主 i18n 键是宿主的词表，贡献不许借它说话。
- `shortLabel` 必填；`product`、`install`、`unloadExport`、`confirmation` 可选。
- `install` 是**安装配方**，不是包名：`executor` 说的是"怎么装"（宿主实现的一道程序），
  `specifier` 说的是"装什么"——**版本就钉在它里面**（`@scope/name@<version>`，原样交给执行器，
  宿主不再拼一次），`version` 是同一个钉的可读副本（确认面板显示、宿主校验用）。**取值集合
  属于宿主**——今天只实现 `pnpm-profile-add`（在 profile 根跑一次 `pnpm add <specifier>`）；
  宿主**不认识的执行器读作"没有安装面"**：bundle 照常注册、配方原样保留，只是那一行退回
  检测自己的 hint、不开向导，**不是拒绝**。不写 `install` 同样是一等公民（系统 CLI 形态：
  用户自己的二进制就是依赖）。取值集合**只增不删**：加一个执行器是加法，不改本坐标。这条
  配方是给后端**自己的运行时依赖**用的，**不是** bundle 的发行方式——装 bundle 走
  `/plugin install`（收包名 / 路径 / git URL），与本字段无关。
- 未知字段一律拒（`nativeKey`、`inTree` 之类 in-tree 私有项因此进不来）；声明里
  的文本按不可信输入净化：剥控制字符、按 terminal cell 截断。
- `confirmation` 是**请求**，不是自授豁免：缺省 `confirm`（宿主始终询问）；`trusted-source`
  请求走宿主的可信来源通道，宿主按自己的判据决定，判据不成立一律 fail closed 退回
  `confirm`。判据与四条边界（嫡系清单 + provenance 交叉、免确认 ≠ 免记录/免展示、
  只覆盖该包本身、伪装嫡系退回确认）见 `notes/0009` 的「Permissions and security」。
  未知取值一律拒；取值集合只增不删。

### 公开子集与 in-tree 私有项

宿主自己后端的 manifest 是这份公开声明的**超集**：`inTree`、`alwaysAvailable`、
`nativeKey`、`vendorPackages`、`backendExport` 与 `label.kind === 'key'` 都是仓内私有项。
投影只有一个方向（`backendContributionOf()`，把 manifest 剥成公开声明），门禁断言
每个内建后端都投影得干净、且投影结果过 `validateBackendSpec()`。

### 准入判定

`validateBackendSpec` 只答"形状对不对"，"这个宿主能不能兑现"由宿主侧
`backendAdmission` 判，复用插件准入的五态：

| 判定 | 触发 | 结果 |
| --- | --- | --- |
| `compatible` | 能力与权限都在词表内且已授权 | 注册并进 picker |
| `compatible_degraded` | 能力名或权限名不在宿主词表内 | 注册，记为待决项（`capability:<name>` / `permission:<name>`），**不拒绝** |
| `waiting_authorization` | 权限名已知但没有授权（`PERMISSION_NOT_GRANTED`） | 注册但**不进 picker** |
| `rejected` | 声明了宿主保留的 id（`BACKEND_ID_RESERVED`） | 抛错，内建 manifest 走到这里必须是响亮的构建期错误 |
| `unknown` | 保留给将来的协议版本协商 | 今天不产生（W-2 只接线，不引入版本协商） |

### `unloadExport` 的池语义

`unloadExport` 只用于**模块级/进程级**资源池（跨会话复用的那种）；会话级资源归
`session.dispose()`。宿主只对**真的加载过**的条目记账并调用：「未加载即不关池」是
宿主的不变量——没加载过的后端不会被 import，也不会被关池；第二次 unload 是 no-op。
失败必须响亮且归属于具体条目，不能拖垮别的贡献或基础 TUI。

这条的**执行强度在宿主**：贡献写不出"我没被加载就别关我的池"，那是注册表的记账行为
（`src/dsh-adapter/backend-registry.ts`）。所以它的反例在宿主门禁里——
`scripts/fixtures/probe-backend/` 的假后端配一份独立模块的池台账，
`scripts/verify-backend-contribution.ts` 用它钉住三条不变量与幂等性。conformance fixture
层不承载这条：manifest 里没有"我还没被加载"这种形状。

### 命令名与宿主命令表

后端 MUST NOT 依赖宿主的命令表：不读它来决定自己注册什么名字，也不假定宿主的某个命令
一定存在。要保留的名字从**自身能力面**派生（自己实现的命令 + manifest 里声明的
goals / channels / permissions 一类名字）。

重名由**宿主**在合并与分发两处丢弃（local names win：`session-controls.ts` 的合并、
`Chat.tsx` 的本地命令判定），因此后端侧不需要 `local.has(name)` 一类防御。这条不是形状
规则——`validateBackendSpec` 不校验命令名，写在这里是让你知道**谁负责**。

### 恢复语义

启动恢复**只针对所选后端**，恢复目标**绑定后端身份**：裸 `--resume` 只查该后端
自己的 `lastSession`；后端不可用、没有上次会话、指定会话不存在，一律**明确报错并以
非零退出**——不回落、不恢复别的后端的上次会话、不自动新建会话。`lastSession` 的接口
与恢复目标的传递方式不在协议内。安全模式的「重试正常启动」是唯一例外（一次性 env
`DSH_TUI_RESUME_RETRY`，撤销降级为告警 + 冷启动），它同样不进协议。

### W-2：准入链路（声明过得了准入）

**声明过得了准入。** 前五道接缝之外，`Backend` 这一族在 W-2（Stage C 第一段）里接完了
它的准入链路：

- `registry-0.15.json` 的 `extensions` 段有 `tui.backend` 条目（sha256 钉住
  `registry/contracts/backend-v1alpha1.json`），注册表读者、descriptor 的 supported
  contracts 派生、准入 index 三处都读它；
- `Backend` 是宿主发布的契约坐标（与 `DecisionEvents` 同一个 provider 形状），bundle 可以在
  `requires.contracts` 里引用它；
- 贡献定义由生产准入 catalog 注册（`src/adapter/standard/tui-extension.ts`），所以
  `x-dsh-tui` 声明在准入时有定义可解析；
- descriptor **只在真探针证据上**发布该坐标（`ctx.tuiPluginHost.probeBackendAdmission()`，
  只读、无副作用）：new 内核路径按 live lifecycle 证据，默认的 `legacy` 路径按挂载拓扑里的同一
  个探针；探针缺席或答不出"可准入"就不发布并说明原因。

### 装配链路（D-1）：装 → 重启 → 进 picker

**装链路也接线了。** 准入保证"声明过得了"，装配保证"它真的出现在 picker 里"。一个后端 bundle
要进 picker，除上面的声明形状外还要满足三件事：

- **它是 profile 的一层**：`package.json` 声明 `dsh.bundle`，于是安装时它被写进 profile 清单的
  `dsh.profile.bundles`（`/plugin install` 与 `dsh plugin add` 同一条路）。宿主扫的就是这份名单——
  只装依赖、不成为一层的包不会被组合，也就不会被装配。
- **清单在包根**：启动时按 `dsh.profile.bundles` 逐个包，用 Loader 自己的 ESM resolver 解析它的
  入口，再从入口**往上找到确立包根的那个 `package.json`**，只有**同目录**的 `dsh-plugin.json`
  才算数（#1568 的身份规则，深层目录里的野清单不得冒领外层包的身份）。
- **实现导出叫 `backend`**：`backendExport` 是 in-tree 私有项，声明里没有它的位置，所以宿主按
  `backend` 这个约定名从包入口模块的命名空间里取 handler（`assertBackendHandler()` 断言形状），
  `spec.unloadExport` 也是从同一个命名空间取。**模块只在真的选中该后端时才 import**——装了没选
  的后端不会被执行。

当前一个 bundle 只接一个 `Backend` 声明：固定的 `backend` 导出只能绑定一个 handler 身份，
多个声明会明确拒绝。handler 由 `assertBackendHandler()` 校验，且其 `id` 必须等于 `spec.id`，
之后才可用于会话、恢复与数据目录。清单也须通过规范投影，包括贡献身份的唯一性。
等待授权的条目仍注册身份，但不参与内核探测，也不能被加载；启动参数或配置显式指定它同样会失败。

**时序是硬约束**：这份扫描**同步**发生在后端选择的**注册表成员判定之前**。DSH profile 路径的
Config Schema 先做语法校验，保留合法的第三方 id；`apply` 装配后才查询该 id 是否已注册。
独立入口 `dsh-tui` 先准备中性的 Loader/模块解析根，装配后决定最终内核，再用同一个值选择
DSH 专用服务、完整/轻量 profile 与入口 slot；发现前的路由只用于宿主不可用时的回退。
`apply` 再装配时，同一组合上的第二遍是 no-op。过早做成员判定不是"晚点出现"，而是把选择误读成
未知值。装配读的是**文件**（profile 清单）与 Loader 的 resolver，不依赖任何 bundle 行已被激活。
行为回归分别由 `verify-backend-assembly`、`verify-backend-config` 与 `verify-backend-host` 覆盖。

**判不了就说出来**：Loader 没有 Node internals（拿不到它自己的 resolver）时，宿主**不猜**组件身份，
一个包都不注册并给出一行原因；某个清单读不懂、投影不出、准入拒绝时，宿主给一行**归属到该 bundle**
的告警，其余 bundle 照常装配——一个坏声明拖不垮别的贡献，也不会静默消失。

**不承诺**：装了但**没重启**就期望 picker 出现，不是承诺（承诺是装 → 重启 → 出现）。

完整口径与逐条门禁见
[说明 0009](../notes/0009-backend-contribution.md) 的「Wired (W-2)」与「Assembled (D-1)」两节；
可照抄的实例是仓内夹具 `scripts/fixtures/third-party-backend/`（按公开面写的第三方 bundle，
`scripts/verify-backend-assembly.ts` 把它装进一次性 profile 跑完整装配链）。

## 命名与发布规范

**命名是双轨的**：裸名与 scoped 包名都是一等公民，**不因命名被拒**。

| 形态 | 谁用 | 说明 |
| --- | --- | --- |
| 裸名（如 `dsh-code-memory`） | 社区插件 | 生态侧已有实例；bundle 的 patch 按包名解析，裸名形态最稳 |
| `@dsh-tui-ecosystem/<name>` | 生态组织内的新包 | **建议**而非要求；模板用的是它 |
| `@deepseek-harness-tui/*` | 官方核心包 | 生态插件不要使用；`@deepseek-ai/*` 属宿主上游，也不要占用 |

- **不要求**组织仓库（生态收录里的项目绝大多数在个人账号下），**不要求** scoped。
- **名称是稳定标识**：bundle 解析按包名逐字匹配，改名对用户就是换一个包；要改就发布新名并
  写清迁移，不要让旧名静默失效。
- **仓库归属**：source repository 要可定位（`package.json` 的 `repository`），与 README、
  issue 对得上；供应链评审以它为准（`TUI-DEP-001`）。
- **许可证**：许可证必须可定位，且与 `package.json` / README 一致；MIT（与主包一致）是最省
  事的写法。
- **版本与标签**：语义化版本；发布由 `v*` tag 驱动，**tag 必须等于 `package.json` 的
  version**（主包与生态侧唯一已发布包的发布流程都这么做；两者不等时发布流程直接失败）。
- **provenance**：可得出 provenance 时**附上**（npm 上优先用 trusted publishing；静态
  `NPM_TOKEN` 是降级做法）。它是 `attested` 档 evidence 的来源，不构成准入（见「供应链证据与
  provenance」）。
- **Node 与模块形态**：`^22.19 || >=24`，纯 ESM（`type: "module"`），相对导入带 `.js` 后缀。
- **发布前先查名**：npm 上是否已被占用；被占用就换个名字，不要指望 scope 能解决——裸名与
  scoped 是两条并行的合法路线，不是新旧的替代关系。

**嫡系资格 ≠ 生态准入**：首方 feed **只收 scoped** 名单条目，用 scope 当"离线可判的发布者"
（见 [`feed/README.md`](../feed/README.md)）。这条规则**只**决定安装时要不要先问一句信任，
不决定一个包能不能被准入、被收录、被安装；反过来，"用了 scoped"也不等于嫡系——feed 里没有
的精确 `name@version` 一律按第三方处理。

## 从旧模板迁移（只有 `cordis.patch.yml` 的包）

2026-08 版 `plugin-template` 生成的包只有 `cordis.patch.yml`、没有 `dsh-plugin.json`。这类包
能装、能组合，但**没有声明面**：它不参与准入，不能声明 `Backend`，也不发布协议坐标——**不是
"默认通过"，而是"没有可判的东西"**。安装本身仍归插件管理器（`/plugin install` 或
`dsh plugin --profile dsh-tui add`），本仓库不代装。

迁移清单（逐条可执行）：

1. **补 `dsh-plugin.json`**（包根、唯一，`TUI-PKG-001`）：
   - `$schema` 用绝对 URI；`manifestVersion: "0.15"`；manifest 由固定 revision 的
     `@dsh-std/manifest` parser 接受（**不要求联网取 schema**）；
   - `id` 稳定且唯一（不随版本变）；`version` 与 `package.json` 对齐；`name` 是展示名
     （`projectManifest` 的 `displayName`），不必等于包名；
   - `facets.host`：`entry` 指向包内入口（相对路径，不许 `..`）、`apiVersion` 写
     `v1alpha1`（facet API 版本，不是私有协议坐标；私有协议坐标见第 3 步）；不写
     `client` / `worker` facet；
   - `requires.contracts`：required 必须能由本 profile 导入或拥有的 definition 解析，optional
     要写 TUI 可展示的 fallback（`TUI-PKG-002`）；
   - `permissions`：`name` / `scope` / `reason` 三项，最小集，逐条写 `reason`；
   - `contributes`：至少 `commands: []`（没有命令就写空数组）；`panels` 在 v0.15 必须为空；
   - `subscriptions`：数组，没有就写 `[]`；
   - **不写** `provides`、**不写** `requires.services`。
2. **保留 `cordis.patch.yml`**：组合层不变；manifest 不会替它注入行，两者是两件事。
3. **要声明私有贡献就把坐标指向 `tui.dsh/v1alpha1`**：`Backend` 族见接缝十四；声明里的
   `id` / `capabilities` / `grants` / `install` 会先过 `validateBackendSpec`，再被宿主准入判
   一次（五态见接缝十四）。
4. **把 manifest 放进发布面**：`files` 白名单必须含 `dsh-plugin.json`（和
   `cordis.patch.yml`，如果仍然用它），否则用户装到的 tarball 里没有它。
5. **发布前本地验证**：固定 revision 的 parser 能接受；对照「官方准入检查清单」逐条自查；
   改动渲染、键盘或终端协议的流程按「验证清单」在真实 TTY 里手动跑一遍。
6. **发布流程**：`v*` tag 等于 `package.json` 的 version；能出 provenance 就开（见「命名与
   发布规范」）。

判据与 `TUI-PKG-001` / `TUI-PKG-002` 一一对应：**没有 manifest ⇒ A 节第一条不成立；
manifest 缺声明闭包 ⇒ B 节不成立。旧模板因此天然过不了准入，而不是被特殊放行。**

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

## 官方准入检查清单（Admission Checklist）

这是 TUI 团队进行插件生态准入的机器/人工联合检查表。逐项要求 ID 见上方
“终端交互生态插件准入规范”。

### A. 包与身份

- [ ] `TUI-PKG-001`：根目录唯一 `dsh-plugin.json`
- [ ] `$schema` 是绝对 URI，且固定 revision 的 `@dsh-std/manifest` 接受 manifestVersion 0.15（不要求联网获取 schema）
- [ ] plugin `id` 稳定且唯一，version 合法
- [ ] manifestVersion = 0.15；`facets.host` 的 entry / apiVersion 明确（client/worker 不出现）
- [ ] source repository、license 可定位
- [ ] Verified artifact digest 可验证，依赖/产物 digest 与 claim 绑定

### B. 声明完整性

- [ ] `TUI-PKG-002`：required/optional 契约坐标、permissions、subscriptions、contributes 全部声明
- [ ] protocol definition 可从固定的 dsh-std imports 或本 profile 提供的 definitions 取得；本地 profile digest 一致
- [ ] 不声明 `provides` 或 `requires.services`
- [ ] `@dsh-std/command` extension 与 composition 检查无冲突

### C. TUI 兼容性

- [ ] `TUI-HOST-001`：TUI Host Descriptor negotiation 通过
- [ ] `TUI-RUN-001`：headless、remote/local 和 Presentation 边界明确
- [ ] 不假设本机存在 GUI 或浏览器
- [ ] 不在 activation 时缓存单一 Presentation
- [ ] 声明 remote attach 时通过对应 profile 测试
- [ ] `TUI-BACKEND-001`：`Backend` 贡献声明通过 `validateBackendSpec` 与宿主准入，
      fixtures 按预期通过/拒绝（准入链路已接线；真实装链路见接缝十四）

### D. 运行时行为

- [ ] `TUI-OBS-001`：activation 顺序和 runtime generation scope 符合 contract
- [ ] 重复 activation 行为确定，异常不破坏 Broker 生命周期
- [ ] 注册资源可定位到 activation instance
- [ ] cleanup 结果可观测且失败可重试

### E. 清理与恢复

- [ ] `TUI-OBS-002`：deactivate / uninstall / purge 语义区分
- [ ] grant、subscription、Broker resource 能撤销
- [ ] 残留资源不会被报告为完全卸载
- [ ] 配置、缓存、storage 和 native/build 产物的保留/删除策略明确

### F. 信任与声明

- [ ] `TUI-RUN-002`：展示 trusted-in-process 和非沙箱警告
- [ ] `TUI-DEP-001`：Reproducible 的依赖闭包和 digest 证据完整
- [ ] `TUI-CLAIM-001`：claim 绑定 std revision/profile/Host/artifact/suite/result，
      一条 claim 只有一档 evidence
- [ ] effect ledger 不记录 secret、credential、token 或消息正文

### G. 市场展示

- [ ] compatibility decision、verification level、restrictions 分开显示
- [ ] 明确显示 capability、permission、依赖和 TUI-only limitation
- [ ] 不使用“官方认证”“安全插件”等未授权措辞

## 验证清单

```sh
pnpm install --frozen-lockfile
pnpm build                       # tsc -> lib/types/
dsh plugin --profile dsh-tui add <你的包>   # 装进 profile
dsh --profile dsh-tui            # 真实 TTY 手动验证（无头断言不充分）
DSH_TUI_DEBUG=1 dsh --profile dsh-tui      # 需要调试时
```

改动渲染、键盘或终端协议时，还要跑主包的 CI 回归（见
[贡献指南](../CONTRIBUTING.md)）。

## 收录与推广

生态里有**三层**，判据不同、维护者不同、结论不能互相顶替：

| 层 | 谁维护 | 判据 | 能得出什么 | 不能得出什么 |
| --- | --- | --- | --- | --- |
| **仓内 profile 准入** | 本仓库（`tui-profile/`，随代码修订） | 协议 / 形状 / 坐标 / digest / conformance（本指南与 `conformance/`） | `compatible`、`compatible_degraded`、`waiting_authorization`、`rejected`、`unknown` 五态 | 安全性、质量、"官方认证" |
| **首方 feed** | 本仓库随包发布（`tui-profile/feed/first-party.json`） | 精确 `name@version`、只收 scoped、一个版本钉死一份 | 安装时**免一次信任确认**的那份名单 | 准入结论；不在名单里不等于不能用 |
| **生态收录** | 生态组织（`dsh-tui-ecosystem`） | `plugins.json` + `plugins-pr.yml` 的校验（下表） | 出现在 [dshtui.com/plugins](https://dshtui.com/plugins) 的目录条目 | 准入、验证、背书 |

**生态收录实际查什么**（收录仓的 `plugins-pr.yml` → `.github/scripts/validate-plugins.mjs`，
2026-10 口径）：

1. `plugins.json` 是合法 JSON，且 `plugins` 是数组；
2. 每条必填 `name` / `displayName` / `description` / `author` / `repo` / `kind` / `addedAt`，
   `kind` 只能是 `plugin` / `template` / `core`；
3. `repo` 是 `https://github.com/owner/repo`；插件名与仓库地址都不重复（大小写不敏感）；
4. **新增**条目：仓库真实存在且公开，PR 提交者是该仓库 owner 或 collaborator；
5. **新增**条目：仓库 README 里有指向 dsh-TUI 的链接（`https://dshtui.com` 或主仓地址）。

五条过了之后可选一次 AI 审查（没有 API key 就跳过；审查标记为需要复核时不自动合并），再由
`MERGE_TOKEN` 自动 squash 合并并触发站点部署。

**它不查**：npm 上有没有发布、包名是裸名还是 scoped、有没有 `dsh-plugin.json`、manifest 能
不能被解析、有没有 provenance / attestation、声明了哪些能力与权限。所以：

> **收录 ≠ 准入 ≠ 背书。** 收录只说明"仓库公开、作者本人提交、README 回链了本产品"；它不
> 说明插件符合本指南的任何一条要求，也不代表 dsh-TUI、生态组织或其成员对插件的功能、质量
> 或安全作任何背书或担保。反过来，没被收录的插件一样可以安装、可以自己发布。

投稿两条路：

- **收录仓 PR**：向 `dsh-tui-ecosystem/dsh-tui-ecosystem` 的 `plugins.json` 加一条，按上面五
  条自查；
- **友情链接**：主仓 [`docs/links.md`](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/links.md)
  的 PR——罗列性质，同样不构成背书。

建议顺序是**先过本指南的检查清单、再投稿**，并在 README 里写明依赖的 dsh-TUI 版本下限、随
主包版本更新兼容性说明；这是建议，不是收录的前置条件（收录流程不读本指南）。
