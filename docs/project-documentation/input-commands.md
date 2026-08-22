# 输入处理、IME 避让与命令系统

本文覆盖输入模型（单 value+cursor、编辑键位、会话内历史）、键盘链路、
IME 拼音 preedit 避让、粘贴双通道，以及 slash 命令系统（/rewind、/new、
/compact 等）。行号均以审计基线 b2f4087 为准。

## 输入模型

PromptInput 为单一 value 字符串 + 整数 cursor 双状态（无选区 API，
`src/components/PromptInput.tsx:123-124`）；setInput 夹紧光标：
`setCursor(Math.max(0, Math.min(cursorOffset, next.length)))`（:356-359）。

编辑操作全集（行内，`src/components/PromptInput.tsx:582-658`）：

| 键 | 行为 |
| --- | --- |
| ←/→ | 逐字符移动 |
| Ctrl+←/→ | 单词边界（readline alt+b/alt+f 语义，辅助函数 wordBoundaryLeft/Right :18-32） |
| backspace/delete | 删字符 |
| Home/End、Ctrl+A/Ctrl+E | 逻辑行首尾 |
| Ctrl+U / Ctrl+K | 删除行首/行尾 |
| Ctrl+W | 删前词 |

多行支持：Shift+Enter 在光标处插入 '\n'（:476-483）；↑/↓ 在多行时按行移动并
夹紧到目标行长度（cursorColumn :362-371）；视觉行超过 MAX_VISIBLE_LINES=5 后
窗口滚动保持光标行可见（:45,741-754）。

会话内历史（:15,141-142,539-580）：↑/↓ 在非多行、非 overlay 时走
history.current 环形数组（提交时 push trimmed 文本，上限 HISTORY_LIMIT=50，↑
回退 ↓ 前进，越界回空串）；**该数组初始化即为空，从不从磁盘历史文件加载**。
持久化历史（`src/history.ts`）：history.jsonl 每行一个 JSON（text+ts），appendHistory
在跨进程锁下写入临时文件并原子替换，物理文件始终只保留最近 HISTORY_LIMIT=200 条；
读取时折叠紧邻重复、跳过坏行、归一化非法 ts。historyEntryId 用 sha1(text) 前 12 位
做 React key 前缀，结果位置保证重复文本的 key 唯一；只有 Ctrl+R 能检索磁盘历史
（见下）。

## 键盘链路

```text
App.handleReadable 读 stdin（src/ink/components/App.tsx:434-474）
  -> processInput -> parseMultipleKeypresses（tokenizer 切分 text/sequence，
     IN_PASTE 状态机，src/ink/parse-keypress.ts:225-314）
  -> parseKeypress 把序列译为 name/ctrl/shift/meta（src/ink/parse-keypress.ts:631-805；
     keyName 表 :316-418：'\r'→return、'\t'→tab、'\b'/0x7f→backspace、
     单字节 s<=0x1a→ctrl+字母、CSI u=ESC[13;2u 等、xterm modifyOtherKeys
     ESC[27;m;k~、FN_KEY_RE 修饰键解码 modifier bit: shift1/meta2/ctrl4/super8）
  -> processKeysInBatch：terminal response→querier、FOCUS→focus 状态、
     Ctrl+Z→suspend、其余构造 InputEvent 并 emit('input') 且
     dispatchKeyboardEvent（src/ink/components/App.tsx:550-630）
  -> InputEvent.parseKey 折叠为 Key 布尔标志组+input 文本
     （src/ink/events/input-event.ts:31-194，16 个标志：upArrow/return/escape/ctrl/shift/meta/
     super 等；ctrl+space 修正为 ' '；未知名 F13 序列与 ESC 缺失的 SGR 鼠标
     残片被吞掉防泄漏为文本；大写输入置 shift=true）
  -> useInput 的 handleData 收到事件，Ctrl+C 门控后调用 handler
     （src/ink/hooks/use-input.ts:72-93）
  -> Chat 的 useInput 先处理全局键（工作态 Esc、Ctrl+R/T/O/L/E、Shift+↑ 选择、
     搜索态等，src/screens/Chat.tsx:848-1201）；PromptInput 的 useInput 处理编辑键
     （src/components/PromptInput.tsx:373-736）
```

