/**
 * The Codex backend's own copy (B-5): every string this backend puts on
 * screen, in the languages the TUI ships, keyed as the host dictionary
 * happened to key them so the move stayed reviewable.
 *
 * Why a backend carries its own text (D2): the host's dictionary
 * (`src/i18n.ts`) is not readable from a backend, and a plugin must not be
 * able to pass itself off as first-party copy. The shape and the rule
 * (`{{name}}` placeholders) are shared
 * (`src/backends/shared/localized-text.ts`), so the mechanism cannot drift.
 * The shared type also allows the `one`/`other` plural pair; no codex string
 * uses it (counted: no `t()` call passes `count`), so this backend carries no
 * plural selectors, unlike claude.
 *
 * The language is read live from the host (`BackendHost.locale`), installed by
 * `detect()`/`open()`: a `/lang` switch applies to the next string, exactly
 * as `t()` behaved. Before either runs there is no host to ask, and the
 * fallback is `zh` — the same last-resort default `src/i18n.ts` documents for
 * its own resolution order.
 */
import type { BackendLocale } from '../../agent/backend.js'
import type { ElicitationText } from '../shared/elicitation.js'
import { fillTemplate, type LocalizedText, type TextParams } from '../shared/localized-text.js'
import { pickPlatformText } from '../shared/platform-text.js'

/**
 * Every string of this backend. `zh` and `en` are both required
 * (`scripts/verify-i18n.ts` checks the same invariants the host dictionary
 * gets: language completeness, placeholder parity and single-brace typos).
 */
