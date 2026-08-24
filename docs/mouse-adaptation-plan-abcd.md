# 鼠标适配补全方案 · A+B+C+D 全量（已实施）

> 实施记录（8 个提交，含 1 个修正）：A 组两刀（picker 接线 + rewind
> 语义）、B 组两刀（轨迹场景 + WaveBand）、C 组（设置屏）、D 组（会话
> 浏览器确认行 + 帮助菜单）、修正（onWheel 必须挂字面 ink-box 宿主；
> 页签行宽字符结尾标签 +1 防折行）、docs+repro。用户拍板的两处设计：
> rewind 确认页点击直接执行；设置屏 hover 即移动选中。E 组仍缓。
>
> 前置：本轮沿用既定交互分级——菜单/控件类 hover 背景高亮，内容类轻指示
> （glyph 提亮）；所有点击复用键盘同路径动作，不新造业务逻辑。
> 每组独立 commit，改完跑门禁。

## A 组 · 五个未接线浮层

全部走已就绪的 ListItem onClick / Select onPick 通道，模式与上批
9 个 picker 完全一致：

| 组件 | 接线 | 点击语义（= 键盘） |
|---|---|---|
| ThinkingToggle | Select 加 onPick | 选中并应用 thinking 显示模式 |
| WorkspacePicker | ListItem onClick | 切到该工作区（Enter 同路径） |
| WorkspaceMenuPicker | Select onPick | 执行该菜单项 |
| WorkspaceFlowPicker | ListItem onClick | 选中该命令分支；`busy` 时禁点；`input` 行点击聚焦输入（等价进入输入态） |
| RewindPicker 列表页 | ListItem onClick | 设 focusIndex（进入确认态由 Enter/y 触发——高危操作保留显式确认，单击只选中） |

**RewindPicker 确认页**（含 modes 列表）：选项行点击 = 直接执行该模式
rewind。理由：确认页本身就是显式确认（用户已点过一次进确认），再套
一层键盘确认反而割裂；modes 页每行语义明确无歧义。

## B 组 · 轨迹场景（最大单项）

| 区域 | 交互 | 实现 |
|---|---|---|
| Ledger 行（timeline） | 点击 = 光标跳该行 | Ledger 加 onRowClick(index)；行 Box 挂 onClick；hover 时 `▸` 指示符在非焦点行显示为 dim `▸`（轻指示，不刷背景） |
| Hotspot 行 | 点击 = 跳回 timeline 定位该组 | onRowClick(row.firstIndex)：switchView('timeline') + setCursor(对齐 indexes.indexOf) —— 与 Enter 完全同逻辑，抽公共函数 |
| 页签行（timeline/hotspot） | 点击切换 | tabs 行两段各包 Box onClick=switchView；非活动页签 hover 提亮 |
| 排序/投影标签（右上 axisLabel） | 点击 = 循环切换 | 排序 `t` / 投影 `m` 的鼠标等价；hover 提亮 |
| `/` 搜索框区域 | 点击打开搜索 | setQueryOpen(true) |
| 滚轮 | 移动光标 | Ledger/HotspotView 外层挂 onWheel（ink-box host，±3 行/格；hotspot 为 ±1 行/格）；expanded 态滚 inspector 的 inspectScroll |
| WaveBand 波形带 | 点击列 = 跳最近事件 | columnOfIndex 反查最近 index → setCursor；hover 不做（太密） |

**注意**：轨迹场景在 inline 模式经 `<AlternateScreen>` 包裹（Chat.tsx
sceneOpen 分支），fullscreen 模式复用宿主 alt screen——两种模式鼠标都
可用（AlternateScreen 默认开 mouseTracking）。

## C 组 · 设置屏

| 区域 | 交互 | 实现 |
|---|---|---|
| 字段行 | 点击 = 设焦点 + 触发该字段的 Enter 动作（boolean/select 循环值；文本/secret 进编辑态） | renderField 的行 Box 挂 onClick(entry.focus)；edit 态下点击行不动（防误触，键盘继续） |
| group 行（›） | 点击进入组 | 同上 entry.focus 通道 |
| hover | 焦点跟随 | 行 hover = setFocusIndex(entry.focus)（设置屏的“焦点”就是选中，hover 即预览）＋ suggestion 色指针 |
| 滚轮 | 移动 focusIndex ±1（非窗口滚动——设置屏是焦点跟随窗口，滚轮滚焦点即滚窗口） | 外层 ink-box 挂 onWheel |

**不做**：只读 namespace 区点击（无动作语义）；编辑态内的文本点击定位
（编辑是单行增量输入，非全编辑器，键盘语义足够）。

## D 组 · 零散

| 项 | 交互 | 说明 |
|---|---|---|
| SessionBrowser confirm-delete/clean | 行尾 `y/n` 提示文本点击 = 确认/取消 | mode 态守卫；高危操作已有 Enter 前的 confirm 屏，此层是快捷方式 |
| HelpMenu 命令行 | 点击 = 填入 `/name ` | HelpMenu 自有行渲染（非 ListItem），加 onClick + hover |
| 帮助滚动 | 已支持（ScrollBox + 位置路由） | 无需改动 |

## 测试计划

1. **repro-trajectory-mouse.tsx**（新增）：xterm headless 注入点击——
   ledger 行点击光标跳转、页签切换、hotspot 行跳回、滚轮移动光标、
   搜索框点击打开；
2. **repro-suggestion-click.tsx 扩第四幕**：rewind 列表点击进确认、
   确认页点击执行；workspace 菜单点击执行；
3. 既有门禁全量：verify:build（18 项）+ pointer-events + ghost；
4. 设置屏交互手动验证（无现成 headless harness，成本高；字段行点击
   逻辑与 SettingsForm 的既有单测路径一致，风险低）。

## Commit 拆分（7 个）

1. `feat(ui): ThinkingToggle/Workspace 三件套/菜单 picker 点击接线`
2. `feat(ui): RewindPicker 点击选中 + 确认页点击执行`
3. `feat(traj): 轨迹场景鼠标适配——行点击/页签/排序/搜索/滚轮`
4. `feat(traj): WaveBand 点击跳转最近事件`
5. `feat(settings): 设置屏鼠标——字段/组行点击 + hover 焦点 + 滚轮`
6. `feat(ui): 会话浏览器确认行 + 帮助菜单点击`
7. `docs+test: 交互文档/tips 更新 + repro 扩展`

## 明确不做（本轮）

- E 组性能项（滚轮加速度、1003 动态降级、OSC 52 分块）——需真机数据
- 设置屏编辑态内的鼠标文本定位
- WaveBand hover（列密度过高，指示意义小）
