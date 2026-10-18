# dsh-TUI 适配 DSH Auto review 权限预设：评估与 issue 正文

- 日期：2026-10-13
- 状态：设计稿 + issue 正文（#1544，2026-10-15 修订）+ 实施方案（§5）；已在 `feat/auto-review-preset-adaptation` 实现（§5 已按实现更新）
- 关联：`ccch1mneyyy/dsh-TUI` #1544（已开）
- 上游（核对版本线，非引入版本）：`@deepseek-ai/dsh-experimental-auto-review@0.2.0-rc.2`、`@deepseek-ai/dsh-permission-presets@0.2.0-rc.2`；`0.2.1-rc.2` 复核对齐：`AUTO_PRESET_SPEC`（danger-full-access + ask）、`optionOf('auto')` 仍为裸名、`displayReason` en/zh、`AUTO_REVIEW_DENIED` 的 `reason`、卸载时 `set(session, 'danger-full-access')`、`permission-presets/catalog-changed` 均不变。
- 范围：`src/dsh-adapter/channel/`（`mode-roster.ts`、`permissions.ts`、`mode-permission-actions.ts`、`command-completions.ts`、`extensions.ts`、`transcript.ts`）、`src/dsh-adapter/approvals.ts`、`src/dsh-adapter/subagents.ts`、`src/components/PermissionsPicker.tsx`、`src/screens/Chat.tsx`、`src/sessionModes.ts`、`src/i18n.ts`

---

## 0. 背景

实验性插件 `@deepseek-ai/dsh-experimental-auto-review` 于 0.1.6-alpha.1
（2026-09-15）首发，此时需显式安装；自 0.1.7-rc.2（2026-09-24）起随 dsh 安装
分发但默认关闭。本文按 0.2.0-rc.2 版本线核对（插件列表标题「自动授权审查」）。
TUI 的 `/plugin list` 会列出它并提供 `/plugin enable @deepseek-ai/dsh-experimental-auto-review` 的开启路径。
它不是一个独立的审批策略，而是把
`sandbox=danger-full-access` + `approval=ask` 捆成一个**当前会话专属**的命名权限
预设 `auto`，由当前模型在每次工具调用前做一次授权审查。

上游 issue 列表中没有一条跟踪「Auto review 权限预设」的 TUI 适配（按「授权审查 /
自动审查 / auto-review / experimental-auto」检索零命中同主题条目），本文即为此
缺口撰写的评估，正文已提交为 #1544。

## 1. 上游行为（已逐条核实）

- 承载方：`@deepseek-ai/dsh-permission-presets`。`custom`（派生的非预设态）与
  `auto` 是保留名，写进配置表会抛错（`lib/index.js:175-176`）。
- 固定 bundle：`AUTO_PRESET_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }`
  （`lib/index.js:58`）。`ask` 把审查拒绝路由给用户；`never` 下拒绝即终局
  （in-process 子代理钉 `never`）。
- 可见性：`get names(): readonly string[]` = 配置项按声明序 + Auto（integration
  live 时，`lib/index.js:239`）；`optionOf(name)` 支持「已配置项 / live `auto` /
  `custom`」；`resolve(name)` 返回其 knob bundle。
- 变更通知：`permission-presets/catalog-changed(): void`，payload-free，消费者先
  订阅再重读完整 catalog（`lib/typert.host.js:660-662`）。
- 注册 API：`registerAuto(admit: () => void): () => Promise<void>`——重复注册抛
  `permission: preset "auto" is already registered`，返回的 disposer 移除 Auto。
- 审查范围：每个 native 调用 + 每个已启动的 PTC `tools.*` inner call 在执行 body
  前审一次；外层 `run_code` 传输刻意排除。
- 风险分级：low（项目本地普通工作、本会话创建对象的精确清理）→允许；medium
  （不可逆删除既有对象、生产操作、外部写入、安全变更）→需当前人类或直接父级明确
  授权；high（跨信任边界敏感外泄）→永远拒绝；模糊/效果冲突→拒绝。审查失败或畸形
  响应 fail-closed，绝不执行。
- 入口与默认：composer 或 `/permission` picker 中带 `EXP` 上标的 `Auto review`，
  需确认当前会话风险对话框；`/permission auto` 直接切；General settings 与
  未来会话默认不提供 Auto，Auto 不能成为 default。