监听注册细节（src/ink/hooks/use-input.ts:45-93）：useLayoutEffect（而非 useEffect）同步开
raw mode（终端在下一事件循环 tick 前不能处于 cooked 模式）；监听注册在
useEffect 内，handleData 经 useEventCallback 保持引用稳定——注释：注册位置稳定
才能保证 stopImmediatePropagation 顺序。EventEmitter.emit 按 rawListeners 注册
顺序遍历，首个调 stopImmediatePropagation 的监听者之后不再执行
（src/ink/events/emitter.ts:27-50）。

raw mode 初始化顺序（src/ink/components/App.tsx:294-318）：stopCapturingEarlyInput →
stdin.setRawMode(true) → EBP(DEC 2004) → EFE(DECSET 1004) →
supportsExtendedKeys() 时写 ENABLE_KITTY_KEYBOARD(CSI >1u) +
ENABLE_MODIFY_OTHER_KEYS(CSI >4;2m)（使 Ctrl+Shift+字母可区分于 Ctrl+字母）。

## IME 避让：物理光标停放

全仓库**没有任何 compositionstart/update/end 或 beforeinput 等组合事件监听**
（grep 仅命中注释）；IME 组合期间的行为完全委托给终端：

- 终端在物理光标处渲染 IME preedit（src/ink/components/App.tsx:116-120 注释：
  "Enables IME composition at the input caret"；src/ink/ink.tsx:653-699：
  cursorDeclaration 在帧末解析为绝对坐标并发射 CUP 光标定位序列）。
- useDeclaredCursor（src/ink/hooks/use-declared-cursor.ts:5-12,42-62）：每次 commit
  无条件重声明以对抗兄弟交接与卸载清理。
- 视觉列而非字符索引（src/components/PromptInput.tsx:756-773）：CJK 字符占两个终端列，原始
  字符数会把物理光标停在字符中间导致 Windows Terminal 把拼音 preedit 画到
  周边文本上；caretVisualCol 用 stringWidth 计算。
- 空输入刻意不渲染 placeholder（src/components/PromptInput.tsx:34-41）：组合期间应用收不到
  任何输入事件（Windows Terminal 在 TSF 组合期间抑制键事件），空行空白是
  保证 preedit 无物可遮的唯一办法；空输入渲染为空白格上的反显块光标
  （`<Text inverse> </Text>`，src/components/PromptInput.tsx:908-916）。SearchBox 同款避让（src/components/SearchBox.tsx:5-11,
  38,68-76）：行首反显空白块 + 右侧 dim 对齐的 placeholder（"kept off the
  caret's cell"）。

## 粘贴双通道

| 通道 | 链路 | 位置 |
| --- | --- | --- |
| Bracketed paste | raw mode 写 EBP（DEC 2004）；终端以 CSI 200~...201~ 包裹；parser 置 IN_PASTE 累积 token，PASTE_END 时 createPasteKey（isPasted=true、整段作 input）；PromptInput 最先检查 `event?.isPasted && input.length > 0`，CRLF→LF 后 insertAtCaret | src/ink/termio/csi.ts:364-368、src/ink/parse-keypress.ts:243-257、src/components/PromptInput.tsx:386-392 |
| Ctrl+V（Windows） | `key.ctrl && input === 'v'`（clipboardBusyRef 防重复）→ execFile powershell Get-Clipboard：先试 FileDropList（Explorer 复制文件→FILE: 路径行），否则 -Raw 文本经 base64 输出（TEXT64:，保证多行与 CJK 安全）；失败 150ms 后重试至 3 次、3s 超时、child.unref；formatClipboardInsert：文件路径含空白加引号、空格连接，文本 CRLF→LF；null 时通知 'input-clipboard-empty' | src/components/PromptInput.tsx:394-409、src/utils/clipboard.ts:15-93 |

注释（src/ink/parse-keypress.ts:249-254）称空粘贴也发键（macOS 剪贴板图片处理），但
isPasted 唯一消费点是 src/components/PromptInput.tsx:389 且要求 input.length>0——空粘贴键无
下游消费者。

## 外部编辑器（Ctrl+G）

`key.ctrl && input === 'g'`（src/components/PromptInput.tsx:496-522）触发 readline
edit-and-execute-command 语义的编辑器往返：