const texts = {
  // ── Approvals, notices, status lines and control answers ──
  'codex-approve-accept': { zh: '是，执行', en: 'Yes, proceed' },
  'codex-approve-decline': { zh: '否，跳过它继续', en: 'No, continue without running it' },
  'codex-approve-cancel': { zh: '否，并告诉 Codex 怎么做', en: 'No, and tell Codex what to do differently' },
  'codex-approve-decline-files': { zh: '否，不应用这些改动，继续', en: 'No, continue without these changes' },
  'codex-approve-grant-turn': { zh: '是，本回合授予这些权限', en: 'Yes, grant these permissions for this turn' },
  'codex-approve-deny-permissions': { zh: '否，不授予权限继续', en: 'No, continue without permissions' },
  'codex-approve-stdin-name': { zh: '终端输入', en: 'Terminal input' },
  'codex-approve-stdin': { zh: '向运行中的终端写入输入', en: 'writes input to a running terminal' },
  'codex-approve-network-context': { zh: '访问网络主机 {{host}}（{{protocol}}）', en: 'network access to {{host}} ({{protocol}})' },
  'codex-approve-extra-permissions': { zh: '额外权限：{{what}}', en: 'extra permissions: {{what}}' },
  'codex-approve-cwd': { zh: '在 {{cwd}} 中运行', en: 'runs in {{cwd}}' },
  'codex-approve-prefix': { zh: '是，以后以 `{{prefix}}` 开头的命令不再询问', en: 'Yes, and don\'t ask again for commands that start with `{{prefix}}`' },
  'codex-approve-session-command': { zh: '是，本会话内此命令不再询问', en: 'Yes, and don\'t ask again for this command in this session' },
  'codex-approve-session-files': { zh: '是，本会话内这些文件不再询问', en: 'Yes, and don\'t ask again for these files' },
  'codex-approve-session-permissions': { zh: '是，本会话内都授予这些权限', en: 'Yes, grant these permissions for this session' },
  'codex-approve-network': { zh: '是，以后允许访问 {{host}}', en: 'Yes, and allow {{host}} in the future' },
  'codex-permissions-name': { zh: '额外权限', en: 'Extra permissions' },
  'codex-perm-network': { zh: '联网', en: 'network' },
  'codex-perm-read': { zh: '读取 {{paths}}', en: 'read {{paths}}' },
  'codex-perm-write': { zh: '写入 {{paths}}', en: 'write {{paths}}' },
  'codex-declined': { zh: '已拒绝', en: 'Declined' },
  'codex-interrupted': { zh: '已中断', en: 'Interrupted' },
  'codex-tool-failed': { zh: '执行失败', en: 'Failed' },
  'codex-tool-unfinished': { zh: '回合结束时仍未完成', en: 'Unfinished when the turn ended' },
  'codex-turn-failed': { zh: '回合失败', en: 'The turn failed' },
  'codex-turn-start-failed': { zh: 'Codex 没有接受这条消息：{{err}}', en: 'Codex did not take this message: {{err}}' },
  'codex-steer-fallback': { zh: '当前回合无法插话，这条消息会在回合结束后发送', en: 'The running turn cannot take this message now; it will be sent when the turn ends' },
  'codex-cancel-forced': { zh: '中断 15 秒未得到确认，已在本地结束本回合', en: 'The interrupt was not confirmed within 15s; the turn was closed here' },
  'codex-session-closed': { zh: 'Codex 会话已关闭', en: 'The Codex session is closed' },
  'codex-retrying': { zh: '请求失败，Codex 正在重试：{{message}}', en: 'The request failed; Codex is retrying: {{message}}' },
  'codex-rerouted': { zh: '模型已由 {{from}} 改为 {{to}}（{{reason}}）', en: 'The model was rerouted from {{from}} to {{to}} ({{reason}})' },
  'codex-system-error': { zh: 'Codex 报告该会话出现系统错误', en: 'Codex reported a system error on this thread' },
  'codex-review-start': { zh: '开始代码审查：{{review}}', en: 'Code review started: {{review}}' },
  'codex-auto-review-started': { zh: '自动审查中…', en: 'Auto-review in progress…' },
  'codex-auto-review-approved': { zh: '自动审查：已批准', en: 'Auto-review: approved' },
  'codex-auto-review-denied': { zh: '自动审查：已拒绝', en: 'Auto-review: denied' },
  'codex-auto-review-ended': { zh: '自动审查已结束', en: 'Auto-review ended' },
  'codex-strict-review': { zh: '本回合之后的命令需要先通过审查', en: 'Further commands in this turn need a review first' },
  'codex-hook-started': { zh: 'hook {{event}} 运行中…', en: 'Hook {{event}} running…' },
  'codex-hook-done': { zh: 'hook {{event}} 完成 {{duration}}', en: 'Hook {{event}} finished {{duration}}' },
  'codex-hook-failed': { zh: 'hook {{event}} 失败 {{duration}}', en: 'Hook {{event}} failed {{duration}}' },
  'codex-mcp-failed': { zh: 'MCP 服务器 {{name}} 启动失败：{{error}}', en: 'The MCP server {{name}} failed to start: {{error}}' },
  'codex-thread-closed': { zh: '该会话已在别处关闭，仍可继续对话', en: 'This thread was closed elsewhere; you can keep talking' },
  'codex-thread-archived': { zh: '该会话已在别处归档，仍可继续对话', en: 'This thread was archived elsewhere; you can keep talking' },
  'codex-thread-deleted': { zh: '该会话已在别处删除', en: 'This thread was deleted elsewhere' },
  'codex-rate-limit-reached': { zh: '已达到 Codex 用量上限（{{kind}}）', en: 'The Codex usage limit is reached ({{kind}})' },
  'codex-hint-unauthorized': { zh: 'Codex 凭据无效或已过期：在终端运行 codex login 重新登录', en: 'The Codex credential is invalid or expired: sign in again with `codex login` in a terminal' },
  'codex-hint-context': { zh: '上下文已满：可以用 /compact 压缩后继续', en: 'The context is full: run /compact and continue' },
  'codex-hint-limit': { zh: '已达到用量上限，稍后再试', en: 'A usage limit is reached; try again later' },
  'codex-hint-sandbox': { zh: '沙箱出错：Linux 上请安装 bubblewrap（例如 apt install bubblewrap）', en: 'Sandbox error: on Linux install bubblewrap (e.g. apt install bubblewrap)' },
  'codex-connection-lost': { zh: 'Codex 进程退出，正在重连…', en: 'The Codex process exited; reconnecting…' },
  'codex-connection-failed': { zh: 'Codex 进程无法启动：{{err}}', en: 'The Codex process cannot start: {{err}}' },
  'codex-connection-dead': { zh: '连接已断开且无法恢复，请重新打开会话', en: 'The connection is gone for good; please reopen the session' },
  'codex-reconnected': { zh: '已重新连接 Codex', en: 'Reconnected to Codex' },
  'codex-not-installed': { zh: '未找到 codex：npm i -g @openai/codex 或 brew install codex，或设置 CODEX_EXECUTABLE', en: 'codex was not found: npm i -g @openai/codex or brew install codex, or set CODEX_EXECUTABLE' },
  'codex-too-old': { zh: 'codex {{version}} 太旧（至少 {{min}}）：请升级', en: 'codex {{version}} is too old (needs {{min}}): please upgrade' },
  'codex-auth-missing-hint': { zh: '未检测到 Codex 凭据：启动后用 /login 登录，或设置 OPENAI_API_KEY', en: 'No Codex credential found: sign in with /login after start, or set OPENAI_API_KEY' },
  'codex-start-failed': { zh: 'Codex app-server 启动失败：{{err}}', en: 'The Codex app-server failed to start: {{err}}' },
  'codex-open-failed': { zh: '无法打开 Codex 会话：{{err}}', en: 'Could not open the Codex thread: {{err}}' },
  'codex-thread-busy': { zh: 'Codex 会话 {{id}} 正被另一个 Codex 进程使用，先关闭那边再打开', en: 'The Codex thread {{id}} is in use by another Codex process; close it there first' },
  'codex-resume-not-found': { zh: '找不到 Codex 会话 {{id}}（{{err}}）', en: 'The Codex thread {{id}} was not found ({{err}})' },
  'codex-version-drift': { zh: 'codex {{version}} 未经本版 dsh-tui 验证（已验证：{{validated}}），继续运行', en: 'codex {{version}} is not validated with this dsh-tui (validated: {{validated}}); continuing' },
  'codex-doctor-cli': { zh: 'Codex CLI: {{path}}（{{source}}）· 版本 {{version}}', en: 'Codex CLI: {{path}} ({{source}}) · version {{version}}' },
  'codex-doctor-home': { zh: 'Codex 主目录: {{home}}', en: 'Codex home: {{home}}' },
  'codex-doctor-thread': { zh: 'Codex 会话: {{id}} · provider {{provider}} · 模型 {{model}}', en: 'Codex thread: {{id}} · provider {{provider}} · model {{model}}' },
  'codex-doctor-mode': { zh: '权限模式: {{mode}}', en: 'Permission mode: {{mode}}' },
  'codex-doctor-bubblewrap': { zh: '未找到 bubblewrap：Codex 改用自带沙箱；建议用系统包管理器安装 bubblewrap', en: 'bubblewrap was not found: Codex uses its bundled sandbox; installing bubblewrap from the system package manager is recommended' },
  'codex-mode-read-only': { zh: '只读', en: 'Read Only' },
  'codex-mode-read-only-desc': { zh: '只读取文件；命令和修改需审批', en: 'Read files; commands and changes require approval' },
  'codex-mode-auto': { zh: '默认', en: 'Default' },
  'codex-mode-auto-desc': { zh: '可修改工作区；工作区外和网络操作需审批', en: 'Edit the workspace; ask before outside-workspace or network access' },
  'codex-mode-full-access': { zh: '完全访问', en: 'Full Access' },
  'codex-mode-full-access-desc': { zh: '关闭沙箱和审批，仅通过显式选择进入', en: 'Disable sandbox and approvals; explicit selection only' },
  'codex-mode-plan': { zh: '计划', en: 'Plan' },
  'codex-mode-plan-desc': { zh: '先调研和规划，保留当前权限档', en: 'Research and plan, preserving the current permissions' },
  'codex-mode-invalid': { zh: '未知 Codex 模式：{{mode}}', en: 'Unknown Codex mode: {{mode}}' },
  'codex-settings-deferred': { zh: '当前 Codex 版本不支持即时改设置，选择将在下一回合生效', en: 'This Codex version cannot update idle settings; your choices apply on the next turn' },
  'codex-capability-unavailable': { zh: '当前 Codex 版本不支持 {{feature}}，请升级', en: 'This Codex version does not support {{feature}}; please upgrade' },
  'codex-effort-none': { zh: '无', en: 'None' },
  'codex-effort-minimal': { zh: '极低', en: 'Minimal' },
  'codex-effort-low': { zh: '低', en: 'Low' },
  'codex-effort-medium': { zh: '中', en: 'Medium' },
  'codex-effort-high': { zh: '高', en: 'High' },
  'codex-effort-xhigh': { zh: '极高', en: 'Extra high' },
  'codex-effort-ultra': { zh: '超高', en: 'Ultra' },
  'codex-command-idle': { zh: '请先结束或中断当前回合', en: 'Finish or interrupt the current turn first' },
  'codex-command-review': { zh: '审查未提交改动、分支、提交或自定义范围', en: 'Review working changes, a branch, a commit, or custom instructions' },
  'codex-command-diff': { zh: '显示最近回合的文件差异', en: 'Show the latest turn\'s file diff' },
  'codex-command-plan': { zh: '切换到 Plan 模式，可附带提示词', en: 'Enter Plan mode, optionally with a prompt' },
  'codex-command-usage': { zh: '查看 Codex 额度和重置时间', en: 'Show Codex usage limits and reset times' },
  'codex-diff-empty': { zh: '没有文件差异', en: 'No file differences' },
  'codex-usage-window': { zh: '{{name}}：已用 {{used}}% · 重置 {{reset}}', en: '{{name}}: {{used}}% used · resets {{reset}}' },
  'codex-usage-credits': { zh: '额度余额 {{balance}} · 不限量：{{unlimited}}', en: 'Credits {{balance}} · unlimited: {{unlimited}}' },
  'codex-usage-unavailable': { zh: '当前 provider 未提供额度信息', en: 'The current provider supplies no usage-limit information' },
  'codex-yes': { zh: '是', en: 'yes' },
  'codex-no': { zh: '否', en: 'no' },
  'codex-question-auto-answered': { zh: '问卷等待超时，已按服务端设置选择默认答案', en: 'The question timed out; the server\'s default answer was selected' },
  'codex-plan-implement': { zh: '要实施这个计划吗？', en: 'Implement this plan?' },
  'codex-plan-yes': { zh: '是，实施这个计划', en: 'Yes, implement this plan' },
  'codex-plan-clear': { zh: '是，清空上下文后实施', en: 'Yes, clear context and implement' },
  'codex-plan-stay': { zh: '否，留在 Plan 模式', en: 'No, stay in Plan mode' },
  'codex-plan-action-failed': { zh: '无法开始实施计划：{{error}}', en: 'Could not start implementing the plan: {{error}}' },
  'codex-bwrap-warning': { zh: '未找到 bubblewrap，沙箱命令可能失败。请安装（如 apt install bubblewrap），或在 /permission 中明确选择完全访问', en: 'bubblewrap was not found; sandboxed commands may fail. Install it (e.g. apt install bubblewrap), or explicitly select Full Access in /permission' },
  'codex-model-waiting': { zh: '等待模型响应…', en: 'Waiting for the model…' },
  'codex-model-stalled': { zh: '模型长时间无响应，可按 Esc 中断', en: 'The model has not responded for a long time; press Esc to interrupt' },
  'codex-working-command': { zh: '运行 {{command}}', en: 'Running {{command}}' },
  'codex-working-files': { zh: '编辑 {{files}}', en: 'Editing {{files}}' },
  'codex-working-subagents': { zh: '等待子代理', en: 'Waiting for subagents' },
  'codex-working-thinking': { zh: '思考中…', en: 'Thinking…' },
  'codex-channel-url-required': { zh: '渠道连接缺少 base URL，请用 /channel 配置', en: 'The channel connection has no base URL; configure it with /channel' },
  'codex-channel-token-missing': { zh: '渠道 {{name}} 缺少可用令牌，请用 /channel 补充', en: 'Channel {{name}} has no usable token; add one with /channel' },
  'codex-channel-store-unavailable': { zh: '宿主未提供渠道令牌库，无法保存令牌', en: 'The host did not provide a channel token store; the token cannot be saved' },
  'codex-channel-token-write-failed': { zh: '渠道令牌保存失败，连接未更新', en: 'The channel token could not be saved; the connection was not updated' },
  'codex-auth-login-needed': { zh: 'Codex 需要凭据：用 /login 登录', en: 'Codex needs credentials: sign in with /login' },
  'codex-provider-env-key-missing': { zh: 'provider {{provider}} 缺 {{env}}：Codex 会拒绝每个回合；导出它或写进 ~/.dsh/.credentials.yaml', en: 'Provider {{provider}} is missing {{env}}: Codex rejects every turn. Export it or store it in ~/.dsh/.credentials.yaml' },
  'codex-auth-refresh-failed': { zh: 'ChatGPT 订阅令牌刷新失败，已停止注入；用 /login 重新登录，或使用自己的 Codex 登录', en: 'The ChatGPT subscription token refresh failed; injection stopped. Use /login again or your own Codex login' },
  'codex-auth-login-failed': { zh: 'Codex 登录未完成，已停止托管令牌注入；请用 /login 重试', en: 'Codex login did not complete; managed token injection stopped. Retry with /login' },
  'codex-auth-claims-missing': { zh: '内置 OAuth 令牌缺少 ChatGPT 账户信息，未注入；请用 /login 重新登录', en: 'The built-in OAuth token has no ChatGPT account identity and was not injected; sign in again with /login' },
  'codex-auth-source-channel': { zh: '凭据来源：渠道 {{name}}', en: 'Credential source: channel {{name}}' },
  'codex-auth-source-oauth': { zh: '凭据来源：dsh-auth ChatGPT 订阅', en: 'Credential source: dsh-auth ChatGPT subscription' },
  'codex-auth-source-native': { zh: '凭据来源：Codex 自己的登录', en: 'Credential source: Codex native login' },
  'codex-auth-source-api-key': { zh: '凭据来源：API key', en: 'Credential source: API key' },
  'codex-auth-source-missing': { zh: '凭据来源：未登录', en: 'Credential source: not signed in' },
  'codex-auth-source-unknown': { zh: '凭据来源：由 Codex 配置管理（无法确定）', en: 'Credential source: managed by Codex configuration (unknown)' },
  'codex-auth-plan': { zh: '订阅：{{plan}}', en: 'Subscription: {{plan}}' },
  'codex-auth-host': { zh: 'Provider 主机：{{host}}', en: 'Provider host: {{host}}' },
  'codex-auth-route-blocked': { zh: '当前路由不接受内置订阅令牌；请使用自己的 Codex 登录或 /channel 渠道', en: 'This route does not accept built-in subscription tokens; use your own Codex login or /channel' },
  'codex-auth-channel-active': { zh: '当前使用渠道凭据；请在 /channel 管理连接，不改动 OpenAI 登录', en: 'Channel credentials are active; manage the connection in /channel without changing OpenAI login' },
  'codex-auth-api-key-required': { zh: '请输入非空 API key', en: 'Enter a non-empty API key' },
  'codex-login-choose': { zh: '选择 Codex 登录方式', en: 'Choose a Codex sign-in method' },
  'codex-login-oauth': { zh: '内置 ChatGPT OAuth', en: 'Built-in ChatGPT OAuth' },
  'codex-login-oauth-desc': { zh: '复用 dsh-auth 登录，只向第一方路由提供内存令牌', en: 'Use dsh-auth; supply in-memory tokens only to first-party routes' },
  'codex-login-device': { zh: 'Codex 设备码登录', en: 'Codex device-code login' },
  'codex-login-device-desc': { zh: '在浏览器输入设备码，凭据由 Codex 保存', en: 'Enter a device code in a browser; Codex stores the credential' },
  'codex-login-api-key': { zh: 'API key', en: 'API key' },
  'codex-login-api-key-prompt': { zh: '输入 OpenAI API key', en: 'Enter an OpenAI API key' },
  'codex-login-api-key-storage': { zh: '此方式会把 API key 写入用户的 Codex 凭据存储', en: 'This method writes the API key into your Codex credential store' },
  'codex-login-device-code': { zh: '在验证页面输入设备码：{{code}}', en: 'Enter this device code on the verification page: {{code}}' },
  'codex-login-device-wait': { zh: '等待浏览器授权完成；可取消此次登录', en: 'Waiting for browser authorization; you can cancel this login' },
  'codex-login-cancel': { zh: '取消此次登录', en: 'Cancel this login' },
  'codex-login-success': { zh: 'Codex 登录已完成', en: 'Codex sign-in completed' },
  'codex-goal-usage-limited': { zh: 'Codex 用量额度已达到上限', en: 'The Codex usage limit was reached' },
  'codex-goal-budget-limited': { zh: '目标的 token 预算已用尽', en: 'The goal token budget was exhausted' },
  'codex-goal-blocked': { zh: 'Codex 目标暂时受阻', en: 'The Codex goal is blocked' },
  'codex-tasks-unsupported': { zh: '此 Codex 不支持后台终端监控，任务能力已关闭', en: 'This Codex does not support background terminal monitoring; task controls are unavailable' },
  'codex-terminal-ended': { zh: '终端已不在运行列表中；退出状态不可用', en: 'The terminal is no longer running; exit status is unavailable' },
  'codex-terminal-stopped': { zh: '后台终端已停止', en: 'The background terminal was stopped' },
  'codex-terminal-no-output': { zh: '此后台终端暂没有可读取的输出', en: 'No readable output is available for this background terminal' },
  'codex-side-open-failed': { zh: '无法创建临时旁问会话', en: 'Could not create the ephemeral side-question thread' },
  'codex-images-too-many': { zh: 'Codex 一条消息最多接受 {{n}} 张图片', en: 'Codex accepts at most {{n}} images per message' },
  'codex-image-type-refused': { zh: '图片 {{name}} 的格式 {{type}} 不受 Codex 支持', en: 'Image {{name}} uses {{type}}, which Codex does not accept' },
  'codex-image-unreadable': { zh: '无法读取图片 {{name}}', en: 'Image {{name}} could not be read' },
  'codex-image-too-large': { zh: '图片 {{name}} 超过 Codex 的 {{mb}} MiB 限制', en: 'Image {{name}} exceeds the Codex {{mb}} MiB limit' },
  'codex-images-too-large': { zh: '本条消息的图片总大小超过 {{mb}} MiB', en: 'The message images exceed {{mb}} MiB in total' },
  'codex-image-dimensions-refused': { zh: '图片 {{name}} 超过 {{px}} 像素限制，请缩小后重试', en: 'Image {{name}} exceeds the {{px}} pixel limit; resize it and retry' },
  'codex-history-fetch-failed': { zh: 'Codex 更早历史连续读取失败，暂时停止预取；可重新打开会话后重试', en: 'Earlier Codex history could not be read after three attempts; reopen the session to retry' },
  'codex-preview-image': { zh: '[图片]', en: '[Image]' },
  'codex-archive-busy': { zh: '该 Codex 会话由活动中的内部任务使用，暂时无法归档', en: 'This Codex thread is owned by an active internal worker and cannot be archived yet' },
  'codex-orphan-request': { zh: '无法确定 Codex 子代理请求所属会话，已取消该请求', en: 'Could not find the session owning a Codex subagent request; the request was cancelled' },
  'codex-channel-url-invalid': { zh: '渠道 URL 只接受 HTTPS（HTTP 仅限 localhost/127.0.0.1），不能含账号密码、查询串、片段或疑似密钥路径', en: 'A channel URL must use HTTPS (HTTP only on localhost/127.0.0.1), without userinfo, query, fragment, or key-like path segments' },
  'codex-channel-id-invalid': { zh: '渠道 ID 只能含字母、数字、下划线和连字符', en: 'A channel ID may only contain letters, digits, underscores and hyphens' },
  'codex-channel-wire-api-invalid': { zh: 'Codex 渠道仅支持 Responses API', en: 'Codex channels only support the Responses API' },
  'codex-channel-env-invalid': { zh: '渠道 env 只能存非凭据变量；令牌请填入令牌输入框', en: 'Channel env may only hold non-credential variables; use the token input for credentials' },
  'codex-anchor-missing': { zh: '找不到这条消息的原生回合，无法 fork 或回退', en: 'The native turn for this message is unavailable; it cannot be forked or rewound' },
  'codex-rewind-files-unsupported': { zh: 'Codex 仅支持对话回退，不恢复工作区文件', en: 'Codex supports conversation rewind only; workspace files are not restored' },
  'codex-rewind-upgrade': { zh: '此处回退需要 Codex app-server {{min}} 或更新版本；请升级并重启 Codex 服务，或先加载更早消息后重试', en: 'Rewinding here requires Codex app-server {{min}} or newer; upgrade and restart the Codex server, or load earlier messages and retry' },
  'codex-goals-unsupported': { zh: '此 Codex 不支持目标管理，目标能力已关闭', en: 'This Codex does not support goal management; goal controls are unavailable' },
  'codex-subagent-unavailable': { zh: '无法读取此 Codex 子代理的历史', en: 'This Codex subagent history is unavailable' },
  'codex-reconnect-incomplete': { zh: 'Codex 恢复缺口超过读取预算或游标失效，请重新打开会话', en: 'Codex recovery exceeded its history budget or could not reach a known turn; reopen the session' },
  // ── MCP elicitation → questionnaire (the flow is shared; the copy is this backend's own, per D2 — see src/backends/shared/elicitation.ts) ──
  'elicit-skip': { zh: '跳过', en: 'Skip' },
  'elicit-skip-desc': { zh: '这一项不填', en: 'Leave this field empty' },
  'elicit-optional': { zh: '{{title}}（可选）', en: '{{title}} (optional)' },
  'elicit-yes': { zh: '是', en: 'Yes' },
  'elicit-no': { zh: '否', en: 'No' },
  'elicit-send': { zh: '发送', en: 'Send' },
  'elicit-send-desc': { zh: '把这些回答交给 MCP 服务器', en: 'Give these answers to the MCP server' },
  'elicit-decline': { zh: '拒绝', en: 'Decline' },
  'elicit-decline-desc': { zh: '不提供，告诉服务器你拒绝了', en: 'Provide nothing; tell the server you declined' },
  'elicit-confirm': { zh: '把回答发送给 MCP 服务器 {{server}}？', en: 'Send your answers to the MCP server {{server}}?' },
  'elicit-invalid': { zh: '请重新填写：{{reason}}', en: 'Please answer again: {{reason}}' },
  'elicit-invalid-required': { zh: '这一项必填', en: 'this field is required' },
  'elicit-invalid-choice': { zh: '请选择一项', en: 'pick one of the options' },
  'elicit-invalid-number': { zh: '需要一个数字', en: 'a number is expected' },
  'elicit-invalid-integer': { zh: '需要一个整数', en: 'a whole number is expected' },
  'elicit-invalid-min': { zh: '不能小于 {{min}}', en: 'must be at least {{min}}' },
  'elicit-invalid-max': { zh: '不能大于 {{max}}', en: 'must be at most {{max}}' },
  'elicit-invalid-min-length': { zh: '至少 {{n}} 个字符', en: 'at least {{n}} characters' },
  'elicit-invalid-max-length': { zh: '至多 {{n}} 个字符', en: 'at most {{n}} characters' },
  'elicit-invalid-min-items': { zh: '至少选 {{n}} 项', en: 'pick at least {{n}}' },
  'elicit-invalid-max-items': { zh: '至多选 {{n}} 项', en: 'pick at most {{n}}' },
  'elicit-invalid-email': { zh: '需要一个邮箱地址', en: 'an email address is expected' },
  'elicit-invalid-uri': { zh: '需要一个完整的网址（URI）', en: 'a full URI is expected' },
  'elicit-invalid-date': { zh: '需要日期（YYYY-MM-DD）', en: 'a date is expected (YYYY-MM-DD)' },
  'elicit-invalid-date-time': { zh: '需要日期时间（ISO 8601）', en: 'a date and time is expected (ISO 8601)' },
  'elicit-invalid-pattern': { zh: '格式不符合要求', en: 'the format does not match' },
  'elicit-invalid-json': { zh: '需要 JSON 形式的值', en: 'a JSON value is expected' },
  'elicit-kind-number': { zh: '数字', en: 'number' },
  'elicit-kind-integer': { zh: '整数', en: 'whole number' },
  'elicit-hint-range': { zh: '{{kind}}，{{min}}–{{max}}', en: '{{kind}}, {{min}}–{{max}}' },
  'elicit-hint-min': { zh: '{{kind}}，不小于 {{min}}', en: '{{kind}}, at least {{min}}' },
  'elicit-hint-max': { zh: '{{kind}}，不大于 {{max}}', en: '{{kind}}, at most {{max}}' },
  'elicit-hint-json': { zh: '以 JSON 形式输入', en: 'enter it as JSON' },
  'elicit-hint-format': { zh: '格式：{{format}}', en: 'format: {{format}}' },
  'elicit-url-notice': { zh: 'MCP 服务器 {{server}} 请你在浏览器中打开：{{url}}', en: 'The MCP server {{server}} asks you to open: {{url}}' },
  'elicit-url-question': { zh: 'MCP 服务器 {{server}} 需要你在浏览器中完成一步', en: 'The MCP server {{server}} needs you to finish a step in the browser' },
  'elicit-url-detail': { zh: '打开下面的链接完成后选「继续」；完成时服务器也可能自动关闭这个面板', en: 'Open the link below, then choose Continue; the server may also close this panel when it is done' },
  'elicit-url-accept': { zh: '继续（已打开链接）', en: 'Continue (link opened)' },
  'elicit-url-accept-desc': { zh: '告诉服务器你同意并已打开链接', en: 'Tell the server you agreed and opened the link' },
  'elicit-url-complete': { zh: 'MCP 服务器 {{server}} 确认已完成', en: 'The MCP server {{server}} confirmed it is done' },
  'elicit-url-missing': { zh: 'MCP 服务器 {{server}} 请求打开链接却没有给出网址，已拒绝', en: 'The MCP server {{server}} asked to open a link but gave none; declined' },
  'elicit-unsupported': { zh: 'MCP 服务器 {{server}} 的请求（{{mode}}）无法在此显示，已拒绝', en: 'The request of the MCP server {{server}} ({{mode}}) cannot be shown here; declined' },
  // ── Strings this backend shares with platform surfaces the host also renders (the status line's rate-limit window, /doctor, the tool names of its own cards).
  //    They are not a copy kept here any more: the values come from the one source in the neutral seam
  //    (`src/backends/shared/platform-text.ts`), which the host dictionary reads too, so the two sides cannot drift apart.
  //    D2 is unchanged for a third-party contribution — it still cannot read the host dictionary,
  //    and the seam is out of reach from the layers a contribution occupies. ──
  ...pickPlatformText([
    'capability-failed',
    'status-rate-limit-five-hour',
    'status-rate-limit-seven-day',
    'doctor-unknown',
    'effort-invalid',
    'tool-name-bash',
    'tool-name-edit',
  ]),
} as const satisfies Record<string, { readonly zh: LocalizedText; readonly en: LocalizedText }>