- 拒绝呈现：走普通工具卡，折叠行标识 Auto review，展开显示「body 未执行」+ 可选
  reason（durable structured error detail，不进主模型内容）。reason 呈现由 Web 的
  `client/ui-tool` 拥有。
- 代价：每次调用额外一次模型请求（无缓存/重试/截断）；Auto 无文件沙箱。
- 卸载：把 live Auto Session 迁到 Full access。

## 2. TUI 现状与适配缺口

基础可用性大概率已经通：Shift+Tab roster 与 `/permission` 走
`readRuntimePermissionSnapshot`（`src/dsh-adapter/channel/mode-roster.ts`）→
`permissionPresetSnapshotFromService`（`src/dsh-adapter/channel/permissions.ts`），
后者用 registry `names` + `optionOf` + `current` 组 roster，只把 `custom` 判为
不可用，因此 `auto` 会自然出现在列表里。真正的缺口（2026-10-15 按 0.2.0-rc.2 源码复核，
B/E 已修正、F 为新增，详见 §5.0）：

| # | 缺口 | 定位 |
| --- | --- | --- |
| A | 未订阅 `permission-presets/catalog-changed`；roster 只在 `commands/change`、绑定与 `permission/preset` 事件时重建，Auto 的 live 注册/移除不会即时刷新 | `src/dsh-adapter/channel/extensions.ts`（全仓 `src/` 无该串） |
| B | `optionOf('auto')` 只返回裸 `auto`、无描述（「自动授权审查」是插件 `meta.title`，不是 preset 元数据）；TUI 只本地化三个内置值，Picker、补全与 Shift+Tab 指示器都显示裸 `auto` | `src/components/PermissionsPicker.tsx`、`src/dsh-adapter/channel/command-completions.ts`、`src/sessionModes.ts`（`permissionModeSpec`） |
| C | 选择 Auto 前无风险提示、无 `EXP` 标记；Shift+Tab 可无确认循环进 Auto | `src/components/PermissionsPicker.tsx`、`src/screens/Chat.tsx`、`mode-permission-actions.ts`（`cycleMode`） |
| D | `persistPermissionPref` 只跳过 `undefined`/`custom`，会把 `auto` 记成下一会话偏好；`applyRememberedPermission` 在 Auto live 时放行旧偏好里的 `auto` | `src/dsh-adapter/channel/mode-permission-actions.ts` |
| E | 拒绝呈现大部分已通，只缺：审批面板丢弃 `displayReason`；`toolErrorText` 不显示 `error.reason`；子代理卡 `String(data.error)` 显示 `[object Object]` | `src/dsh-adapter/approvals.ts`（`park()`）、`src/dsh-adapter/channel/transcript.ts`、`src/dsh-adapter/subagents.ts:384` |
| F | 插件卸载时上游把 Auto 会话迁到 `danger-full-access`，迁移事件经 `onSessionEvent` 被学成偏好，下一新会话以无审批 Full access 启动 | `src/dsh-adapter/channel/mode-permission-actions.ts`（`onSessionEvent`） |

## 3. Issue 正文（#1544，2026-10-15 按 §5.0 修订）

正文按段落整行书写、不做硬折行：GitHub 把段内换行渲染成空格，硬折行会在中文
折行处留下多余空格。以下代码块与 #1544 线上正文逐字一致。

