# feed/ — 嫡系插件清单（随包发布，一个版本钉死一份）

这个目录只有一份机器可读的清单：`first-party.json`。它回答一个问题——
**"这个包是不是我们自己发布的、并且是这一版钉住的那一个？"**

- **不是远程订阅**：没有运行时拉取、没有自动更新、没有增量/ETag。用户手上的清单
  = 他装的那个 dsh-tui 版本；清单变更 = 一次明确的**发版事件**（应出现在该版本的
  release notes 里）。
- **不是协议数据**：`tui-profile/registry/` 是准入协议的 registry（有 sha256 pin、
  受 `verify-plugin-spec` 管），这份清单是**包管理层的策展名单**，两者不互相引用。
- **随包发布由两处机器检查**：`package.json` 的 `files` 含 `tui-profile/feed`，
  且 `scripts/verify-package.mjs` 断言它真的在 `npm pack` 的名单里；门禁
  `scripts/verify-plugin-feed.ts` 还会在 `package.json` 的 `files` 里自查一次。

## 文件格式

```json
{
  "feedVersion": 1,
  "entries": [
    { "name": "@deepseek-harness-tui/dsh-tui", "scope": "@deepseek-harness-tui", "version": "0.18.0" }
  ]
}
```

| 字段 | 规则 |
|---|---|
| `feedVersion` | 只能是 `1`；格式变化要新取值，门禁据此拒绝未知取值（只增不删）。 |
| `entries[].name` | 完整包名（含 scope）。**精确匹配**才可能命中。`feedVersion: 1` 只收 **scoped** 包名——不带 scope 的名字没有可离线断言的发布者；将来真要收，是一次显式的格式决策（新 `feedVersion`）。 |
| `entries[].scope` | 期望发布者。带 scope 的名字必须与 `name` 的 scope **逐字一致**（门禁断言）；这是"离线可判的发布者"这一诉求的载体——npm 上 `@scope/...` 只能由该 scope 的持有者发布，所以精确的 scoped 包名本身就是发布者身份。 |
| `entries[].version` | **精确版本**，不接受范围（`^` / `~` / `*` / `||` / 空格一律门禁红）。 |

顶层与条目都**不接受未知字段**（`entires` 这种拼写错误会让清单静默变空）。

## 判定（运行时）

`src/dsh-adapter/plugin-feed.ts` 是唯一读取者，判定是**纯函数**：

- 命中（名字与版本都逐字相等）⇒ `first-party`；
- 其余一切情况 ⇒ `third-party`，四种原因：`no-feed`（清单缺失/损坏）、
  `unidentified`（spec 解析不出包名）、`not-listed`（清单里没有这个名字）、
  `version-mismatch`（版本不符，**包括 spec 没写版本**——"最新版"不是被钉住的那一个）。

**fail-closed 铁律**：拿不准一律按第三方处理（先确认信任再继续）。

## provenance（一票否决的缝）

`FirstPartyVerdict` 的 `first-party` 分支带一个 `corroboration: 'unavailable'` 字段。
本轮**没有任何在线校验**：宿主服务（`@deepseek-ai/dsh-plugin-manager`）的公开类型面
不含 provenance / publisher / attestation 任何一项，TUI 也没有网络客户端。判定只读
清单与 spec，不做任何网络访问。

语义（与[准入指南](../docs/plugin-admission-and-development.md)「供应链证据与
provenance」、[governance §5](../governance/rules.md) 同一口径）：

- **只否决不单独放行**：provenance **不得**替代清单条目，也不得替代用户确认——它只能
  用来*推翻*一次已经给出的判定。"嫡系"仍然只由这份清单的精确 `name@version` 决定。
- **不一致 ⇒ 降级**：将来某个来源能给出发布者身份或构建 provenance，且与清单条目
  **不一致**，必须把该次判定**降级为 `third-party`**（一票否决），而不是清除这个字段、
  也不是静默忽略。
- **缺席 ≠ 失败**：拿不到 attestation 只是"没有这一档 evidence"，不改变判定、不产生告警
  ——除非某次判定明确要求了 `attested`（今天没有这样的判定）。
- **将来接的来源**：npm registry 的 attestation 是缝可接的实证（生态侧已有包带
  `slsa.dev/provenance/v1`），但它只说明"这个 tarball 由哪个 builder 在哪次构建里产出"，
  不说明代码安全或作者可信；接入时**只加否决**，不引入"官方认证"口径。

## 怎么加一条

1. 确认该包确实是本团队（tui 团队）发布、且发布者 scope 与 `name` 一致；
2. 在 `entries` 里加 `{ name, scope, version }`（版本写将要发布的**精确版本**）；
3. 跑 `node scripts/verify-plugin-feed.ts` 与 `npm pack --dry-run --json --ignore-scripts | node scripts/verify-package.mjs`；
4. 在当期 `.github/release-notes/vX.Y.Z.md` 里写明清单变化（这是用户可见的发版内容）。
