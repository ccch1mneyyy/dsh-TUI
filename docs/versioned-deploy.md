# 版本化部署（M0–M2）

> 对应设计：`.local/design/deploy-transition.md`（S04/S05）。
> 本文是**已落地部分**的操作说明与边界声明，不是完整设计的复述。
> M0（dispatch/代次/lease/staging 构建/过场 MVE）→ M1（子路径统一代次、
> lease 强判活、原子屏交接+首帧 ACK、PTY 先行门）→ M2（runtime-lock 闭包
> 与健康检查、GC 完整化、compile:src 迁移）逐段叠加；各段回归都在
> scripts/run-ci-group.mjs 的 session-workspace 组。

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
    node scripts/deployctl.mjs health   --profile <profileDir> [--generation <id>]
    node scripts/deployctl.mjs rollback --profile <profileDir> [--to <id>]
    node scripts/deployctl.mjs gc       --profile <profileDir> [--apply]

GC 永不动：active、回滚目标、有 live/ambiguous lease 的代、最新 N 代、
保留窗内的代、活 owner 的 staging。lease 三态（M1 起强判活）：live（pid
活且**进程创建时间匹配**＝强 live，心跳过期也不再误判）/ stale（pid 死，
或 linux tick 身份证伪 PID 复用）/ ambiguous（探针不可用且心跳过期——
保留不删，绝不在「可能」上回收）。GC（--apply）同时回收已证死的 crash
lease 文件与「过 TTL 且 owner 判死」的 staging（staging 根带 .owner.json
印章，M2②）。

runtime-lock（M2①）：构建时从 **profile 根**解析运行闭包——每个运行
依赖与 peer 记录 version+package.json 字节指纹；bundled workspace 包
（@dsh-std/*、mathjax vendor）随包树发布只记 bundled；profile 缺的包如
实 found:false。闭包物理上仍由 profile 提供（providedByProfile 仍为
true——这是身份锁定，不是 hermetic）。健康检查（deployctl health）把
记录与现状逐条 diff：healthy / drifted（升级、消失、构建后才出现，逐条
点名）/ degraded（锁坏），非 healthy 退出码 1。

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

## M1/M2 增补

### 子路径统一代次（M1②）

package.json 的**所有**代码子路径（working-activity、oauth、workspaces、
command-trees、settings-sections、scenes、panels、plugin-host、extensions、
api、jsx-runtime、invariant）的 import/default 一律指向 dispatch/<名>.js
门面：与主入口共享同一进程 pin（lease 先行、一代一进程），Cordis 子路径
行不可能与运行中的主插件混代。source/legacy 模式仍取规范内容，行为与
迁移前逐字节一致；代次缺入口时 fail closed 并给可行动错误。
types 仍指规范 d.ts——门面模式的固有静态/运行时分离，与主入口同款。

### lease 强判活（M1③）

lease 落盘自带 processStartIdentity：linux 为 /proc/<pid>/stat 的
starttime tick（boot 相对、精确——不匹配即可证 PID 复用，判 stale）；
win32 用 CIM 数字探针（一次批查询、locale 免疫）比对 wall-clock 起点
（容差 2.5s；不匹配只降级不判死——时钟步进可造成假差，fail-safe）。
匹配即 live(strong)：心跳写失败（磁盘满等）不再把活进程误判 ambiguous。

### 原子屏交接 + 首帧 ACK（M1①，S05 完整版落点）

不引入独立 supervisor 进程（设计允许"先由 profile bin 完整逻辑实现"，
独立 daemon 留给"必须 detached"的场景）：fullscreen 内核切换时**旧 TUI
进程即 supervisor**——

- 切换分支的 finishExit 不写 1049l（keepAltScreen）：清屏归位后过场文案
  写进 alt buffer，用户全程停留同一块屏；inline 会话与 /restart、/update、
  safe recovery 保持 MVE 契约不变；
- replacement 以 stdio[3] ACK 管道回报：adopted（AlternateScreen 挂接，
  不再写第二个 1049h）→ ready（**首帧 write 的 flush 回调**——不是 root
  mount、不是进程存在、不是 4 秒计时）；ready ACK 送达即 1049 括号所有
  权移交，此后新实例自己闭合，全链路恰好一次；
- ready 前死亡（含 spawn 失败、不说话协议的旧版 replacement）由旧父收
  口：先退 1049 回主屏再落失败文案；结局分类以首帧事实取代 4 秒窗
  （flush 过＝post-boot；没 flush＝boot-failure，无论多久）；
- PTY/ConPTY 先行门（scripts/verify-handoff-pty-gate.mjs）：在真实 PTY
  下跑完整链，断言 1049h/l 各恰一次、闭合晚于首帧、旧父 spawn 前后
  stdin 零 reader、replacement 的 TTY facade；provider 自动选择
  node-pty（含 master 侧 DA1 应答器，探测往返可断言）→ POSIX script →
  pipe 回退（设备级断言显式 note）。

### compile:src 迁移（M2③，阶段 3 迁移点）

compile:src 默认输出 .local/build/<fingerprint>/package（镜像 npm files
布局），原子写 .local/build/source-pointer.json；dispatch source 模式优
先按指针解析（陈旧/越界/损坏指针一律退回规范 lib，不报错）。Junction
开发轨的 compile:src 循环不再写树内 lib。逃生口 --in-tree /
DSH_TUI_COMPILE_SRC_IN_TREE=1＝逐字节旧契约。

## 边界（M2 后明确不保证）

- 独立 supervisor/daemon 进程、透明 PTY relay 未实施（设计允许的阶段
  形态；设备级保真由先行门覆盖，未证明前不上 relay）。
- runtime-lock 锁的是**身份**：闭包仍由 profile 提供，profile 升级可致
  drifted（health 显影）；不做 boot 时硬拒绝。
- compile（vendor+clean+tsc+settings 全链）仍写树内 lib（带 M0 live-tree
  守卫）；阶段 3 的"compile/build 全面 staging 化"留给发布轨全面切换。
- staging 无 READY 时不可启动、generation 不可变、回滚只改指针——这些
  M0 契约不变。