```markdown
## 背景

实验性插件 `@deepseek-ai/dsh-experimental-auto-review` 于 0.1.6-alpha.1（2026-09-15）首发，自 0.1.7-rc.2（2026-09-24）起随 dsh 安装分发但默认关闭（插件列表标题「自动授权审查」）。它由 `dsh-permission-presets` 承载，把 `sandbox=danger-full-access` + `approval=ask`（`AUTO_PRESET_SPEC`）捆成一个 **当前会话专属**的命名权限预设 `auto`：每个 native 调用和每个已启动的 PTC `tools.*` inner call 在执行 body 前由当前模型审一次（外层 `run_code` 传输刻意排除）。风险分级 low→允许 / medium→需当前人类或直接父级明确授权 / high→永远拒绝，模糊或效果冲突→拒绝。选 Auto 会把 approval policy 设为 `ask`，被拒调用转为审批请求问用户（附本地化 `displayReason`）；in-process 子代理钉 `never`，拒绝终局，落成带 `AUTO_REVIEW_DENIED` 结构化详情的工具错误。插件随 dsh 安装但默认关闭，需从 Web Plugins 页开启或显式 `dsh plugin --profile web add`。

TUI 目前能读到 registry 的 roster（Auto 会出现在 Shift+Tab / `/permission`），但对 Auto 的实时变更、本地化、风险确认、偏好记忆与拒绝呈现均未适配。

## 现状（代码定位，按 0.2.0-rc.2 源码核对）

- roster 读取：`src/dsh-adapter/channel/mode-roster.ts` 的 `readRuntimePermissionSnapshot`（仅 `availability==='runtime'` 返回）→ `src/dsh-adapter/channel/permissions.ts` 的 `permissionPresetSnapshotFromService`（用 registry `names` + `optionOf` + `current`，仅把 `custom` 判为不可用，`auto` 会通过）。
- 刷新：roster 只在 `commands/change`、绑定与 `permission/preset` 事件时重建；全仓无 `permission-presets/catalog-changed` 订阅，Auto 注册/移除不触发 Shift+Tab 重建。
- 显示名：`optionOf('auto')` 返回 `{ value: 'auto', name: 'auto' }`，无 description（`AUTO_PRESET_SPEC` 不带标签；「自动授权审查」是插件 locale 的 `meta.title`，不是 preset 元数据）。`src/components/PermissionsPicker.tsx` 与 `src/dsh-adapter/channel/command-completions.ts` 只本地化三个内置值，`permissionModeSpec` 直接用 `option.name` 作 Shift+Tab 标签，故 Auto 处处显示裸 `auto`。
- 切换/记忆：`src/dsh-adapter/channel/mode-permission-actions.ts` 的 `persistPermissionPref` 只跳过 `undefined`/`custom`，会把 `auto` 记成下一会话偏好；`applyRememberedPermission` 在 Auto live 时会放行旧偏好里的 `auto`。插件卸载时上游把 Auto 会话迁到 `danger-full-access`，这条迁移事件经 `onSessionEvent` 被学成偏好，下一新会话以无审批的 Full access 启动。
- 审批面板：`src/dsh-adapter/approvals.ts` 的 `park()` 只取 `req.reason`（英文审计串），丢弃 `displayReason`。
- 工具卡：`src/dsh-adapter/channel/transcript.ts` 的 `toolErrorText` 已显示 `AutoReviewDeniedError: AUTO_REVIEW_DENIED` 与「body 未执行」，但不显示 `error.reason`；`src/dsh-adapter/subagents.ts` 对同一对象 `String(data.error)`，子代理卡显示 `[object Object]`。

## 目标

- 订阅 `permission-presets/catalog-changed`（payload-free；收到即重读 catalog），重建 roster 并重绘，让 Auto 的 live 注册/移除在 Shift+Tab、`/permission` 与补全里即时反映；打开中的 `/permission` picker 随之刷新。
- TUI 自持 `auto` 的标签与描述（zh「自动授权审查」/ en「Auto review」），Picker、补全、Shift+Tab 指示器统一经一个后端中立的标签辅助取值。
- `/permission` picker 中 Auto 带 `EXP` 标记，选中后先出当前会话风险确认（仅当前会话、无文件沙箱、每次调用额外一次模型请求、medium 需确认、high 永远拒绝），取消不改权限。手打 `/permission auto` 与 Web 一致直接切换。
- Shift+Tab：Auto 留在 roster（保证会话已在 Auto 时指示器正确），但只有当前会话日志中出现过切到 `auto` 的记录（picker 确认、手打命令或 resume 曾在 Auto 的会话）才参与循环；新会话重新要求经 picker 确认。
- Auto 不被记为下一会话偏好：`persistPermissionPref` 跳过 `auto`；旧偏好中的 `auto` 不 seed 新会话；从 Auto 切走的身份变更只有 TUI 自己发起时才学习，插件卸载迁移不改写偏好。
- 审批面板按当前语言优先显示 `displayReason`，回落 `reason`；工具卡与子代理卡显示 Auto 终局拒绝的 `reason` 并本地化提示，修掉 `[object Object]`。
- 双语文档同步。

## 非目标

- 不改 DSH 内核、`dsh-experimental-auto-review`、`dsh-permission-presets` 或审批通道；不实现审查策略本身。
- 不改阻塞/其它权限预设（read-only / workspace-write / danger-full-access）的既有行为。
- 不把 Auto 加进 General settings 或新会话默认（其契约明确禁止）。
- 不在 Shift+Tab 上弹确认框；不拦截手打 `/permission auto`；不改工具卡渲染组件与 `src/channel/projection.ts`。

## 验收

- profile 内 enable/remove Auto layer 后，Shift+Tab、`/permission`、`/permission` 补全三者均即时反映，无需重启或切会话。
- zh 界面下 picker、补全与 Shift+Tab 指示器均显示「自动授权审查」及其描述，不退化为裸 `auto`。
- picker 选 Auto 出现风险确认；取消不改动权限。
- 未确认过的会话 Shift+Tab 跳过 Auto；确认后可循环到 Auto；新会话重新跳过；会话在 Auto 时可循环离开。
- 切换到 Auto 后，下一新会话不被记为 Auto；旧偏好文件中的 `auto` 不生效；Auto 会话存活时卸载插件，偏好保持原值；从 Auto 经 picker 切到其它预设，偏好照常更新。
- 主会话审查拒绝的审批面板在 zh 下显示中文原因；子代理 Auto 终局拒绝的工具卡显示「未执行」+ reason，不出现 `[object Object]`。
- 默认关闭时，TUI 行为与现状完全一致。

## 参考 / 相关 API（@deepseek-ai/dsh-permission-presets@0.2.0-rc.2）

- `get names(): readonly string[]`、`optionOf(name): PresetOption`（`auto` 无 name/description）、`resolve(name): PresetSpec`、`set(session, name): void`、`@Remote('catalog') catalog()`、`registerAuto(admit): () => Promise<void>`。
- 事件 `permission-presets/catalog-changed(): void`（payload-free）。
- 保留名 `custom` / `auto`。
- auto-review 拒绝形状：`ask` 路径 `{ kind: 'ask', reason, displayReason: { en, zh } }`；`never` 路径 `{ kind: 'deny', reason, info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason? } }`；卸载时把 Auto 会话 `set` 到 `danger-full-access`。
- 既有相近项：#864（第三方 preset 接入）、#1212（审批条被裁出屏）。
- 实施方案：`docs/auto-review-preset-adaptation.md` §5。
```

