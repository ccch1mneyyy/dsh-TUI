# dsh-TUI 仓库红线
真源为当前目标分支的 /mnt/shared/_Projects/DSH-TUI/repo/AGENTS.md、/mnt/shared/_Projects/DSH-TUI/repo/ADAPTER.md、/mnt/shared/_Projects/DSH-TUI/repo/docs/contributing.md 全文；本表非穷举。严重度属本技能政策，仓库文本仅定义义务。

## 1. 源码与生成物分离｜❌
只改真源、不手改 /mnt/shared/_Projects/DSH-TUI/repo/lib/ 等生成物；构建生成物是否进 diff 依当前贡献指南。删/改名源码后须干净构建证无残留；查改动清单、/mnt/shared/_Projects/DSH-TUI/repo/.gitignore、package files、clean/compile/verify:package。

## 2. transcript 与会话事实只有一个真源｜❌
transcript 事实仅来自持久化 DSH 会话事件，UI 不乐观拼造助手/工具/状态事实而分叉日志；保事件顺序、seq 锚点、call ID、恢复/rewind/fork 及未知事件 fail-closed。查生产者、投影、持久化白名单、恢复及 toggle 后 resume 回归。

## 3. 职责分层｜❌
域服务/上游 API 经 adapter 边界；投影/非 React 动作归 channel，交互模式/按键优先级归 Chat/聚焦组件，终端协议/布局/命中测试/帧差分归 Ink/Yoga；component/screen 不复制会话状态机、持久化或策略。查新 owner、直调上游、重复 helper、组件原地写 store。

## 4. 注册即效应，退出只有一条清理纪律｜❌
订阅/timer/socket/子进程/文件句柄/raw mode/鼠标/焦点/alt-screen 须明确 owner、幂等 disposer；Cordis 绑 `ctx.effect` 或统一退出漏斗。区分用户退出/框架 teardown，迟到回调不复活；渲染失败响亮且非零退出，成功/错误/信号/超时均恢复终端；收尾不只依赖拆树后可能为空的 ref，并发退出用单一在途闩锁。

## 5. TUI 渲染期间 stdout 安静｜❌
渲染期间新增 `console.log/info/debug` 或 stdout 诊断默认阻断；诊断须明确 opt-in 的 stderr/调试通道且无凭据。grep 仅候选，字面量/示例/不执行代码须人工判定。

## 6. TypeScript / ESM 与局部风格｜⚠️
纯 ESM（ECMAScript 模块），相对 import 用 `.js`，纯类型用 `import type`；新代码不以 `any`/`@ts-ignore`/全局 disable 逃契约，须 `unknown` 收窄或解释必要边界。遵当前文件两空格/单引号/无分号，不无关格式化移植区；纯偏好不报，违反明规、扩 diff 或藏语义才报。

## 7. 终端宽度与不可信文本边界｜❌
显示宽度按终端单元而非 JS `length`；截断/换行/光标/选择/坐标/预算覆盖终端转义、组合字符、emoji、中日韩文字、代理对。模型/工具/插件文本渲染前去控制序列并限单元数；路径前缀按段，POSIX 根/Windows 盘符单独处理；查是否绕过既有 width/slice/wrap/sanitize helper。

## 8. 用户可见行为与双语/跨文件投影同步｜⚠️
行为/配置/快捷键/命令/主题/限制/错误语义依当前贡献指南同步中英文用户文档、配置 schema/运行消费者、slash 注册/dispatch/help/快捷键表、协议/adapter 镜像、聚焦验证；语义等价而非逐字翻译，单侧改须说明另一侧不适用。

## 9. 凭据、模型可控 IO 与外传｜❌
不记录/回显/持久化完整 API key、token、cookie、登录态。模型可控写入走 DSH 文件策略/沙箱/审批边界，或至少规范化路径限定工作区、防符号链接逃逸、默认不覆盖、限大小。URL 限允许协议，DNS 后拒回环/私网/链路本地/云元数据，重定向重检。截图/页面/文件/日志外传默认关，首启披露目标/数据类型/保留策略并获确认；CI 跑不可信 PR 不暴露 secrets/写凭据。

## 10. Git、工作树与发布安全｜❌
只暂存明确路径、不批量暂存全树；不 stash 藏他人改动，不在共享工作树切分支/重写状态；无授权不强制重置/批量检出/恢复/清理，不 commit/push/tag/release/发 review 评论。tag、包版本、发布说明、贡献者署名须与当前发布流程一致。

## 11. 模块求值顺序是行为｜⚠️
`FORCE_COLOR`、`NODE_ENV`、终端能力/环境变量可能于 import 求值读取；调 import 顺序、提前动态 import 或抽模块须证初始化先于首次求值，类型检查不足为证。

## 12. 共享状态必须有 owner｜⚠️/❌
共享模式记开启来源，off 只撤自身状态；renderer/context 可变状态归实例，不让多 Ink root 共享模块全局；跨会话/进程文件原子写、互斥、陈旧锁查 pid 存活；外连限消息/缓冲并统一销毁；read-only/mutate 分类符真实副作用，误标绕策略按 ❌。

## 13. 仓库范围与移植区纪律｜⚠️/❌
一 PR 一主题，拆出无关配置、上游同步树、在途实验、顺手修复；/mnt/shared/_Projects/DSH-TUI/repo/src/ink/、/mnt/shared/_Projects/DSH-TUI/repo/src/native-ts/、/mnt/shared/_Projects/DSH-TUI/repo/vendor/ 改动须聚焦、保来源、专用回归。纯 UI 装饰/外部插件/host API/协议先满足准入/spec，不因实现完成即入核心。越界到不可可靠审查/回滚按 ❌，少量可独立剔除 churn 按 ⚠️。