/** Read-only view of {@link texts} for audits (`scripts/verify-i18n.ts` and the
 *  backend's own gates), mirroring `i18nDict` on the host side. */
export const codexTexts: Readonly<Record<string, { readonly zh: LocalizedText; readonly en: LocalizedText }>> = texts

/** A key of {@link texts}; a typo is a compile error. */
export type CodexTextKey = keyof typeof texts

/** Values substituted into a string of {@link texts}. */
export type CodexTextParams = TextParams

/** Where the live language comes from: the host, in production. */
let localeSource: () => BackendLocale = () => 'zh'

/** Install the language source (`BackendHost.locale`). Called on every
 *  `detect()`/`open()`, so a session started after a `/lang` switch writes in
 *  the new language. */
export function installCodexLocale(source: () => BackendLocale): void {
  localeSource = source
}

/** The language this backend is writing in right now. */
export function codexLocale(): BackendLocale {
  return localeSource()
}

/** The raw template of one key in the active language, without substitution:
 *  the elicitation flow fills its own placeholders (see
 *  {@link codexElicitationText}). */
export function codexTemplate(key: CodexTextKey): string {
  return texts[key][codexLocale()]
}

/**
 * The elicitation copy of one flow, in the language showing when the flow
 * opens: the option labels of a flow are fixed then, because answers are
 * matched against the strings the panel showed (a language switch meanwhile
 * must not turn a valid answer into a mismatch).
 */