## 4. 事实核查来源

- 版本时间线（npm 发布数据）：首发 0.1.6-alpha.1（2026-09-15，需显式安装、
  拒绝即终局）；0.1.7-rc.2（2026-09-24）起被 `@deepseek-ai/dsh` 列为依赖、
  随装默认关闭，并补 `locale/`、`icon.svg`，拒绝改走 `ask` 审批路由；
  0.2.0-rc.2 与 0.2.0-rc.1 的 `lib/index.js`（均 24039 字节）、README、
  locale 逐字相同。更早源头为决策记录 2026-08-28-auto-review。
- 重复检查：`gh issue list -R ccch1mneyyy/dsh-TUI --state all --search
  "授权审查 OR 自动审查 OR auto-review OR experimental-auto"` 零命中同主题条目；
  相近项 #864（registry receiver 绑定，已关闭）、#1212（审批条被裁出屏，OPEN）。
- 插件 tarball：`package.json`（名/版本）、`locale/zh.json`（标题与描述、
  逐字一致）、`cordis.patch.yml`（单行 `id: auto-review`）、
  `lib/types/index.d.ts`（`name`/`inject`/`apply`）、`README.md`。
- 预设服务：`@deepseek-ai/dsh-permission-presets@0.2.0-rc.2` 的
  `lib/index.js`（`AUTO_PRESET_SPEC`、`names` getter、保留名断言、
  `registerAuto`）与 `lib/typert.host.js`（方法签名与 `catalog-changed` emit）。
