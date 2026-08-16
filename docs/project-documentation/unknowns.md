# 未解决冲突与未验证事项

本文汇总全部文档在审计中发现且未消除的冲突与未验证事项，作为整套文档的
收尾索引。所有行号均以审计基线 b2f4087 为准。证据等级约定：explicit
evidence（代码/配置/提交可直接核验）、strong indication（注释/提交消息
转述，静态自洽但缺运行时或上游证据）、unverified（无从核验）。

## 未解决冲突总表

| 主题 | 冲突 | 两侧 | 证据等级 |
| --- | --- | --- | --- |
| 会话持久化 | JSONL vs SQLite 后端 | 配置侧（cordis.patch.yml:143-149、cordis.yml:158-164）全为 JSONL，patch 无 SQLite 行、无"禁用 JSONL"行；文档侧（docs/configuration.md:139/154-162、docs/architecture.md:77/85-86、docs/getting-started.md:71）称 profile 模式用 SQLite（~/.dsh-cc/sessions.sqlite）；getting-started.md:108-109 又自称 JSONL——旧文档内部亦自相矛盾。**以配置为准，SQLite 声称标「文档冲突/待确认」** | 配置侧 explicit；文档侧 explicit（内容过时） |
| 更新系统 | DSH_CC_UPDATED_FROM 取值时点 | src/plugin.ts:47-48 注释设计意图是"更新前版本"；src/update.ts:232 在 runProcess(update --latest) **完成后**才取 installedTuiVersion——标记=新版，成功更新后 isVersionNewer 必假，告警每次成功更新都触发 | strong indication（静态顺序明确，运行后果需实跑） |
| 更新系统 | update-unavailable 兜底提示缺 --latest | src/i18n.ts:173 提示 plain `update` 命令；src/update.ts:199-210 注释明确 plain update 被 caret 范围困住、跨 minor 必须 --latest | explicit |
| 更新系统 | 文档遗漏小写拼写 | docs/interaction.md:152 只写 NPM_CONFIG_REGISTRY；src/update.ts:84 与 scripts/verify-update.mjs:112-117 同时支持小写 npm_config_registry | explicit |
| 注入上下文 | 展示口径 | docs/architecture.md:107 与根 README.md:186 称"注入到 system prompt 的插件上下文不会在 UI 中单独列出"；src/components/LoadedContextPanel.tsx:82-88 实际渲染 context.contexts 为独立"运行时上下文"组 | explicit（精确事实：面板空转录时展示该组，转录内注入消息仍不显示） |
| /doctor | 存储路径不符 | src/channel.ts:2118-2119 检查 ~/.dsh-cc/sessions；实际 JSONL 根为 dshHomePath('sessions')（~/.dsh/sessions，cordis.patch.yml:149） | explicit |
| 主题 | docs 称 colors 必需 | docs/themes.md:67 标记必需；src/customTheme.ts:175-178 colors 缺省合法（空覆盖） | explicit |
| 主题 | StatusMetrics 硬编码色值 | src/screens/StatusMetrics.ts:223-228 硬编码 success/warning/error 并注释"cc-tui dark theme values (theme.ts)"；与 src/theme.ts:132-134 dark 主题三组数值全部不符，且不随主题切换 | explicit |
| 主题 | ThemePicker 排序注释 | src/components/ThemePicker.tsx:46-49 称 "sorted by file name"；代码按主题 name localeCompare（src/customTheme.ts:246） | explicit |
| 主题 | 语言链注释 | src/plugin.ts:40-43 与 src/index.ts:54-55 注释均漏 OS locale 步骤（src/index.ts 还漏 config.lang）；代码实际一致走完整 5 级链（src/i18n.ts:5-11） | explicit |
| 主题 | 主题描述路径按显示名拼 | src/i18n.ts:243 按 {{name}} 拼路径，ThemePicker 传入 spec.name；声明 name 与文件名不同时显示路径不存在（仅外观） | explicit |
| 模型路由 | ModelPicker 注释过时 | src/components/ModelPicker.tsx:12-13 称模型创建时固定、选择需重启生效；实际 Enter 立即 switchModel 实时 fork 切换 | explicit |
| 模型路由 | /config 文案过时 | src/i18n.ts:153 doctor-route-hint 称 /model 仅重启生效且路由由 llm-deepseek 段决定；实际即时 fork 切换并持久化，provider 钉在 cc-tui 段（cordis.yml:15） | explicit |
| 模型路由 | /doctor 新旧来源混合 | src/channel.ts:2106 模型取可变 state.model、provider 取启动配置——/model 切换后展示错配对；src/channel.ts:261 接口注释 "Resolved model id (from the plugin config)" 亦过时 | explicit |
| 输入 | 监听者顺序注释存疑 | src/components/PromptInput.tsx:47-52 注释称 Chat 监听者先执行；实际注册在 useEffect（子先父后），与注释矛盾；运行无法验证，且 interruptSeq token 使双投递无害 | strong indication（两说皆可自洽） |
| 输入 | README 图片粘贴口径 | README.md:88 宣称 Ctrl+V 粘贴图片；clipboard.ts 只对 FileDropList 产出路径，剪贴板位图 Get-Clipboard -Raw 返回空 → 提示"剪贴板为空" | explicit |
| 输入 | 历史文档口径 | docs/interaction.md:15 称 ↑/↓ "浏览历史"；实际 ↑/↓ 仅会话内 50 条，磁盘 200 条历史只有 Ctrl+R 能检索 | explicit |
| 输入 | /rewind 文档缺失 | /rewind 已注册并出现在 / 菜单与 ? 帮助；README.md / docs/interaction.md 只记载双击 Esc | explicit |
| 输入 | steering 过滤空操作 | src/screens/Chat.tsx:727-728 注释称排除 steering 侧问（row.label === undefined），但 src/ 无任何代码给 user 行设置 label——过滤条件恒真 | explicit |
| 输入 | v0.4.1 标签歧义 | 基线 HEAD b2f4087（package.json 0.4.1）含 pr-55；git tag v0.4.1 指向 eeca418（不含）；publish.yml 按 tag==version 发布，npm 0.4.1 很可能不含 pr-55/pr-61（注册表未离线核验） | explicit（tag 位置）；unverified（npm 内容） |
| 渲染 | CI 挂载缺口 | 根 README.md:200-211 的开发段仅简述 CI（Node 24/pnpm 11），未列出 verify-* 脚本的 CI 步骤；ci.yml 实测挂载（仅列本文档涉及的项）：verify-teardown-exit（:41）、verify-update（:45）、verify-child-stderr（:63）、verify-model-route（:67）、verify-cjk-truncate（:71）；verify-themes/verify-shrink/verify-scroll/verify-resticky/verify-tps 均未挂 CI | explicit |
| 渲染 | renderToScreen 死代码 | src/ink/render-to-screen.ts:47-67 导出 renderToScreen，使用双调 flushSync 急刷；src/ 无生产调用者（Grep 仅命中定义），verify 脚本是否使用未确证 | explicit（无调用者） |
| 渲染 | "4 处描述"口径 | `.github/workflows/ci.yml:68-70` 注释称有 4 处描述按终端显示宽度处理；源码可枚举的 `truncateToWidth` 调用点为 3 处（src/components/FileSuggestions.tsx:48、src/components/CommandSuggestions.tsx:57、src/components/MessageList.tsx:570） | explicit |
| 渲染 | textWrap 'end'/'middle' no-op | src/ink/wrap-text.ts:46-79 只实现 'wrap'、'wrap-trim' 与 startsWith('truncate')；'end'/'middle' 落到原样返回；src/ink/styles.ts:68-69 仍声明这两个值——功能未实现还是样式残留未确证 | strong indication |
| 渲染 | 收缩帧修复演进 | a56b8e8→cb1a28b→18680e5→287a811→6a89566 五连提交修复"收缩帧后残影"，主循环未逐帧复跑动画 | 提交 explicit；行为 unverified |
| MCP | MCP SDK 默认值来源 | StdioClientTransport stderr 默认 'inherit' 仅见于源码注释与提交消息；node_modules 未安装，无法对照上游 @modelcontextprotocol/sdk 确证 | strong indication |
| MCP | cross-spawn 行为 | "调用期从 CJS exports 读 spawn"只在注释声明；验证脚本复刻该访问模式但未实际加载 cross-spawn | strong indication |
| MCP | 首个 spawn 时机 | 真实 profile 启动时 dsh-mcp-client 首次 spawn 是否必然晚于 cc-tui 守卫安装，取决于外部 bundle 加载顺序 | unverified |
| MCP | issue #17 原始内容 | 截图/复现步骤仅由提交消息与注释转述，仓库内无 issue 正文 | unverified |
| 生命周期 | 组合层语义 | patch 是整行覆盖还是叠加、dsh-base 层最终组合内容（node_modules 未安装不可读）——覆盖后是否双重挂载取决于 dsh Loader 规则 | unverified |
| 生命周期 | cordis.yml 装配约束 | 裸组合文档声称装配约束（cc-tui 段 provider/model 半钉等）；Schema 无 route 默认值（issue #30） | explicit（Schema）；unverified（装配效果） |
| 生命周期 | bootstrap 目录 | src/bootstrap 为遥测空桩（state.ts，见 [lifecycle.md](lifecycle.md#bootstrap-目录)），不参与启动流程；目录名源自 Claude Code 原版遥测模块 | explicit |
| 会话 | 注入上下文展示口径 / /doctor 路径 / index.ts 注释 / resume API | 见上表与 [session-context.md](session-context.md#冲突) | — |

## 未验证事项（无冲突、无证据确证）

### 外部/上游行为（不在本仓库内）

- dsh-base 层最终组合中是否存在 SQLite 行；dsh Loader 对 patch 整行覆盖的
  规则；"禁用 base JSONL"的组合效果。
- dsh-session-persistence-jsonl 物理编码（zstd、packed chunk runs 等，仅能
  从 migrate 脚本注释间接得知）。
- recordedModelRoute 依赖的 request/header 事件结构
  data.header.config.{provider,model} 的真实写入者（dsh-agent loop）。
- /model 切换后新会话产生的 request/header 是否携带新 provider/model。
- LoadedContextPanel tools 组是否包含 MCP 工具（取决于上游 dsh-agent /
  dsh-system-prompt 组装）。
- teardown 时 MCP 子进程与其他服务的回收方式。
- ~/.pi/agent/working-activity.json 实际格式（activityPrefs.ts 注释称
  mirroring 其 frames key，pi 扩展不在本仓库）。
- dsh launcher 对重启进程 process.argv.slice(1) 重放参数的重新解析方式。
- 引擎层是否消费同一 i18n 语言机制（/lang 是否影响其他插件文案）。
- MCP SDK / cross-spawn 上游实现细节（见冲突表）。

### 本仓库内、静态无法确证

- Chat 与 PromptInput 两个 useInput 监听者的实际执行顺序（注释与 React
  effect 语义相抵触）。
- IME 组合期间照常发键的终端（部分 Linux IME 配置）行为。
- Ctrl+Enter 在不支持 kitty/modifyOtherKeys 的旧终端上能否识别。
- Ctrl+V 在无 PowerShell 环境（WSL 直启/SSH Linux）下是否工作
  （clipboard.ts 硬编码 powershell，无平台分支）。
- compact 之后能否回退到压缩点之前（推断为不能，无文档或测试声明）。
- update 重启后会话恢复细节；installedTuiVersion 在 tsx 源码布局下的真实
  运行时行为。
- 8 个 *_FOR_SUBAGENTS_ONLY 键及 rainbow_*/briefLabel* 等无消费点键是否有
  外部消费者；dark-ansi "verbatim from the leak" 的确切上游文件。
- design-system/ThemeProvider theme prop 路径（生产传 null）是否有任何调用者。
- attach-existing 分支（plugin.ts:368-370）下状态栏是否跟随会话记录。
- renderToScreen 死代码是否被 verify 脚本使用；textWrap 'end'/'middle' 是
  功能未实现还是样式残留。
- waitUntilExit 结算的精确 microtask 时序。
- 实际 profile 安装的会话库后端（node_modules 未安装，无法实跑核验）。
- npm registry 上 0.4.1 tarball 的实际内容（v0.4.1 tag 指向 eeca418，
  不含 pr-55/pr-61，发布物未离线核验）。

## 证据等级分布

整套文档的结论全部可回溯：explicit evidence 均给出文件:行号（基线
b2f4087）；strong indication 均说明转述来源（注释/提交消息）与静态自洽性；
无证据项一律标 unverified，未作"无法确证"以外的提升。统计数字（282 条目
归属、69 主题键、215 i18n 键、24 cordis id、29+4 patch 行、6 exports、
39 本地命令）均经程序化脚本重算（见 [origin.md](origin.md) 口径与
[README.md](README.md) 审计信息表）。

相关文档：[README.md](README.md)（索引与审计信息）、
[origin.md](origin.md)（归属与口径）、[session-context.md](session-context.md)
（JSONL/SQLite 冲突详情）。
