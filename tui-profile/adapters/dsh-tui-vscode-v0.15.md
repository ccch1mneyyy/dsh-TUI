# Adapter Note — dsh-tui-vscode (VS Code companion) v0.15

**Status:** Draft / Experimental
**Spec version:** community-v0.15
**Host:** dsh-TUI 0.7.0+ / Cordis 4.x profile; VS Code Extension API ^1.90.0
**Plugin:** `com.baobaolaodie.dsh-tui-vscode` (pilot declaration)

## 定位

dsh-tui-vscode 是 dsh-TUI 的 VS Code companion 扩展。它在 dsh 生态里的角色是“启动/恢复 dsh-TUI 会话的入口提供者”，而不是一个独立的 Cordis 运行时插件。

本 Note 记录 TUI Profile v0.15 的 manifest 概念如何映射到该仓库现有实现，以及当前试点声明与规范之间的已知偏差。

## Contract 映射

| Community v0.15 概念 | dsh-tui-vscode 现状 |
| --- | --- |
| `facets.host.entry` | `out/extension.js`（VS Code 扩展入口；**非 dsh 宿主可执行入口**，见偏差 D-1） |
| `facets.host.apiVersion` | `v1alpha1`（试点值；尚未被 dsh-tui 运行时协商） |
| `requires.contracts` | `commands.dsh/v1alpha1` + `Command`（启动/恢复命令的声明） |
| `permissions` | `commands.invoke`（单条；scope 必须为已声明命令 id。多命令场景的授权覆盖语义仍在与宿主实现对齐，试点当前收敛为单命令 `.start`） |
| `contributes.commands` | 当前声明 `com.baobaolaodie.dsh-tui-vscode.start` |
| `subscriptions` | 无（当前不订阅 messages.observe 等事件） |
| Host Descriptor | 官方示例已发布：`registry/host-descriptor.tui.example.json`；dsh-TUI 已在运行时构建真实 descriptor 并于 2026-08-23 完成真实协商（见证据），离线复验工件仍待发布（见 D-2） |
| effect ledger | 本插件侧未接入；宿主侧效果台账与授权存储已上线（见 D-3） |

## 已知偏差

- **D-1 entry 不可被 dsh 直接加载**：`out/extension.js` 是 VS Code Extension Host 入口，不能由 dsh/Cordis 直接加载。当前 `dsh-plugin.json` 是“声明性试点”，不是可执行插件。
- **D-2 真实 Host Descriptor 已实测协商**：spec registry 尚无可离线复验的 descriptor 发布工件，但 dsh-TUI 已在运行时构建真实 descriptor；2026-08-23 经运行中 dsh-tui 0.8.8 的 `/plugins check` 完成协商 → **`compatible`**（见证据）。证据等级维持 `Declared` 的理由收窄为 D-1 与 D-3。
- **D-3 本插件侧未接入 effect ledger / lifecycle**：宿主侧生命周期实体已实现（C-060 效果台账、统一授权存储）；偏差收窄为本扩展作为 VS Code companion 未声明 activation instance、未接入宿主台账。
- **D-4 与 Cordis bundle 双轨并存**：实际可运行层仍是 `package.json` 的 `dsh.bundle` + `cordis.patch.yml`；`dsh-plugin.json` 是额外试点声明，两者尚未统一。
- **D-5 证据等级为 Declared**：manifest 已通过 dsh-std v0.15 schema + 语义校验，并对官方示例 Host Descriptor 与运行中真实宿主均协商出 **`compatible`**。但因 D-1 且无真实 activation instance，不能声称 `Tested` / `Verified`。

## 证据

- 仓库：<https://github.com/baobaolaodie/dsh-tui-vscode>（main @ `0952582`）
- `dsh-plugin.json`：该仓库根目录（试点声明）
- 上游 conformance 复核（2026-08-22，当时的 `dsh-ecosystem-spec` main HEAD `d406de4`，含 PR #5 官方校验入口；该仓库现为生态入口，profile 正文已内联到 dsh-TUI 的 `tui-profile/`）+ 固定 `vendor/dsh-std` @ `614dfa1`：
  - `npm run test:standalone` 全量 suite 退出码 0；
  - 官方入口 `npm run validate:manifest -- --manifest ./dsh-plugin.json --host registry/host-descriptor.tui.example.json` → `{"valid":true,"decision":"compatible","missingOptional":[]}`，exit 0。
- 宿主侧复核（2026-08-23）：headless 复刻 `/plugins check` 全链（parseManifest → projectManifest → createContractIndex(vendored) → validatePlugin → buildHostDescriptor → negotiate）→ semantic PASS + negotiate `compatible`；
- 真实宿主协商留档（2026-08-23）：运行中 dsh-tui 0.8.8，真实终端 `/plugins check` → **协商结果：compatible**，与 headless 预测一致。

## 上游演变跟踪

- **2026-08-18 命名空间迁移（PR #4）**：TUI 私有命名空间统一迁移为中性 `tui.dsh/*`，旧坐标不作隐式别名。本试点仅使用 std 的 `commands.dsh/v1alpha1#Command`，不受影响。
- **2026-08-21 官方单插件校验入口（PR #5）**：admission 算法抽为共用核心 `admission-core.js`，新增 `npm run validate:manifest` 一键复核本试点。
- **2026-08-21 「RFC 0009」（供应链事件响应）曾在 `dsh-ecosystem-spec` 以 PR #8 提议中**（历史记录）：该提案没有进入仓内 `notes/`（`notes/` 只到 `0008`），撤销注册表与准入清单的方向如需继续，应回到上游 [dsh-std](https://github.com/Yan-Zero/dsh-std) 或本仓 issue 重新提出；本 Note 仅作留档。
- **2026-08-18~22 README 门面重写**：生态可见性转由 tui 插件市场承担；规范本体同期零漂移（当时的 `dsh-ecosystem-spec` spec / registry / schemas / submodule 均未动）。
- **2026-08-23 dsh-TUI 主仓宿主侧落地确认**：`docs/plugins.md` 载明校验/协商库、Host Descriptor 构建、授权存储、效果台账与 `/plugins` 诊断面已落地；加载强制仍归 dsh CLI Loader。

## 收敛计划

1. 上游发布可离线复验的真实 Host Descriptor 工件后，补齐 `validate:manifest --host` 复现路径；
2. 多命令场景的授权覆盖语义进一步明确后，扩展 `contributes.commands` 与对应授权声明；
3. 等 Cordis 或 dsh loader 支持读取 `dsh-plugin.json` 作为包身份层；
4. 再决定 entry 是否需要改为独立的 Node/Cordis 入口；
5. 届时补 effect ledger 与 lifecycle 映射，并从 `Declared` 升级到更高证据等级。