- TUI 缺口：`src/` 全仓 grep（`catalog-changed` 零命中）与逐个文件逐行核对。
- 上游 issue：按「授权审查 / 自动审查 / auto review / experimental-auto」检索标题
  与正文，零命中同主题条目。

## 5. 实施方案

按已装 `dsh` 0.2.0-rc.2 的上游源码重新核对后，§2 的两条前提需要先修正，方案按修正后的缺口展开。

### 5.0 对 §2 / #1544 的修正

- **B 的前提不成立**：`optionOf('auto')` 返回 `{ value: 'auto', name: spec.name ?? name }`，而 `AUTO_PRESET_SPEC` 只有 `sandbox/approval`，因此 registry 给出的就是裸 `auto`、无 description。「自动授权审查」是插件 `locale/zh.json` 的 `meta.title`（插件列表标题），不是 preset option 元数据。结论：TUI 像对三个内置名一样自持 `auto` 的标签与描述；#1544「从 registry `optionOf` 元数据取标题」一条应改为「TUI 自持 `auto` 的 i18n」。
- **E 大部分已通，收窄为两个小缺口**：
  - 主会话 Auto 的 approval 是 `ask`，审查拒绝走 `askUser()` → 审批面板，请求带本地化的 `displayReason: { en, zh }`；`approvals.ts` 的 `park()` 只拷 `req.reason`（英文审计串 `Auto review denied tool "X": …`），丢了 `displayReason`。
  - 终局拒绝（`overrideOf === 'never'`，即 in-process 子代理）落成 `tool/result.error = { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason? }`。`transcript.ts` 的 `toolErrorText` 已渲染 `name: code — Error: Auto review rejected tool "X"; its body was not executed`，只漏了 `reason`；`subagents.ts:384` 对同一对象做 `String(data.error)`，子代理卡会显示 `[object Object]`（既有缺陷，Auto 终局拒绝恰好最常出现在子代理）。
- **新增 F（插件卸载时的自动迁移被误记成偏好）**：例：用户的记忆偏好是 workspace-write；本会话切到 Auto（D 修好后不写偏好，仍是 workspace-write）；随后在 Web 插件页关掉 auto-review。上游卸载时会把所有仍在 Auto 的会话自动 `set(session, 'danger-full-access')`。这条迁移写出的 `permission/preset` 事件被 TUI 的 `onSessionEvent` 当成「用户切换了预设」，于是把偏好改写成 danger-full-access（全权限、无审批）。下一次开新会话就直接以无审批的 Full access 启动——用户从没主动选过它当默认，比原偏好宽得多。触发面窄（Auto 会话存活期间卸载插件），但后果是静默放宽权限。

### 5.1 改动面（按依赖顺序，可拆 2–3 个 PR）

**PR 1：数据面（A + B + D + F）**

1. **共享常量与标签辅助（B）**
   - 新文件 `src/permissionPresetLabels.ts`（后端中立，只 import `i18n`，UI 可直接 import，过 `verify:boundary`）：`PERMISSION_PRESET_AUTO = 'auto'` 与 `permissionPresetLabel(option)` / `permissionPresetDescription(option)`，三个内置名 + `auto` 映射到 i18n key，其余回落 `option.name` / `option.description ?? option.name`。`auto` 只在 `option.name === 'auto'`（registry 未给标签）时本地化。
   - 收敛到该辅助：`PermissionsPicker.tsx` 的三元链、`command-completions.ts` 的 `descriptionKey` 三元链；Shift+Tab 指示器在 `modeDisplayName` 渲染时取本地化名（`/lang` 即时生效），`permissionModeSpec` 的 `label` 仍是 registry 原名。
   - `src/i18n.ts` 新增：`permission-preset-auto`（zh「自动授权审查」/ en「Auto review」）、`permission-preset-auto-desc`（zh「模型在每次工具调用前审查授权；无文件沙箱，仅当前会话」/ en 对应）、`permission-preset-exp-tag`（`EXP`）。
