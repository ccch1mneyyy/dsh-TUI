# 版本化部署（M0）

> 对应设计：`.local/design/deploy-transition.md`（S04/S05）。
> 本文是**已落地部分**的操作说明与边界声明，不是完整设计的复述。

## G0 门结论（PASS）

**Cordis host loader 可以经稳定 dispatcher/包 façade 选择代次。** 证据：
`scripts/g0-host-loader-spike.mjs`（可复跑，已登记 CI）用真实
`@deepseek-ai/cordis` + `@deepseek-ai/cordis-plugin-loader`（本仓
devDependencies 同版本）在 hoisted 布局的夹具 profile 上按包名加载
`@deepseek-harness-tui/dsh-tui`：

- loader 的 `EntryTree.import → unwrapExports → registry.plugin` 全链
  接受 TLA 门面（`dispatch/index.js`）——插件从被 pin 的 generation
  里 apply，entry config 由**代次自己的** Config schema 校验；
- lease 在代次首个模块求值之前就已落盘（夹具 dep.js 在模块求值期探测
  leases 目录证明时序）；
- 进程内翻转 `active.json` 不换活进程的代；新进程取新代；
- legacy（无 manifest）/ source（开发标记）/ fail-closed（坏哈希、缺代）
  三态全部按设计行为；internals 与普通 dynamic import 两条解析路径都
  验证过（本机 Node v24.13.0 上 loader 走 v2 internals 路径）。

两个实证中发现的硬边界（都已按设计处理）：

1. **Windows rename 共享冲突**：`MoveFileEx(REPLACE_EXISTING)` 在目标
   文件被并发读者打开（无 `FILE_SHARE_DELETE`）时返回 EPERM——dispatch
   读 manifest、deployctl status 都是这样的读者。`atomicWriteJson` 对
   EPERM/EBUSY 做有界重试（每次尝试本身原子，读者永远只见旧或新）。
2. **loader 的 baseUrl 必须是带尾斜杠的目录 URL**：少斜杠时 parentURL
   退化一级，包名解析锚点漂移（真实 dsh host 传的是目录 URL，不受影
   响；spike 夹具据此对齐）。

## 目录布局与生命周期

    <profile>/.dsh-tui/deploy/
      active.json            # 提交指针（schemaVersion 1）
      generations/<id>/      # 不可变代次
        READY.json           # 内部提交标志：整树哈希 + files 清单
        package/             # npm files 树（bin/dispatch/lib/assets/…）
        runtime-lock.json    # peer 面 + lockfile 指纹（如实标注
                             # providedByProfile——M0 不虚称 hermetic）
      generations/<id>.staging/   # 未提交构建，不可启动
      leases/<id>/<pid>-<nonce>.json
      build-locks/promote.lock
      history.json           # 运维日志（诊断用，非第二真源）

启动链（`dispatch/resolve.mjs`）：source 模式（realpath 带 `src/` +
`tsconfig.json` 开发标记＝Junction 开发轨）→ 跑本树 lib、无视
manifest；否则解析 deploy root → 读 active.json → 校验 READY 哈希 →
**先写 lease 再 dynamic import** 代次入口；无 manifest＝legacy 跑规范
包内容；**manifest 存在但坏＝fail closed**，绝不静默回 canonical。

## 操作命令

    # 从 detached 源码树构建一个代次（绝不写活动运行路径）
    node scripts/build-generation.mjs --deploy-root <profile>/.dsh-tui/deploy [--promote]

    # 状态 / 回滚（只改指针） / 安全 GC（默认 dry-run）
    node scripts/deployctl.mjs status   --profile <profileDir>
    node scripts/deployctl.mjs rollback --profile <profileDir> [--to <id>]
    node scripts/deployctl.mjs gc       --profile <profileDir> [--apply]

GC 永不动：active、回滚目标、有 live/ambiguous lease 的代、最新 N 代、
保留窗内的代。lease 三态：live（活 pid+新心跳）/ stale（死 pid）/
ambiguous（活 pid+旧心跳＝疑似 PID 复用，**保留不删**）。

## 构建隔离（同轨风险止血）

`scripts/clean-lib.mjs`（`pnpm compile` 的第一步）现在先过 live-tree
守卫：本树 realpath 是任何 profile junction 的当前指向时拒绝执行，给出
两条出路（detached worktree 构建代次 / 先摘 junction）。逃生口：
`DSH_TUI_ALLOW_LIVE_TREE_BUILD=1`（知情操作员显式声明）。

## M0 边界（明确不保证）

- 只有**主插件行**（包名入口）经 dispatcher；子路径行（oauth、
  working-activity、panels…）仍解析规范包——设计 M1 的非保证项
  （"所有外部 plugin entry 未必齐"），M2 收口。
- 运行依赖由 profile 的 hoisted node_modules 提供（dsh profile 模板
  `nodeLinker: hoisted`）；runtime-lock 如实记录身份，不做闭包锁定
  与健康检查（M2）。
- lease 判活用 pid+心跳；进程创建时间核验（防 PID 复用的强判活）留
  M2——ambiguous 即保留的保守侧已就位。
- S05 只做 MVE（已 flush 进度行 + 成功/崩溃/失败事件区分）；supervisor
  原子屏交接、first-frame ACK 是 M1。
- `compile:src` 的默认输出仍在开发树（设计阶段 3 的迁移点）；M0 守的
  是 clean 这个破坏性操作与代次构建的隔离。