- **解析顺序**：`$VISUAL` → `$EDITOR`（readline 惯例，支持 `EDITOR="code --wait"`
  整行引号拆分，src/utils/externalEditor.ts:94-100）；二者均未设置时返回
  `unavailable`——**刻意不做 vi 兜底**（把用户丢进不会退出的 vi 比报错更糟），
  以 'input-editor-unavailable' 通知。
- **往返语义**：草稿写临时文件 → 终端交接给编辑器（Ink alt-screen handoff）→
  保存文本有变化则 `setInput` 回填。失败映射为 outcome：edited / unchanged /
  非零退出 / 启动失败（'input-editor-failed'）。
- **busy 锁**：`editorBusyRef` 在整个往返期间为 true（:412 处早退拦截），catch/
  finally 保证 rejected promise 不杀进程、锁必然释放——否则 Ctrl+G 永久锁死。
- **快捷键保留位**：`ctrl+g` 在插件协商的保留键列表中（src/dsh-adapter/shortcuts.ts:115），
  含 ctrl+shift+g 超集拒绝；`ctrl+x` 已释放给插件。
- **回归门禁**：scripts/verify-external-editor.mjs（解析+往返，无 TTY）、
  scripts/repro-external-editor.tsx（xterm headless TTY 交接冒烟）。

## 工作态投递与 Esc 语义

| 键 | 工作态行为 | 位置 |
| --- | --- | --- |
| Enter | STEER：注入运行中回合下一步边界（Codex/pi 语义） | src/components/PromptInput.tsx:254-266 |
| Tab | follow-up 排队 | :272-284 |
| Ctrl+Enter | 中断并立即投递（注释：Windows Terminal 发送 CSI 13;5u / 13;1;5u） | :309-329 |
| Alt+Up | 取回最后一条 pending（经 channel.removePending，官方 inbox.remove 撤回，失败拒绝） | :291-303 |

Esc 语义分级（src/components/PromptInput.tsx:659-722）：关 help → 关命令菜单（清空）→ 只关
当前 @ token 菜单（fileEscRef）→ 工作且有 pending 时中断并立即投递 → 清空有
内容输入 → 双击 Esc：空输入开 rewind / 有输入清空，3s 内不重复则取消武装。
Chat 侧另在 :1149-1162 处理工作态 Esc（pending 投递或 channel.cancel）并
stopImmediatePropagation。

Enter 防抖（:159-160,419-425）：cmd 管线可能把一个 Enter 拆成 \r+\n 两次事件，
lastEnterAtRef 80ms 窗口内重复 Enter 被折叠；整行输入规则：input 含 \n 或 \r
时纯 CR/LF 视为 Enter，否则合并 value+input 后按命令唯一匹配→运行，否则提交
（:449-469，注释："Windows ConPTY pipelines deliver whole lines with the Enter
key lost"）。

## 命令系统