2. **catalog-changed 订阅（A）**
   - `src/dsh-adapter/channel/extensions.ts:767`，与 `commands/change` 同一 `owner.own(ctx.on(...))` 漏斗：
     `ctx.on('permission-presets/catalog-changed' as never, (() => { if (!owner.current()) return; modeActions.refreshMode(); state.emit() }) as never)`。
     事件名不在本包已声明的 Events 里，沿用 `host-dsh.ts:302` 的 `as never` 写法，不新增 peer/dev 依赖（避免 `verify:manifest-deps` / contract 连锁）。payload-free，监听里只重读，不读参数。
   - `refreshMode()` 本身不 emit；roster 成员变化即使 `modeIndex` 不变也要重绘指示器/提示，因此无条件 `state.emit()`。
   - 打开中的 `/permission` overlay 持有 `clonePermissionPresetSnapshot` 副本：Chat 侧在 channel 的 emit 后若 overlay 为 `permission` 且 live 名册的 value 集合变化，就用新快照重开（保持焦点 value，找不到回落 current）。确认阶段（见 PR 2）中 `auto` 消失则直接关闭确认并提示。
3. **不记忆 Auto（D + F）**，全部收在 `mode-permission-actions.ts`：
   - `persistPermissionPref`：`value === PERMISSION_PRESET_AUTO` 时跳过（唯一写入点，三处调用都经它）。
   - F：`onSessionEvent` 的观察者路径在「上一个身份是 `auto`」时只学 TUI 发起的切换。picker 与手打 `/permission` 走 external 命令而非 `modeActions`，因此 `extensions.ts` 把 `runExternalCommand(Outcome)('permission', …)` 与 `runPermissionPreset` 包进 `trackUserPermissionSwitch`（登记切换目标），新身份正是某个进行中的目标时才学习「离开 auto」，与进行中切换竞态的卸载迁移不会被学到；静态模式切换仍在 `applyMode` 内显式持久化。上游卸载迁移发生在 `auto` 仍注册时，不能靠 names 判断。
   - `permissionBundlesFromService` 跳过 `auto`：否则配置了 `danger-full-access + ask` 静态模式时，Shift+Tab 会把它 canonicalize 成 `auto`，绕过确认。
   - `applyRememberedPermission`：`pref === PERMISSION_PRESET_AUTO` 时视同不可用（旧版本已写进偏好文件的 `auto` 不得把新会话悄悄 seed 成 Auto；Auto live 时 roster 校验会放行它，所以必须显式拦）。

**PR 2：交互面（C）**

4. **Shift+Tab：本会话确认过才进循环**
   - `auto` 始终留在 roster（会话已在 Auto 时，`derivePermissionModeIndex` 靠身份项才能显示正确指示器，删掉会掉进 atom 匹配错显为 Full access）。
   - 是否进入循环按**当前会话**判定：会话日志里出现过 `permission/preset { preset: 'auto' }` 即视为已确认（picker 确认、手打 `/permission auto`、resume 一个曾在 Auto 的会话，都会留下这条事件）。未确认的会话 Shift+Tab 跳过 Auto；确认过之后 Auto 与其它项一样参与循环。
   - 判定直接 fold 持久化日志（`snapshotLiveSessionEvents`），不另存 TUI 状态：随 `/resume`、`/new`、切会话自然正确，新会话重新要求确认，与上游「风险确认针对当前会话」一致。
   - 实现：`cycleMode` 的 `(index + 1) % length` 改为向后找第一个可循环项，`auto` 项在未确认时不可循环；从 Auto 出发正常前进。roster 结构不变，不给 `SessionModeSpec` 加字段。
   - 理由：`cycleMode` 是不能 await 的键盘入口，不适合插确认框；首次启用必须走 picker（或手打命令），之后可以像其它模式一样快速切换。
5. **picker 二阶段确认 + EXP**
   - `PermissionsPicker` 的 option 行对 `auto` 追加 `EXP` 上标（`Select` 的 `label` 是 `ReactNode`，用 dim/`warning` 色 `Text` 拼接即可，宽度走现有组件）。
   - Chat 的 `overlay.kind === 'permission'` 加状态 `confirm?: boolean`：Enter 选中 `auto`（且当前不是 `auto`）时进入确认态而非直接 `runPermissionCommand`；确认态渲染风险说明 + 「确认 / 取消」，Enter 确认后才 `runPermissionCommand(' auto')`，Esc 回到列表、不改权限。复用 `migrate-confirm` / `kind: 'confirm'` 的既有按键与 `Pane` 样式，不另造对话框组件。
   - 风险文案（i18n，zh/en 各一）要点：仅当前会话、不会成为新会话默认；无文件沙箱；每次工具调用额外一次模型请求；审查放行（low，或已明确授权的 medium）直接执行；被拒调用（含 high）在主会话转为审批由用户决定、在子代理中终局拒绝；审查失败即不执行。
   - 手打 `/permission auto`：走 `mounted` 分支直达上游 handler，与 Web 一致不拦截，文档写明。
   - 补全：`/permission` 补全对 `auto` 的 description 加 `EXP` 前缀即可，不做确认。

