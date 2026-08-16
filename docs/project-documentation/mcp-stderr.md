# MCP 集成与子进程 stderr 聚合

本文覆盖 issue #17 的修复：MCP 子进程 stderr 裸写终端的接管、聚合去重与
受控通知呈现，以及 MCP server 的声明位置与 /mcp 状态展示。行号均以审计
基线 b2f4087 为准。

## 问题（issue #17）

MCP 服务器经 `@deepseek-ai/dsh-mcp-client` 下的 MCP SDK `StdioClientTransport`
spawn，其 stderr 默认 `'inherit'`（`stdio: ['pipe', 'pipe', server.stderr ??
'inherit']`，`src/childStderr.ts:4-13`）。继承的 fd 2 由**子进程**直写终端
设备——这些字节从不经过本进程被补丁的 `process.stderr.write`（对照防线
`src/ink/ink.tsx:1614-1661` patchStderr，拦截 config.ts/hooks/第三方依赖的
stray writes），在停放光标处刷屏并与差分渲染的绝对坐标写交错，即 issue #17
截图的重叠乱码。

## 修复：spawn 补丁守卫

`src/childStderr.ts`（新增于提交 8c2429b，作者 FUSU123fusu，2026-08-14，合并
进 main 的提交 715b60f；改动 13 文件：新增 childStderr.ts 193 行、
verify-child-stderr.tsx 140 行，改 plugin.ts +32、i18n.ts +2、ci.yml +4 及
lib 产物）：

```text
installChildStderrGuard（src/childStderr.ts:87-117）：
  替换 child_process.spawn 为 patched 版本，返回 restore 函数
  （已接管的 in-flight 子进程保留其已改道的管道）
  -> redirectInheritedStderr（:42-59）：仅动 fd 2——
     字符串 'inherit' 整体 -> ['inherit','inherit','pipe']（保留 stdin/stdout
       继承，:45-49）
     数组 stdio[2] === 'inherit' 或裸 fd 2 -> 'pipe'（:50-58；短数组 fd 2
       默认 pipe 视为已安全；其他形式 default/'pipe'/'ignore'/显式流不改写）
     stdin/stdout 保持原模式，MCP JSON-RPC 通道不受影响
  -> drainLines（:61-79）：按 \n 切行转交 sink；stream 'end' 时冲刷未终止的
     尾部；'error' 事件静默吞掉（坏管道不能拖垮 TUI）
```

可达性依据（:21-27）：MCP SDK 经 cross-spawn spawn，而 cross-spawn 在调用期
从 CJS exports 对象读取 child_process.spawn，故补丁可覆盖（ESM 命名导入快照
`import { spawn } from 'node:child_process'` 会绕过，但依赖树内无此消费方）。

## 聚合去重

`createChildStderrReporter`（`src/childStderr.ts:146-193`），参数默认值
debounceMs=1500、cooldownMs=30_000、maxLineLength=200（:124-131,150-152）：

1. ANSI 剥离（CSI/OSC 正则，:32-35）——"raw child output can't inject cursor
   moves or colors into the notification area"；
2. trim、空行/纯空白丢弃；
3. 超长截断加省略号（200 字符上限）；
4. groups Map 以清理后的行为键：重复行 count++ 并重置防抖计时器；
   1.5s 安静窗内批量合并；
5. flush：冷却窗（30s）内静默；count>1 用 'child-stderr-line-repeat'
   （"重复 N 次"）否则 'child-stderr-line'；
6. 最终 `notify(text, { color: 'error', timeoutMs: 8000 })`（:161-186）。

i18n 文案（`src/i18n.ts:52-53`）：zh '子进程 stderr: {{line}}' /
'子进程 stderr: {{line}}（重复 {{count}} 次）'。

**无配置开关**：Config schema（src/index.ts:64-80）无任何 mcp/stderr 键；
src/plugin.ts:102 调用 createChildStderrReporter 时未传 options，全部走默认值；
ChildStderrReporterOptions 仅是 API 表面。CC_TUI_DEBUG 只控制原行是否进调试
日志（src/utils/debug.ts:7-11），非守卫开关。

## 安装点与 UI 呈现

