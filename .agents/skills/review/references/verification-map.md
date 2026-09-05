# dsh-TUI 验证映射
先读当前 package.json 的 scripts、.github/workflows/ci.yml、脚本头部、docs/contributing.md；本表仅选择方法，漂移依仓库真源并记报告。

## 禁止虚构
根级 test/lint 禁令以 SKILL.md “全局不变量与模式”为唯一真源。scripts/ 混有回归/复现/探针/迁移/取证，不全目录当测试跑；跑前读头部辨 import src/ 或 lib/types/、普通 `node` 或 `node --import tsx/esm`；只记实跑命令/退出码/SHA/关键输出，不将应通过写成已通过。

## 最小通用关口
源码改动先从当前 scripts 核 `pnpm compile`、`pnpm verify:build`、`pnpm verify:package`、`pnpm verify:bun-package`（仅 scripts/CI 仍定义时）的存在及真实组成，不机械全跑；纯文档/workflow/YAML 依贡献指南分流，verify:build 按编译依赖链顺序。`pnpm build` 通常聚合 compile/门禁，须展开真实结果、不重复计独立证据；required checks/平台 job 从当前 CI 提取，不手抄旧表。

## 改动面 → 验证类别
| 改动面 | 至少核对 |
|---|---|
| package exports/bin/dependencies | manifest gate、clean compile、package tarball、入口 smoke、Bun 目标（若适用） |
| adapter import 或上游版本 | boundary、contract、manifest-deps、alpha/source/patch/web coexistence 等当前镜像门禁 |
| cordis.patch.yml | patch-surface 复算、真实上游应用语义 |
| session/channel submit/steer/pending | 对应 channel 聚焦脚本、恢复/rewind/fork 与事件白名单 |
| compaction/transcript folding | compact、session switch、resume 与行投影回归 |
| Chat/按键/模态优先级 | keymap、受影响 modal、输入草稿、help/overlay 让位与泄漏 |
| 共享渲染、消息列表、工具卡 | 当前 CI UI 回归、scroll/resticky、窄终端、inline/fullscreen |
| ask/question/approval | askpanel、layout、abort/consumed、真实 store 快照 |
| theme/i18n | theme runtime/persistence、i18n key/type、双语文档和环境固定 |
| Ink/Yoga/滚动/命中测试 | renderer 专用 verify/repro、resize、selection、pointer、真实终端/伪终端 |
| Windows/POSIX 路径、spawn、socket | 平台 job、含空格路径、UTF-8 byte 预算、权限位守卫、Windows 实机 |
| update/download/archive | checksum、redirect/DNS、检查与使用间竞态、symlink、原子替换、平台资产 |
| plugin/extension/admission | spec、grants、storage、messages、ledger、commands、negotiation、lifecycle 当前门禁 |
| workflow/CI gate | actionlint/zizmor（若仓库采用）、permissions、fork trust、fail-open、路径过滤、required-check 聚合 |
| 维护技能 .agents/skills/ | frontmatter、相对引用、脚本 self-test、不入 npm package files |

具体脚本名从上列当前包清单/贡献指南搜索，不按表猜。

## 选择算法
依次：diff 列行为/owner/公共契约/用户可见面 → 各找最近已有回归 → 核 CI/聚合调用或明本地补证 → 先最小聚焦，再依失败/风险扩大聚合 → 终端可见/平台敏感补真实演练（无头绿不足）→ 报告分静态证明/自动回归/人工演练/未执行。

## 不可信 fork 执行门
本节是 fork 执行门唯一真源：head 任意命令可能执行贡献者改过的 package lifecycle/scripts、verify/repro、编译插件/loader、workspace/link 依赖、CI helper。默认静态；须用户明确许可，隔离工作树/容器，无仓库 secrets/云凭据/SSH agent/浏览器 cookie，只用最小只读凭据或无凭据，限网络/CPU/内存/磁盘/时间，不挂敏感 HOME，先审 package lifecycle 与脚本 diff 再跑。

## 反假绿检查
### 坏基线
回归须在未修实现失败；优先隔离树反向 patch、最小故障注入破被保护不变量、对照最新目标分支/明确坏 commit；不改坏共享树、不破坏性 reset 回滚。

### 独立 oracle
oracle（判定依据）不以实现同 helper 算 expected、不复制实现或同源自比；不恒真/只验符号字符串存在、不用本地化文案/随机内容/宽松子串替结构断言；事件/exports/features 白名单直比官方/目标全集；渲染用稳定区/语言无关哨兵；异步轮询不变量/事件，不固定 sleep 碰运气。

### 真实路径
按脚本设计 import 上列真实源码或干净构建产物，走真实 registration/open/subscribe/dispose；mock 仅替不可控外部边界且形状符当前上游类型；读写隔离临时目录、恢复 env/listener。

### CI 挂载
脚本存在不证保护：须 package script/workflow 实引、路径过滤不误跳、上游 failed/cancelled/空输出时聚合 fail-closed、最新 head checks 非空且符当前 SHA。

## Deslop apply 验证
前后验证编排唯一真源为 SKILL.md 阶段 6，命令仍依本表；删除测试/门禁不算清理，须先证独立覆盖仍在。

## 报告记录模板
| 命令/核验 | 类型 | SHA | 结果 | 说明 |
|---|---|---|---|---|
| `...` | static / regression / manual | `...` | exit / pass / fail / blocked | 失败归因、环境、覆盖不变量 |

静态确定的阻断机制直接报告，不藏“建议补跑测试”；测试用来证明影响/修复。