**PR 3：呈现面（E）**

6. `src/dsh-adapter/approvals.ts` `park()`：结构化读 `(req as { displayReason?: unknown }).displayReason`，若为 record 且取到 `getLang()` 键或 `en` 键的字符串，就以它作 `snapshot.reason`（经 `cleanRenderText` 限宽），否则回落 `req.reason`。不改 `ApprovalRequest` 的 import 版本线（低版本无该字段，结构化读保证兼容）；`external` 判定不受影响。
7. `src/dsh-adapter/channel/transcript.ts` `toolErrorText`：`failure.reason` 为非空字符串时追加一行（`— reason`）；对 `code === 'AUTO_REVIEW_DENIED'` 用本地化前缀（zh「自动授权审查拒绝，未执行」）替换 `name: code` 身份串。live 与 replay 都经此函数（`backend/translate.ts:323`、`subagent-transcript.ts:323`），一处覆盖。
8. `src/dsh-adapter/subagents.ts:384`：`String(data.error)` 改为复用同一格式化（对象取 `name/code/reason`），修掉 `[object Object]`。

**文档**：`README.md` / `README_ZH.md` 同步「picker 选 Auto 需确认、Shift+Tab 仅在本会话确认过 Auto 后才循环到它、`/permission auto` 直切、Auto 不被记为下一会话偏好」；本文 §2 表格按 5.0 改 B/E、加 F；给 #1544 准备修订文本（只出草稿，不直接 `gh issue edit`）。

### 5.2 不做的事

- 不在 Shift+Tab 上弹确认；不拦截手打 `/permission auto`。
- 不读 `catalog()` 判「会话专属」：`ui-policy` 下 `permissionPresets` 为 read-only，且固定名 `auto` 是上游保留名，常量足够；若上游以后出现第二个会话专属预设再改为读 `catalog().defaultOptions`。
- 不改工具卡渲染组件与 `projection.ts`；不做审查结果的独立 UI。

### 5.3 验证

- 聚焦脚本（先 `pnpm build`）：`scripts/verify-permission-prefs.mjs`（选 Auto 不写偏好；旧偏好 `auto` 不 seed；卸载迁移到 `danger-full-access` 不被学习；进行中的外部 `/permission` 切换期间迁移不被学习；从 Auto 经外部命令切走被学习；catalog-changed 后名册刷新；traceable 服务下快照缓存命中；已登记 `run-ci-group` 的 `channel-ui`）、`verify-permission-modes.mjs`（夹具把通用 `auto` 改名 `balanced`）、`verify-launchpad-onboarding-chat.tsx`（J4 picker 确认/取消）。`verify-permission-roster.mjs` 与 `verify-shift-tab-mode.mjs` 的既有无 auto 用例仍通过；Shift+Tab 的 auto 规则由 permission-prefs 的 cycleMode 用例覆盖。
- `toolErrorText` / 子代理：在现有 transcript 回归里加 `AUTO_REVIEW_DENIED` 带/不带 `reason` 两例。
- 改了 `Chat.tsx` overlay 与 picker → 跑 CI 回归；`pnpm verify:build`（boundary、contract、terminal-size-source）。
- 手动：装有 dsh 0.2.0-rc.2 的环境 `dsh plugin --profile web add` 开启 auto-review，inline 与 fullscreen、窄终端下演练 picker 确认/取消、Shift+Tab、启停插件时 roster 即时变化、一次被审查拒绝的工具调用（主会话审批面板 + 子代理工具卡）。
- 默认关闭时回归：上述脚本的既有用例全部不变（Auto 不在 names 中时所有新分支不触发）。