export function codexElicitationText(): ElicitationText {
  return {
    skip: codexTemplate('elicit-skip'),
    skipDesc: codexTemplate('elicit-skip-desc'),
    yes: codexTemplate('elicit-yes'),
    no: codexTemplate('elicit-no'),
    send: codexTemplate('elicit-send'),
    sendDesc: codexTemplate('elicit-send-desc'),
    decline: codexTemplate('elicit-decline'),
    declineDesc: codexTemplate('elicit-decline-desc'),
    confirm: codexTemplate('elicit-confirm'),
    optional: codexTemplate('elicit-optional'),
    invalid: codexTemplate('elicit-invalid'),
    invalidChoice: codexTemplate('elicit-invalid-choice'),
    invalidRequired: codexTemplate('elicit-invalid-required'),
    invalidNumber: codexTemplate('elicit-invalid-number'),
    invalidInteger: codexTemplate('elicit-invalid-integer'),
    invalidMin: codexTemplate('elicit-invalid-min'),
    invalidMax: codexTemplate('elicit-invalid-max'),
    invalidMinLength: codexTemplate('elicit-invalid-min-length'),
    invalidMaxLength: codexTemplate('elicit-invalid-max-length'),
    invalidMinItems: codexTemplate('elicit-invalid-min-items'),
    invalidMaxItems: codexTemplate('elicit-invalid-max-items'),
    invalidJson: codexTemplate('elicit-invalid-json'),
    invalidEmail: codexTemplate('elicit-invalid-email'),
    invalidUri: codexTemplate('elicit-invalid-uri'),
    invalidDate: codexTemplate('elicit-invalid-date'),
    invalidDateTime: codexTemplate('elicit-invalid-date-time'),
    invalidPattern: codexTemplate('elicit-invalid-pattern'),
    kindInteger: codexTemplate('elicit-kind-integer'),
    kindNumber: codexTemplate('elicit-kind-number'),
    hintRange: codexTemplate('elicit-hint-range'),
    hintMin: codexTemplate('elicit-hint-min'),
    hintMax: codexTemplate('elicit-hint-max'),
    hintJson: codexTemplate('elicit-hint-json'),
    hintFormat: codexTemplate('elicit-hint-format'),
    urlAccept: codexTemplate('elicit-url-accept'),
    urlAcceptDesc: codexTemplate('elicit-url-accept-desc'),
    urlQuestion: codexTemplate('elicit-url-question'),
    urlDetail: codexTemplate('elicit-url-detail'),
    urlNotice: codexTemplate('elicit-url-notice'),
    urlComplete: codexTemplate('elicit-url-complete'),
    urlMissing: codexTemplate('elicit-url-missing'),
    unsupported: codexTemplate('elicit-unsupported'),
  }
}

/** One string of this backend in the active language. */
export function codexText(key: CodexTextKey, params: CodexTextParams = {}): string {
  return fillTemplate(codexTemplate(key), params)
}
