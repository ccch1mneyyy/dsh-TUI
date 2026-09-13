
<p align="center">
  <img src="docs/assets/logo.svg" alt="dsh-TUI - DeepSeek Harness terminal interface" width="560">
</p>
<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>


<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <img alt="官方收录" src="https://img.shields.io/badge/DeepSeek%20Harness%20官方公众号-收录-brightgreen">
</p>

# dsh-TUI

>一个面向 DeepSeek Harness 的交互式终端界面插件：提供像素鲸鱼顶栏、实时工作状态行、流式思考展示、双击 Esc 时间回溯、上下文进度条与 TPS 仪表。
>零核心改动，纯插件挂载。安装插件即可启用，卸载后不会留下核心补丁。
>
>An interactive terminal UI plugin for DeepSeek Harness: pixel-whale header, live work status, streaming thinking display, double-Esc time rewind, a context progress bar, and a TPS gauge.
>Zero core changes, pure plugin mounting. Install to enable; uninstall leaves no core patches.

## 🎉 官方收录

本插件被 **DeepSeek Harness 官方公众号** 推文收录，也被 [dshfind](https://dshfind.com/ccch1mneyyy/dsh-TUI) 插件目录与 [GitHub Trending](https://trendshift.io/repositories/146168) 收录，同时登上了Github Treding日榜第七

<div align="center">
  <table>
    <tr>
      <td align="center" valign="middle" width="50%">
        <img src="screenshots/wechat-official.png" alt="DeepSeek Harness 官方公众号推文收录 dsh-TUI" width="480">
        <br>
        <strong>DeepSeek Harness 官方公众号推文收录</strong>
      </td>
      <td align="center" valign="middle" width="50%">
        <a href="https://dshfind.com/ccch1mneyyy/dsh-TUI"><img src="https://dshfind.com/api/card/ccch1mneyyy/dsh-TUI?lang=zh" alt="dsh-TUI on dshfind" width="420"></a>
        <br>
        <strong>dshfind 插件目录收录</strong>
        <br><br>
        <a href="https://trendshift.io/repositories/146168" title="GitHub Trending 日榜 #7 · TypeScript 口径"><img alt="Trendshift" src="https://trendshift.io/api/badge/trendshift/repositories/146168/daily?language=TypeScript"></a>
         <br>
        <strong>dshfind Github Treding榜第七 </strong>
      </td>
    </tr>
  </table>
</div>

## 核心能力

Windows Terminal 支持 Sixel 时，全屏会话记录可直接显示内嵌缩略图，点击后打开大图预览；非全屏 inline 模式仍保留文字回退。
Sixel 使用最多 256 色的自适应调色板，透明像素与背景合成；Worker 缓存量化结果，滚动时仅编码可见部分，移出视野或被浮层覆盖时擦除旧图。
附件读取与解码最多两路并发；最后一个使用者离开后取消读取，未启动的解码不再执行。多图缓存、排队任务与单帧传输均有容量上限，超限时保留文字回退。
自动探测优先 Kitty，其次使用 DA1 声明的 Sixel 能力。`DSH_TUI_IMAGE_PROTOCOL=auto|kitty|sixel|none` 可覆盖协议选择；
`DSH_TUI_DISABLE_TERMINAL_IMAGES=1`、无障碍模式、非 TTY 输出以及 tmux/screen 仍禁用图形。
缺少图片依赖或编码失败时保留文字回退；强制协议也不会启用 inline Sixel。
浅色主题的面板和图片预览默认使用白底，图片预览边框使用中性色。
大图预览以对话区约 95% 宽高为预算，最长边可达 2048 像素，仍限制总像素量和后台开销；缩略图大小不变。
预览支持适应窗口、100% 原像素与 200%/400%/800% 放大，拖动、滚轮或方向按钮平移；100% 需终端报告字符格像素尺寸。
底部「打开原图」链接直接调用系统看图程序，打开未经重编码的原始附件，包括从历史会话恢复的图片。
大图弹窗用 `←`/`→` 或底部 `‹`/`›` 切换上一张、下一张，显示当前张数，首尾不循环；切图回到适应窗口。

  - **终端交互**：低资源占用，长会话稳定可靠；多种主题切换，样式美观，实时显示工作状态、TPS、缓存命中率等
    推理等级、输入/输出 token 与 Git/会话信息；终端卡多行命令可经 `/settings` 折叠为首行 + 计数提示（Ctrl+O 或点击卡片展开）；全屏模式下悬停在截断的工具卡标题、用户消息或会话标题上约 600ms，浮层显示完整内容。
    用户附图及助手/工具结果中的持久图片块会直接显示在会话记录中；Kitty graphics 或 Sixel 可用时显示等比缩略图，否则保留同尺寸文字回退。全屏下点击输入框 `[Image #N]` 或 transcript 缩略图在对话区域居中打开大图预览，卡片外的对话文字变暗，不遮挡输入栏（Esc/点击外部关闭），标题为 `Image #N — 格式 · 尺寸 · 体积 · 文件名`，本会话暂存的图片在卡片底行显示来源路径；Finder 复制的图片文件粘贴时直接入附件库为 `[Image #N]`；输入框里的 `[Image #N]` 是一个整体，光标整体跳过、删除整体生效，光标落在其上时整块反显并自动打开预览、离开时关闭。Vim 的 `x`/`X`/`d…` 同样整张删除，`u` 同时恢复文字与附件；撤销仅限当前草稿。
    终端图片预览默认开启，可在 `/settings → 终端图片预览` 或配置 `terminalImages: false` 中关闭，使用 `/restart` 后生效。已保存的 `/settings` 选择优先于 Cordis 配置；若曾保存为开启，请在 `/settings` 中关闭后再 `/restart`。关闭时保留文字信息并跳过预览解码，不影响向模型发送图片；`DSH_TUI_DISABLE_TERMINAL_IMAGES=1` 始终强制关闭预览。
  - **功能全面**：`/resume` 按工作目录分类浏览、搜索与预览历史会话（左键恢复、右键弹出操作菜单；可固定常用会话——「已固定」分组置顶显示，行内 ★ 或 `Ctrl+P` 切换，持久化到 `~/.dsh-tui`），另有 `/agentview` 会话总览（空输入 `←` 一键后台化，后台会话派发、预览、回复与停止一站式管理）、`/new`、`/compact`、`/export`、`/btw`，模型热切换（新会话默认推理强度可在 /settings → 默认推理强度 预设），原生subagent，会话fork，自动更新，输入框 `/vim` vim 编辑模式、鼠标选区编辑（拖选高亮、Shift+click 扩展、双击选词、Ctrl+C 复制选区）与全屏草稿编辑（`Ctrl+Shift+E` 或输入行 `⛶` 按钮：行号 + 当前行高亮、Enter 换行、Ctrl+Enter 发送、滚轮滚动、点击/拖选，长草稿独占整屏；`/settings` 可关）；可在vs code中[以vscode插件形式启动](docs/vscode.md)，已上架 VS Code Marketplace。
  - **IDE 选区通道**：搭配 VS Code 扩展启动时，编辑器选中代码后 prompt 下方实时显示 `⧉ N lines selected` 徽标，提交消息自动附加选中行内容（transcript 有「⧉ Selected N lines」指示行）；手动启动（tmux/SSH）通过 lock 自动发现本机 IDE，无 IDE 时静默降级零影响。详见 [vscode.md](docs/vscode.md)。
  - **扩展丰富**：原生浏览器交互，compter use等大量附属功能性扩展
  - **技能归 DSH 管理**：`/skills` 展示当前 profile、用户与项目发现的技能；dsh-TUI 不预装通用技能。
  - **工作状态动画**：默认使用 `moon8`；读取旧版本地配置中的 `claude` 值时自动映射为 `moon8`，选择器只显示当前预设。
  - **像素鲸鱼娘**：开屏随机三选一开场动画；欢迎期（开始第一个任务前）可**点击冒爱心并唤醒睡着的鲸鱼**，闲置时摆鱼鳍、拍尾巴、入睡冒 Z（`/settings → whaleIdle` 可关）。**开始第一个任务后永久定格为静态标准帧**，零持续开销。鲸鱼娘的 22 帧手绘原图与闲置行为移植自 [dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)（作者 [@lhh010](https://github.com/lhh010)），特此致谢。



## 界面预览

<div align="center">
  <table>
    <tr>
      <td align="center" valign="middle" width="50%">
        <img src="screenshots/splash.png" alt="首屏：像素鲸鱼顶栏" width="480">
        <br>
        <strong>首屏：像素鲸鱼顶栏</strong>
      </td>
    </tr>
  </table>
</div>


## 快速开始

前置条件：安装[Nodejs](https://nodejs.org/zh-cn)与[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，注册`DEEPSEEK_API_KEY`。

安装命令：

```sh
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
```

启动命令：

```bash
# 完整命令
dsh-tui
# 如果你不想按键盘七次
dst
```

如果你想手动安装，可以使用仓库根目录的 `install.sh`：

```sh
sh install.sh
# 或：dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
# 之后 dsh-tui 与 dsh --profile dsh-tui 等价
```

> **新用户提示**：若 `dsh plugin` 安装时报 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥11 默认阻止带安装脚本的依赖，如 `@google/genai`、`protobufjs`——这些脚本运行时不需要，忽略即可），在 profile 的 `pnpm-workspace.yaml` 里加入：
>
> ```yaml
> allowBuilds:
>   '@google/genai': false
>   protobufjs: false
> ```
>
> `/update` 与 `dsh-tui update` 会自动写入这份配置，无需手工处理。

更面向零基础的安装流程、profile 叠加机制、源码构建与常见问题见[安装与快速开始](docs/getting-started.md)。



## 插件扩展与开发指南

想为 dsh-TUI 做插件/扩展？欢迎加入生态！

- **接口与兼容性协定 / 插件开发指南**：[终端交互生态插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)（准入规范、接缝、契约、验证清单）
- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)（社区插件与模板的家）
- **模板仓库**：[plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)（从模板起步，5 分钟出一个插件）
- **参考实现**：`dsh-working-activity`（实时工作状态行：TUI 槽位 + `activity/status` 会话事件双出口）

### 接缝稳定性参考

按当前实现成熟度给出的**非正式**分级，帮助插件作者评估投入；正式状态与兼容性协定以
[准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)为准：

| 分级 | 接缝 |
| --- | --- |
| 稳定候选（形态冻结；如有破坏性变更，先在次版本弃用告警再移除） | 六 设置区块 · 八 全屏场景 · 十 托管对话框 · 十一 状态行 · 十二 键盘快捷键 · 十三 条目渲染器 |
| 实验性（仍可能随 dsh-std / 准入规范演进调整） | 九 决策事件 · toast 通知（`ctx.tuiToast`，新增） |
| 跟随上游（稳定性由 cordis / dsh 官方机制决定） | 一 会话事件 · 二 官方 prompt 槽位 · 三 技能打包 · 四 主题 · 五 system prompt 段 · 七 profile 组合 |

另：`@deepseek-harness-tui/dsh-tui/api`（纯类型入口）为实验性公开面。
`@deepseek-harness-tui/dsh-tui/test-utils` 公共子路径已移除——它包含可注入真实
activationId 的测试助手，不适合作为公共生产 API；需要 headless 测试请复制仓库内
`scripts/lib/plugin-test-utils.ts` 的思路，在自己的测试环境走正式准入流程。

公共面的导入迁移：
- **`ctx.tuiPluginHost.grants.corrupt` 已不存在**。新的 `HostGrantFacade` 只暴露
  `allows(pluginCtx, permission, scope)`、`defaultOf`、`knownPermissions` 和
  `onChange(pluginCtx, listener)`；损坏的 grant 文件不再通过一个布尔字段暴露给插件。
  `onChange` 是 subscribe 类托管能力：必须传入调用 activation，受 shadow 门禁约束，
  返回的取消函数绑定到该 activation，避免文件轮询/监听器泄漏。需要诊断时请使用
  `ctx.tuiPluginHost.selfCheck()`、`/doctor`，或通过显式诊断查询在宿主侧检查
  grant 文件状态。
- `createAdmissionCatalog` 不再从 `./plugin-host` 导出；诊断请使用
  `ctx.tuiPluginHost.selfCheck()` 与 `/doctor`。
- `ctx.tuiPluginHost.grants` 改为调用方安全的 `HostGrantFacade`：
  `grants.allows(pluginCtx, permission, scope)` 由宿主从当前 activation 推导身份，
  不再接受任意 `GrantPrincipal`/完整 `GrantStore`。
- `GrantStore`、`GrantPrincipal` 不再是公开导出的插件 API；它们保留在
  `src/adapter/standard/grants.ts` 作为宿主内部实现类型。需要构造/校验 grant
  文件的宿主方请走仓库内部路径，生态测试不要在公共包依赖这些类型。
- `@deepseek-harness-tui/dsh-tui/test-utils` 子路径已删除；仓库内的
  `scripts/lib/plugin-test-utils.ts` 仅用于本仓库无头验证，不属于公共契约。
  生态插件请在自己的测试环境通过正式 admission 流程复现。

### 平台已知边界（Shadow 门禁不承诺覆盖）

TUI 的 shadow/门禁只覆盖自有托管接缝；以下由 Cordis/上游 DSH 拥有的路径属于已写死的
平台边界，不会被门禁描述为全路径覆盖：

- 直接 `ctx.get('commands').register` / `ctx.get('commands').execute`（C-070）；
- `ctx.plugin()` / `candidate.plugin()` 子插件安装（Cordis 平台）；
- agent preset 名册 / recompose 注册（`@deepseek-ai/dsh-agent-presets`）；
- system prompt section 注册（`@deepseek-ai/dsh-system-prompt`）；
- skill registry 注册/调用（`@deepseek-ai/dsh-skill`）。

这些路径在 `verify-adapter-shadow` 中以 `platform-known boundary` 显式列出。
此外，`verify-adapter-shadow` 还显式记录两类门禁已知边界：未列入
`NON_SERVICE_POLICY` 的内部 TUI 状态/视图辅助类，以及 `src/screens`/
`src/components` 的 React UI 状态与事件处理——它们不是 adapter capability
入口，门禁不将其描述为已覆盖。


### Adapter live-probe 诚实性与 P2 边界

本轮把 `Command` / `LocalStorage` / `MessageObserver` 从“无实探的 staged”
推进到了“有可逆实探的 live”（在 legacy/new 模式下异步执行），并实现最小
`KernelRuntime` 与 passive/replay harness：

- **Command live probe**：在真实命令服务上临时注册唯一 no-op command，经
  `find` / `list` 验证可见，并以内存 fake agent session 执行一次，确认
  execute 返回 success；无论成功失败都在 `finally` 反注册。该操作不写任何
  DSH 持久化 session 日志，唯一瞬时副作用是进程内命令注册表的一次
  `commands/change` 通知。
- **LocalStorage live probe**：在真实 storage 目录下创建随机临时 namespace
  文件，完成 write/read/delete，并在 `finally` 删除；不触碰任何真实插件
  namespace，也不保留探针数据。
- **MessageObserver live probe**：通过 broker 的内部 probe-only 发布通道添加一个临时探针订阅并投递一条合成事件；真实插件的 `session:*` 通配订阅不会收到任何探针消息，探针结束后订阅数回到原值。这些 live probe 方法不是插件可见的公开 service 方法，宿主内核通过内部 host-only accessor 调用。
- **默认 legacy 兼容发布**：`DSH_TUI_ADAPTER_MODE` 默认是 `legacy`，不会加载新 Kernel、不会执行可逆 live probe。该模式保留旧发布语义，使用独立的 `buildLegacyHostDescriptor` 路径：只要 Command / LocalStorage / MessageObserver 的既有服务行已挂载，`describe()` / `hostDescriptor()` 就发布这些契约供插件准入使用；构建结果会在 warnings 中明确标注为 legacy 兼容声明，与新模式 live-only 的公开 descriptor 分离。
- **模式配置 fail-closed**：只有未设置 `DSH_TUI_ADAPTER_MODE` 时才默认 `legacy`；显式值只接受 `legacy` / `passive-shadow` / `replay-shadow` / `new`（忽略大小写与首尾空白），空值或未知值会报错并拒绝启动。非 legacy 模式在 Kernel 未就绪、refresh skipped/failed 或已释放时返回空契约 descriptor，不回退兼容发布。
- **Host probe 访问边界**：`host-probe-access` 内部的 token 是模块级不导出符号，普通包 exports 路径也拒绝 deep import。但插件与宿主同进程时，绝对路径加载内部文件仍无法被 `exports` 阻止——这是 **trusted-in-process 边界，不是安全沙箱**；宿主不会用“插件不可调用”这类无限定承诺。内部注册函数不会覆盖已引导的宿主 probe runner。
- **Passive Shadow**：不执行上述可逆 probe，只做只读 detect/descriptor 快照；
  **Replay Shadow**：生产环境不接真实 DSH，必须通过 `scripts/verify-adapter-replay-harness.ts`
  或 `src/adapter/kernel/replay.ts` 在隔离 replay context 上运行，否则 fail-closed
  并输出明确提示。
- Replay harness 用法：在隔离输入上运行
  `node --import tsx/esm scripts/verify-adapter-replay-harness.ts`（门禁脚本），
  或在代码中调用 `runReplayShadow({ schemaVersion: 'tui-adapter-replay/v1', ... })`
  获取 `{ kernelContracts, legacyContracts, missing, extra, lifecycles }` 对比报告。
  P5 起还支持真实 DSH session snapshot/transcript 的
  `runChannelReplay(...)` / `verify:adapter-channel-conformance`，走
  `tui.dsh/v1alpha1#Channel` 的 Provider/Consumer 与协议校验。
- 公开 Host Descriptor 仍然只发布带真实 probe evidence 的 live 生命周期；
  未完成 live refresh 或 passive/replay 下 `Command` / `LocalStorage` /
  `MessageObserver` 保持 staged/degraded，不伪造完整支持。`DecisionEvents`
  维持逐 feature probe + 真实 channel/dispatch 拓扑发布规则。
- P6 已彻底移除内部 `admissionCompat` 平行视图，并删除
  `src/plugin-spec/*` 与 `src/dsh-adapter/{grants,host-descriptor}.ts` compat
  shim。生产代码直接导入 `src/adapter/standard/*`；`verify:compat-removal`
  现在扫描 `src/`、`scripts/`、`bin/`、生成 `lib/`（存在时）与 package export
  图，`verify:package` 也会拒绝 npm tarball 中的旧 shim；仍保留的兼容别名
  （`ExtensionGrants`、`envelopeSchema`、`createAdmissionCatalog`、
  `facadeFromLegacy` 等）已明确标注为 P6 范围外/长期兼容面。
- 新 Kernel 不再是 P1 空壳：`KernelRuntime` 管理 driver 注册/mount、detection、
  `declared → staged → live`、清理与诊断快照；生产 Host Descriptor、`getHostFacade()`、
  `/doctor`、`/plugins` 均走该 runtime。
- **P3 feature-level live 拆分**：`Workspace` / `Scenes` / `Settings` /
  `Extensions` 不再用“注册+list+dispose”冒充整个能力 live。只有实际通过
  只读/可逆探针验证的方法才进入 live（如 `host.workspaces.list`、
  `host.workspaces.resolve`、`host.scenes.register`、`host.settings.register`、
  `host.status.set`、`host.command-trees.children` 等）；
  `host.toast.show` 因尚未验证真实生产 deliver 路径，保持 degraded；
  `rename` / `runCommand` / `commandShell` / `scenes.open` /
  `settings.subscribe` / 快捷键 dispatch / command-tree descriptions 等未验证
  方法保持 degraded/staged。`Presentation` 的交互 `ask` 已桥接到真实
  `QuestionStore`，`approve` 在 P3 明确 staged。
- **生产 P3 slices 接入**：非 `legacy` 的 `TuiPluginHostRuntime` 会把
  `ADAPTER_KERNEL_SLICES` 传入生产 `KernelRuntime`，进入 mount/refresh/
  descriptor 流程；依赖的服务未挂载时对应 slice 降级而不是崩溃。
  `DSH_TUI_ADAPTER_SLICES` 现在会按 slice id / capability / effect 矩阵过滤
  kernel slices，不再是无效果的死参数。
- **宿主初始化运行时快照**：所有 adapter/宿主服务（storage/message/plugin-host、
  P3 的 status/workspaces/scenes/settings/toast/dialogs/command-trees/questions/approvals
  等）都会在初始化时捕获不可变 `AdapterRuntimeOptions`。之后同一进程再修改
  `DSH_TUI_ADAPTER_MODE` / `DSH_TUI_ADAPTER_SLICES` 不能把 passive/replay 服务
  解锁成 `new`；能力入口不再每次读 `process.env`。
- **Slice 归属与边界**：`DSH_TUI_ADAPTER_SLICES` 现在会大小写/空白归一化、支持
  常见别名（如 `dialogs` → `presentation`、`decisions` → `decisions`），未知
  slice id 直接拒绝并 fail-closed。`toast` 不再被 `presentation` 隐式加载，
  `decisions` 不再被 `messages` 隐式加载。
- **P4 Channel Port/投影层（诚实表述）**：新增 `projection / actions / state /
  plugins / transcript` 五个 Host Port 与 `src/adapter/channel/*` 拆分模块，
  并由 `channel` KernelSlice 挂载到生产 HostFacade；**生产 `src/dsh-adapter/channel.ts`
  本体尚未物理拆分**，仍由 live Channel 作为实现来源，拆分模块是生产 driver
  实际消费的 Port/投影层；**T1 已做核心迁移：生产 `plugin.ts` 中的通知与初始提交
  已优先走 `HostFacade.channel.actions`；**非 shadow 模式下 facade 尚未 mount
  时可回退原生 Channel，passive/replay shadow 下禁止回退，缺失或拒绝时丢弃**；
  其余 UI/Channel 内部动作仍大部分直接调用原生 Channel，尚未完整迁移。
  `HostFacade` 按方法做 shadow 守卫，passive/replay 下只读投影可用、变更动作被拒。
- **P5 Channel Provider/Consumer**：新增本地 Channel Provider/Consumer，
  实现 `tui.dsh/v1alpha1#Channel` 的 open/subscribe/invoke/close 协议包络与
  规范校验；`runChannelReplay` 支持录制 snapshot 数组，也支持把真实 DSH
  `agent.session.events` 形状事件投影为单调 `TuiChannelSnapshot`。该投影定位为
  **minimal transcript replay**：覆盖 transcript/status/基础 session 字段，
  并在调用方提供元数据时带入 model/mode/preset/settings/scene/diagnostic/trace/
  context/pending/usage 等 RFC 相关字段；仍**不声明是完整 RFC 0007 Channel
  state/conformance**。未知方法按协议失败、
  features 必须显式声明且每个 feature 必须有 state/method 可观察证据、
  重复 features 先拒绝、未知非 ignorable DSH event fail-closed、
  method handler 只能在 replay isolation 内执行、replay provider 不解析
  workspace/sessionId selector（显式 unsupported）；连续性错误 fail-closed。
- **P3 feature 生命周期稳定性**：`refresh` 之后执行 `mount()` / `descriptorBuild()` /
  `diagnosticSnapshot()` 再次触发同步 `detect()`，也不会清空已探测的 P3 feature；
  这些 feature 是内部 Kernel/Port 事实，不进入公开 Host Descriptor。
- **Settings section live 诚实性**：`host.settings.section` 的 live 依据是探针中
  真实调用 `section()` 解析临时 namespace；解析缺失/失败时该 feature 降级，不再
  仅凭 register/list 就标 live。
- **Host Port 逐方法 shadow guard**：`KernelRuntime.facade()` 返回的每个
  Port 方法都会先执行统一 effect-class 检查。passive/replay 生产模式下
  `rename`、`runCommand`、`commandShell`、`scenes.open`、`settings.subscribe`、
  各类 `register` 等会被拒绝；只读方法仍可用于诊断。
- **Toast live probe** 使用独立 probe-only sink 管道，不替换/不吞并发生产
  toast；**Status live probe** 在 `clearIf` 失败或残留时降级，不会标 live。
- `verify:adapter-slices` / `verify:adapter-detection` 现在同时检查生产
  plugin-host 确实传递 `ADAPTER_KERNEL_SLICES`，避免门禁只测直接 new
  KernelRuntime 的自证。



## 文档索引

| 主题 | 内容 |
| --- | --- |
| [安装与快速开始](docs/getting-started.md) | 前置条件、安装、启动、profile 生命周期、源码开发 |
| [配置参考](docs/configuration.md) | Cordis 覆盖、配置字段、Agent preset、MCP、环境变量 |
| [主题系统](docs/themes.md) | 内置主题、自动检测、静态 JSON 与 npm 插件主题、校验规则 |
| [交互与命令](docs/interaction.md) | 快捷键、鼠标、问卷、slash command 与会话工作流 |
| [架构与限制](docs/architecture.md) | 运行链路、渲染与持久化设计、安全边界、已知限制 |
| [社区管理框架](docs/community-management.md) | 社区入口、角色、提案流程、roadmap 规则与维护节奏 |
| [项目路线图](docs/roadmap.md) | 公开目标、阶段、任务状态、退出条件与 Future Work |
| [VS Code 使用指南](docs/vscode.md) | 在 VS Code 集成终端运行 dsh-tui；companion 扩展 `dsh-tui-vscode` 提供多会话、会话历史与指定会话恢复（已上架 Marketplace） |
| [贡献与开发约定](docs/contributing.md) | 贡献流程、仓库地图、构建产物、验证矩阵与修改规则 |
| [插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | 接口与兼容性协定 / 插件准入规范 / 插件接缝 / 契约 / 验证清单（已并入 dsh-ecosystem-spec） |

完整的中英文索引见 [`docs/README.md`](docs/README.md)。



## 社区

- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) —— 社区插件、模板与收录列表的家。欢迎来发插件、提创意、互相取暖 🐋
- **社区交流群**：使用问题、插件创意、功能许愿，都欢迎进来聊。
- **行为准则**：参与前请读一遍[贡献者行为准则](CODE_OF_CONDUCT.md)。

| 微信群（dsh-TUI 社区交流 4 群） | QQ 群（群号 572549239） |
| :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="dsh-TUI 社区交流 4 群微信群二维码" width="200"> | <img src="screenshots/qq-group.png" alt="dsh-TUI 社区交流群 QQ 群二维码" width="200"> |

> 微信群二维码约 7 天过期一次，如遇失效请走 QQ 群（572549239），或开个 issue 提醒我们更新。

## 权限与安全边界

> **Windows 安全警告：** Windows profile 默认使用 `danger-full-access`，且 approval 默认是 `never`。这会授予工具不受限制的访问权限；在敏感凭证或不可信仓库环境中启动前，务必先检查并收紧 profile 配置。

`dsh-TUI` 不实现独立沙箱，而是使用当前 DSH profile 的文件、Shell、sandbox 与 approval 策略。权限预设来自 DSH `permissionPresets` registry：服务缺失时使用 legacy 三项兼容名册；服务已挂载但为空、损坏或不一致时标记为 unavailable，TUI fail closed，不伪造名册。可用 registry 按声明顺序提供第三方预设并自动进入补全、picker 与 `Shift+Tab` 循环（排除 `custom`/`status`、canonical 预设、重复 identity 与不安全 token）；首次观察遵循 registry 顺序，后续刷新保留已见 identity 的相对顺序。服务可用时 `/permission` 以本地命令形式常驻菜单：切换优先调用官方 `/permission <preset>` 命令；命令行未暴露给本 agent 时，回退到 permissionPresets 服务自身的官方写路径（与命令 handler 同一实现，写真实 `permission/preset`/`sandbox/mode`/`approval/policy` 事件，绝不由 TUI 伪造），并以事件/读回确认；两条路都不可用时显式提示，绝不静默。计划模式退出先恢复进入前的 atom，再把权限身份还原到你进入前所在的预设（registry 仍提供时）。在包含敏感凭证或不可信仓库的环境中启动前，请先检查 profile 配置。

详见[权限边界与已知限制](docs/architecture.md#权限与安全边界)。

### 致谢

- 像素鲸鱼娘的 22 帧手绘原图（Excel 逐格绘制）与闲置动画行为（摆鱼鳍、拍尾巴、入睡冒 Z、点击冒爱心）移植自 **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)**（DeepSeek Harness Web 端鲸鱼宠物插件，作者 [@lhh010](https://github.com/lhh010)，BSD-3-Clause），感谢作者与灵感 🐋💜

### 友情链接

朋友们开发的[社区、相关项目与周边工具](docs/links.md)

## Stars

<!-- star-history:start -->
[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)
<!-- star-history:end -->


## License

[MIT](LICENSE)