```text
plugin.apply（src/plugin.ts:93-115）：ctx.effect 内安装守卫
  （installChildStderrGuard，sink 同时进 logForDebugging 与
  stderrReporter.push）
  ——声明于 agent 解析（resolveAgent，:131）之前，覆盖启动期 spawn；
  channel 存在前的通知进 stderrBacklog 缓冲
  -> channel 创建后 notifyStderr = channel.notify 并冲刷 backlog
     （src/plugin.ts:166-171）
  -> channel.notify（src/channel.ts:1704-1720）：push NotificationItem（默认
     timeoutMs 4000，stderr 通知为 8000）+ emit()，超时后 splice 移除
  -> src/screens/Chat.tsx:118 useSyncExternalStore(channel.subscribe, () => channel.version)
     订阅重渲染
  -> PromptInput 渲染末条通知：position=absolute 悬浮一行于输入框上方、
     右对齐、不占布局高度（src/components/PromptInput.tsx:798-839，"position=absolute
     takes zero layout height so the transcript never shifts"）
```

防御纵深（inline 模式）：stdin 空闲间隙（>5s）触发 requestViewportReanchor
视口重画，自愈第三方 tty 写入（含 MCP 子进程 stderr）造成的行漂移
（src/ink/ink.tsx:918-931，"a third-party tty write during the idle gap (an MCP
subprocess's stderr, issue #17) shifts every subsequent write by N rows"）。

## MCP server 声明与 /mcp

- **仓库 shipped 的 cordis.yml 与 cordis.patch.yml 不含任何 MCP 行**（grep
  mcp/MCP 零匹配）；声明位置是用户 profile 补丁层——docs/configuration.md:102
  "在用户 cordis.patch.yml 中插入"，i18n 的 mcp-insert-hint 更具体到
  `~/.dsh/profiles/cc-tui/cordis.patch.yml`。
- 空状态引导（src/channel.ts:2003-2012）：/mcp 无 mcp__ 工具时返回"未配置 MCP
  服务器"与 insert 示例行（id: mcp-context7 / name:
  '@deepseek-ai/dsh-mcp-client' / config: { transport: stdio, serverName:
  context7, command: npx, args: ['-y', '@upstash/context7-mcp'] }）。
- 挂载后（src/channel.ts:1988-2019）：按 dsh-mcp-client 命名契约
  `mcp__<server>__<tool>` 用正则 `^mcp__([a-z0-9-]+)__(.+)$` 分组成行；
  /mcp 命令经 channel.pushLocal 呈现为 local + local-output 行
  （src/screens/Chat.tsx:636-638）。

## 验证

`scripts/verify-child-stderr.tsx` 15 项 check，挂 CI（.github/workflows/ci.yml:63，
`node --import tsx/esm scripts/verify-child-stderr.tsx`）：

1. 未接管时：inherit 子进程 stderr 直达 fd 2 且 child.stderr===null（复现
   issue）；fixture 通过 default-import 的 CJS exports 对象调用 spawn
   （:36-43，"this is the access pattern the patch must cover (cross-spawn
   does exactly this)"）；
2. 数组 stdio 接管后：裸输出不再到 fd 2、行进入受控 sink；
3. 字符串 'inherit' 形式同样接管；
4. reporter 单测：同一条连发 3 次只出一条且带"重复 3 次"、冷却期静默、
   冷却结束可再通知、不同行各自成条、ANSI 剥离、超长截断带省略号、空行
   丢弃。

## 冲突与未验证事项

| 项 | 说明 |
| --- | --- |
| MCP SDK 默认值来源 | StdioClientTransport 的 stderr 默认 'inherit' 仅见于源码注释与提交消息，node_modules 未安装，无法对照上游 @modelcontextprotocol/sdk 源码确证（strong indication 而非 explicit 上游证据） |
| cross-spawn 行为 | "调用期从 CJS exports 读 child_process.spawn"只在注释声明；验证脚本复刻了该访问模式但未实际加载 cross-spawn/dsh-mcp-client 验证 |
| 首个 spawn 时机 | 真实 profile 启动时 dsh-mcp-client 首次 spawn 是否必然晚于 cc-tui apply 安装守卫（ctx.effect 同步执行），外部 bundle 的加载顺序不在本仓库内 |
| issue #17 原始内容 | 截图/复现步骤仅由提交消息与源码注释转述，仓库内无 issue 正文 |
| 措辞差异（非实质） | 提交 8c2429b 消息称改写"stdio 数组第 3 位"，代码用下标 stdio[2]（0 基）——表述不同语义一致 |

相关文档：[lifecycle.md](lifecycle.md)（装配顺序）、
[session-context.md](session-context.md)（上下文与工具）、
[rendering.md](rendering.md)（空闲重锚自愈）、[unknowns.md](unknowns.md)。