命令解析（src/commands.ts:83-89）：parseCommandName 正则
`^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])` 取首个 token，rawInput 保留名字后的原文
（`/plan off` → plan + ' off'）；tryRunCommand 要求文本以 '/' 开头、名字在
channel.commandList（本地 39 条 + 插件合并，见
[lifecycle.md](lifecycle.md#命令分发链)）中，处理成功才清空输入并写历史。

命令菜单（src/components/PromptInput.tsx:168-175）：`value.startsWith('/')` 触发
filterCommands（prefix 为 '/' 后整段文本，trim+lowercase，按 name.startsWith
匹配）；overlayOpen 还需 !helpOpen && !selectionActive && !value.includes('\n')。
命令菜单打开时 Enter 执行选中项（绝不发送 '/mo'）；Tab 补全为 `/<name> `；
Shift+Tab 在 Tab 分支前处理（解析器把 backtab 报为 key.tab+key.shift），循环
推理 effort（:491-494，"dsh parity"）。

### /rewind（issue #43，pr-55）

/rewind 于 LOCAL_COMMANDS 注册（src/commands.ts:31），runCommand case 'rewind'
复用双击 Esc 的 openRewind() 选择器（src/screens/Chat.tsx:513-518）。rewindTo 机制自
0.1.0（809591d）已存在（src/channel.ts:372-375 接口注释 "CC's double-Esc rewind"：
fork 会话、换新 agent、返回可编辑文本），**pr-55 只加命令入口**。

```text
/rewind（或双击 Esc）-> openRewind（src/screens/Chat.tsx:736-750）：
   候选行 = channel.rows 筛 kind==='user' && label===undefined 倒序；
   无候选时 notify 'Nothing to rewind yet'
  -> src/components/RewindPicker（src/screens/Chat.tsx:1363-1371）：Enter 选中 -> 确认态 Enter 执行
     performRewind（:1101-1105）
  -> channel.rewindTo(row)（src/channel.ts:1219-1348）：
     working 时 cancel + waitForTurnEnd（30s）
     -> 回扫 turn/start 定 boundary = event.seq - 1（DSH 事件序
        turn/start→user/message→…→turn/end，消息自身 seq 在 turn 内，
        在此 fork 会命中 OPEN_TURN）
     -> sessions.fork(agent.session, boundary) 取 seed
     -> agents.create 新 child（childId=randomUUID；meta 记 parentSession /
        seedLength / agentPreset；agentOptions 沿用现用 provider/model——
        "a /model switch must survive it (issue #30)"，回退不恢复旧模型）
     -> 重置块：清空 rows / todos / goal / sessionTitle / tokens /
        lastUserText / spinner，再按 coalesceReplayEvents(seed) 重放
     -> bindAgent / refreshCommandList / refreshLoadedContext /
        touchSession(childId) / dispose 旧 handle
  -> 返回 row.text -> setHistoryFill（src/screens/Chat.tsx:754-758，notify 'Rewound —
     edit and press Enter to resend'）-> PromptInput fillText 效果
     （:147-153）写回输入框，用户编辑后 Enter 重发
```

### /new 一次生效（issue #25，pr-55）

- 引入：bfc46fb（08-06）在 runCommand case 'new' 加 CC 式确认——hasContent 且
  newConfirmRef 未 arm 时置标记、notify 'Press /new again to confirm'、return
  true（不调用 newSession）；4 秒后自动解除。
- 根因：会话有 user/assistant 行时第一次 /new 永远只 arm，必须 4 秒内再输
  一次才执行。
- 修复：6aa8598（pr-55）删除 newConfirmRef 与整个门控，case 'new' 直接
  `void channel.newSession()`（src/screens/Chat.tsx:439-448）；取舍依据：newSession 非破坏，
  旧会话仍持久化于 JSONL 会话库、/resume 可找回，"二次确认只是纯摩擦"。
- 合入：dc678d8（Merge pr-55）；channel.newSession() 实现未改动
  （715b60f..dc678d8 对 src/channel.ts diff 为空）。
- newSession（src/channel.ts:1456-1574）：working 时拒绝；composePreset
  （configuredPreset ?? readPresetPref）+ resolveModelRoute+validateModelRoute
  → agents.create → 重置块 → clearResumeTarget → touchSession → dispose 旧
  handle。

### /compact

调度：case 'compact'（src/screens/Chat.tsx:457-459）→ channel.compact()（src/channel.ts:1922-1961）：
经 serviceForAgent 解析 dsh-compaction 服务；缺服务 notify 'Compaction
unavailable'；working 时拒绝；compactNow(agent, signal) 异步压缩。渲染
（:2491-2534）：checkpoint user/message（source {kind:'plugin', plugin:'compact'}）
→ notice 'Conversation compacted' + kind 'compact' 摘要行，并立即重置
contextSegments/tokens.input/lastUsage/contextWarned。

与 rewind 的关系：两者都依赖持久化会话日志（cordis.yml:158-160 "Durable
session log... /resume and rewind both rely on this backend"）；compact 以摘要
替换日志历史 → 压缩点之前的 user 消息从日志消失；rewind picker 只列 user 行
而 checkpoint 渲染为 notice/compact 非 user 行 → **压缩后无法回退到压缩点之前**
（推断，无文档或测试明确声明）。

### 命令可见性

LOCAL_COMMANDS 注册后自动可见：'/' 建议 overlay 用
filterCommands(value, channel.commandList)（src/components/PromptInput.tsx:168-172）；'?'
帮助菜单 <HelpMenu commands={channel.commandList} />（:844）。/rewind 注册后
两处自动出现（53016e8 提交信息确认）。

## Ctrl+R 历史搜索

Chat 捕获 `key.ctrl && input === 'r' && !helpOpen`（src/screens/Chat.tsx:1128-1135）：
loadHistory() 读 history.jsonl 反转（最新在前）；过滤为不区分大小写子串
（:722-725）。对话框键盘在 Chat（:1048-1097）：↑/↓ 或重复 Ctrl+R 移动 focus、
Enter 填充、Esc/Ctrl+C/Ctrl+D 取消、其余键编辑 query；HistorySearchDialog
自身无 useInput（:11-17 注释 "Keyboard handling lives in the caller (Chat)"）。
setHistoryFill(entry.text) → PromptInput fillText effect 替换输入并置光标到
末尾（src/components/PromptInput.tsx:146-153，lastFill ref 去重）。对话框打开时 PromptInput
因 promptSelectionActive（含 historyOpen 等所有模态）忽略全部键。中文输入法仍在预编辑时，
SearchBox 中由终端绘制的字符尚未进入 historyQuery，结果会暂时保持上一个已提交查询；完成
候选提交后才会重新过滤。

## 冲突

| 项 | 两侧 |
| --- | --- |
| 监听者顺序注释存疑 | src/components/PromptInput.tsx:47-52 注释声称 "Chat's useInput listener runs BEFORE this component's (EventEmitter registration order)"；但监听注册在 useEffect（子先父后提交），PromptInput（子）应先注册先执行——与注释矛盾。无法运行验证；即便顺序相反，interruptAndDeliver 的 interruptSeq token 会丢弃重复请求，不能从无双投递反推顺序 |
| README 图片粘贴口径 | README.md:88 宣称 Ctrl+V "Explorer 复制的文件/图片 → 插入文件路径"；代码只对 FileDropList 产出路径，浏览器内复制的位图既非文件也非文本，Get-Clipboard -Raw 返回空 → 提示"剪贴板为空" |
| 历史文档口径 | docs/interaction.md:15 称 ↑/↓ "浏览历史"未注明范围；代码中 ↑/↓ 仅会话内 50 条，持久化 200 条历史只有 Ctrl+R 能检索 |
| /rewind 文档缺失 | /rewind 已注册并出现在 / 菜单与 ? 帮助，但 README.md / docs/interaction.md 只记载双击 Esc 的 rewind 入口；dc678d8 之后无文档提交 |
| steering 过滤空操作 | src/screens/Chat.tsx:727-728 注释称排除 steering 侧问（row.label === undefined），但 src/ 无任何代码给 user 行设置 label——过滤条件恒真 |
| v0.4.1 标签歧义 | 基线 HEAD b2f4087（package.json 0.4.1）含 pr-55；git tag v0.4.1 指向 eeca418（不含 dc678d8）。publish.yml 规定 tag==package.json version 才发布，按 tag 发布的 npm 0.4.1 很可能不含这两个改动（注册表内容未离线核验） |

## 未验证事项

- Chat 与 PromptInput 两个 useInput 监听者的实际执行顺序（注释与 React effect
  语义相抵触，纯静态分析两说皆可自洽，无测试可证）。
- IME 组合期间对会照常发送键事件的终端（部分 Linux IME 配置）行为如何。
- Ctrl+Enter 在既不支持 kitty 也不支持 modifyOtherKeys 的终端上是否还能被
  识别（parse-keypress 无老式终端兜底映射）。
- Ctrl+V 在无 PowerShell 环境（WSL 直启或 SSH 的 Linux 终端）下是否仍工作
  （clipboard.ts 硬编码 powershell 可执行名，无平台条件分支）。
- compact 之后能否回退到压缩点之前（代码推断为不能，无文档或测试声明）。
- 实际 profile 安装的会话库后端（见 [session-context.md](session-context.md)）。

相关文档：[lifecycle.md](lifecycle.md)（命令分发链）、
[rendering.md](rendering.md)（输入相关渲染）、
[model-route.md](model-route.md)（/model 命令）、
[ink-core.md](ink-core.md)（键盘解析底层）、[unknowns.md](unknowns.md)。
