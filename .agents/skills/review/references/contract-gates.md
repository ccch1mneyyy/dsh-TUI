# dsh-TUI 契约门禁
真源为当前目标分支的 /mnt/shared/_Projects/DSH-TUI/repo/package.json、/mnt/shared/_Projects/DSH-TUI/repo/ADAPTER.md、/mnt/shared/_Projects/DSH-TUI/repo/src/dsh-adapter/contract.ts、/mnt/shared/_Projects/DSH-TUI/repo/src/plugin-host.ts、/mnt/shared/_Projects/DSH-TUI/repo/cordis.patch.yml、/mnt/shared/_Projects/DSH-TUI/repo/patch-surface.snapshot.json、/mnt/shared/_Projects/DSH-TUI/repo/dsh-ecosystem-spec/protocols/tui-channel.js、CI 及 /mnt/shared/_Projects/DSH-TUI/repo/docs/contributing.md。本文件仅检查顺序，不存日期化常量；契约变更缺兼容策略/迁移/验证默认阻断，新增公共面也须显审。

## 先生成结构化快照
执行顺序及命令以 /mnt/shared/_Projects/DSH-TUI/review/SKILL.md 阶段 0 为唯一真源。快照比较包清单的 version/packageManager/engines/imports/bin/exports/dependencies/peerDependencies/devDependencies/scripts，adapter contract、plugin-host shim、patch/snapshot、tui-channel、CI/治理文档摘要，shim exports 及可稳定提取的 apiVersion/wireRevision/features；只定位、不替代语义审查，动态写法解析不到须直接读源。

## 门 1｜npm 公共面与依赖身份
对照最新目标分支/head：exports 全 key 的 types/import/default/字符串目标、bin 名/入口、imports 别名、version/engines/packageManager、三类依赖的身份/范围。
阻断：export/bin 删除/改名/重定向无兼容垫片或迁移；版本/兼容线回退；宿主 peer 错作运行依赖导致双实例；运行/发布类型依赖的 `@deepseek-ai/*` 未依仓规同时镜像 peer+dev；新依赖未更唯一 lockfile或混入无关大重签；包声称与 tarball 不符。
读包清单真源并查 `verify:manifest-deps`、`verify:package`、适用 Bun 包验证，不只看 diff hunk。

## 门 2｜上游 import 边界
官方 `@deepseek-ai/*` import（含 `import type`）仅在当前权威 adapter 边界内，新目录不自动豁免。实跑或静态复核 `verify:boundary` 扫描范围；grep 仅定位，排除注释/字符串/安装说明后以真实模块指示符定案；同 PR 改脚本/允许目录/豁免须证未为实现放宽并同步权威文档；一处越界须横扫同目录/同型 import。

## 门 3｜上游兼容版本线
版本线代码真源是上列 adapter contract，镜像清单依当前贡献指南。bump 逐查 contract 常量/验证、peer/dev 范围、workspace/随包子项目及 lockfile、CI 上游固定 SHA/版本、verify 常量/patch snapshot、adapter 文档/用户文档/迁移。
阻断：镜像只改部分、保留上游已删包、降兼容范围未说明、普通依赖更新冒充契约验证。

## 门 4｜Cordis patch 与快照
上列 patch 的行 ID、顺序、insert/override/disabled 语义须与 snapshot 一致；单边变默认阻断，双边变须重跑生成路径证来自真实输入而非手改绿。生成器同改须先用旧生成器复算再审差异；上游版本变后须证 patch 可应用真实目标，不只比数字。

## 门 5｜机器消费协议与 plugin-host 公共面
**tui-channel**：从上列协议源提取 apiVersion/wireRevision/features、open/subscribe/invoke 等输入输出校验、已知字段/`x-*` 扩展/开放 state 边界；revision/features/字段/错误/握手变化须走 spec 治理并同步双端与验证，不以本仓单侧重定义协议。
**plugin-host**：公共 re-export shim，逐次提取最新目标分支/head 的全部类型 exports/签名来源、运行 exports、常量值/限额/超时/错误码、admission/extension/permission 坐标，不手抄固定数量。删除/改名/改签名或常量语义默认阻断，直到补版本、迁移、文档、契约测试。

## 门 6｜CLI、环境变量与脚本消费面
触及 /mnt/shared/_Projects/DSH-TUI/repo/bin/、环境变量、错误输出、退出码或非交互入口，逐路查 stdout/stderr 归属、机器格式、非交互默认值、flag/参数范围、退出码、脚本匹配的稳定错误文本、Windows/POSIX 实际入口与 quoting、launcher/TUI 参数职责重叠；任何变更均搜仓库脚本/文档/下游调用者，文案也可能是契约。

## 门 7｜特殊区域与验证门禁
- /mnt/shared/_Projects/DSH-TUI/repo/src/ink/、/mnt/shared/_Projects/DSH-TUI/repo/src/native-ts/：敏感移植设施，聚焦修改、专用渲染/终端回归，不批量格式化。
- /mnt/shared/_Projects/DSH-TUI/repo/vendor/：依当前子模块/vendored 规则，不混无出处手改。
- /mnt/shared/_Projects/DSH-TUI/repo/lib/：当前为生成物，出现 diff 先对照真源/贡献指南，不手改当源码。
- /mnt/shared/_Projects/DSH-TUI/repo/dsh-ecosystem-spec/：遵守自身治理。
- /mnt/shared/_Projects/DSH-TUI/repo/.github/workflows/、/mnt/shared/_Projects/DSH-TUI/repo/scripts/verify-*：查 permissions、不可信 PR 执行、fail-open、路径过滤、挂载链、坏基线。

## 门禁自修改的证明义务
实现及保护 gate 同改须列旧 gate 对坏实现结果、新 gate 扩大/收窄精确集合，以独立 oracle（判定依据）证未开后门、证 CI/聚合链实执行；fork 执行须无 secrets/写凭据、最小权限、隔离。脚本存在、名字进 `verify:build` 或 CI 绿均不足。
