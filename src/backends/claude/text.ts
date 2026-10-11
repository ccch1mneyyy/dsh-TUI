/**
 * The Claude backend's own copy (B-3): every string this backend puts on
 * screen, in the languages the TUI ships, keyed as the host dictionary
 * happened to key them so the move stayed reviewable.
 *
 * Why a backend carries its own text (D2): the host's dictionary
 * (`src/i18n.ts`) is not readable from a backend, and a plugin must not be
 * able to pass itself off as first-party copy. The shape and the two rules
 * (`{{name}}` placeholders, `count` plurals) are shared
 * (`src/backends/shared/localized-text.ts`), so the mechanism cannot drift.
 *
 * The language is read live from the host (`BackendHost.locale`), installed
 * by `detect()`/`open()` and by `openClaudeSession`: a `/lang` switch
 * applies to the next string, exactly as `t()` behaved. Before any of those
 * run there is no host to ask, and the fallback is `zh` — the same
 * last-resort default `src/i18n.ts` documents for its own resolution order.
 */
import type { BackendLocale } from '../../agent/backend.js'
import type { ElicitationText } from '../shared/elicitation.js'
import { fillTemplate, pickLocalizedText, type LocalizedText, type TextParams } from '../shared/localized-text.js'

/**
 * Every string of this backend. `zh` and `en` are both required
 * (`scripts/verify-i18n.ts` checks the same invariants the host dictionary
 * gets: language completeness, placeholder parity, single-brace typos, and
 * that no key here is dead).
 */
const texts = {
  'claude-permission-denied': { zh: '{{tool}} 被权限规则拒绝', en: '{{tool}} was denied by a permission rule' },
  'claude-permission-denied-reason': { zh: '{{tool}} 被自动拒绝：{{reason}}', en: '{{tool}} was denied automatically: {{reason}}' },
  'claude-denied-reason': { zh: '拒绝原因：{{reason}}', en: 'Denied: {{reason}}' },
  'claude-question-unreadable': { zh: '无法读取这次提问的内容，已拒绝', en: 'The question could not be read and was declined' },
  'claude-always-rules-session': { zh: '允许，本次会话不再询问 {{rules}}', en: 'Yes, and don\'t ask again for {{rules}} this session' },
  'claude-always-rules-project': { zh: '允许，本项目不再询问 {{rules}}', en: 'Yes, and don\'t ask again for {{rules}} in this project' },
  'claude-always-rules-user': { zh: '允许，所有项目都不再询问 {{rules}}', en: 'Yes, and don\'t ask again for {{rules}} in any project' },
  'claude-always-accept-edits': { zh: '允许，本次会话自动接受编辑', en: 'Yes, and auto-accept edits this session' },
  'claude-always-mode': { zh: '允许，并切换到 {{mode}} 模式', en: 'Yes, and switch to {{mode}} mode' },
  'claude-always-directories': { zh: '允许，并允许访问 {{dirs}}', en: 'Yes, and allow access to {{dirs}}' },
  'claude-plan-review-header': { zh: '计划评审', en: 'Plan review' },
  'claude-plan-review-question': { zh: 'Claude 准备好了计划，要开始执行吗？', en: 'Claude has a plan. Ready to start?' },
  'claude-plan-accept-edits': { zh: '批准，并自动接受编辑', en: 'Yes, and auto-accept edits' },
  'claude-plan-accept-edits-desc': { zh: '退出计划模式，之后的文件编辑不再逐个询问', en: 'Leave plan mode; file edits no longer ask one by one' },
  'claude-plan-manual': { zh: '批准，编辑仍逐个确认', en: 'Yes, and approve each edit' },
  'claude-plan-manual-desc': { zh: '退出计划模式，回到默认权限模式', en: 'Leave plan mode for the default permission mode' },
  'claude-plan-keep': { zh: '继续规划', en: 'No, keep planning' },
  'claude-plan-keep-desc': { zh: '可在输入行写下要修改的地方', en: 'Type what to change on the input row' },
  'claude-plan-approved': { zh: '计划已批准，开始执行', en: 'Plan approved; starting' },
  'claude-plan-kept': { zh: '计划未批准，继续规划', en: 'Plan not approved; planning continues' },
  'claude-model-unknown': { zh: 'Claude 没有模型 {{model}}（/model 查看可用模型）', en: 'Claude has no model {{model}} (see /model)' },
  'claude-mode-default': { zh: '默认', en: 'Default' },
  'claude-mode-acceptEdits': { zh: '自动接受编辑', en: 'Accept edits' },
  'claude-mode-plan': { zh: '计划模式', en: 'Plan mode' },
  'claude-mode-auto': { zh: '自动审批', en: 'Auto' },
  'claude-mode-dontAsk': { zh: '不询问', en: "Don't ask" },
  'claude-mode-bypassPermissions': { zh: '跳过权限', en: 'Bypass permissions' },
  'claude-mode-desc-default': { zh: '默认：每个危险操作前都询问', en: 'Default: asks before every risky action' },
  'claude-mode-desc-acceptEdits': { zh: '自动接受文件编辑，其他操作仍询问', en: 'Auto-accepts file edits, still asks for the rest' },
  'claude-mode-desc-plan': { zh: '计划模式：只读，先出方案不动手', en: 'Plan mode: read-only, proposes before acting' },
  'claude-mode-desc-auto': { zh: '自动审批：由模型分类器判定', en: 'Auto: a model classifier decides' },
  'claude-mode-desc-dontAsk': { zh: '不询问：未预先批准的操作一律拒绝', en: "Don't ask: anything not pre-approved is denied" },
  'claude-mode-desc-bypassPermissions': { zh: '跳过全部权限检查（谨慎使用）', en: 'Skips every permission check (use with care)' },
  'claude-effort-low': { zh: '低', en: 'Low' },
  'claude-effort-medium': { zh: '中', en: 'Medium' },
  'claude-effort-high': { zh: '高', en: 'High' },
  'claude-effort-xhigh': { zh: '超高', en: 'Extra high' },
  'claude-effort-max': { zh: '最高', en: 'Max' },
  'claude-auth-failed-login': { zh: 'Claude 凭证仍被拒绝：用 /login 重新登录，或设置 ANTHROPIC_API_KEY、在终端运行 claude login', en: 'Claude still refuses the credential: sign in again with /login, set ANTHROPIC_API_KEY, or run `claude login` in a terminal' },
  'claude-auth-reconnected': { zh: '凭证已刷新并重新连接同一会话，请重发上一条消息', en: 'Credential renewed and the same session reconnected; send your last message again' },
  'claude-auth-refresh-failed': { zh: '刷新 Claude 凭证失败{{detail}}（可用 /login 重新登录）', en: 'Renewing the Claude credential failed{{detail}} (sign in again with /login)' },
  'claude-channel-token-missing': {
    zh: '渠道 {{name}}（{{host}}）指向自定义端点，但没有可用的 token，已拒绝启动，以免向中转端点发送不带凭据的请求。请在 /channel → 管理渠道 里补上 token，或换一个渠道后重试。',
    en: 'Channel {{name}} ({{host}}) points at a custom endpoint but has no usable token, so the session was not started (no unauthenticated requests to a relay). Add a token under /channel → Manage channels, or switch to another channel, then retry.',
  },
  'claude-channel-helper-conflict': {
    zh: 'settings.json 配置了 apiKeyHelper，与当前渠道冲突：它生成的 x-api-key 会随请求发到渠道端点。请从 settings.json 删掉 apiKeyHelper，或在 /channel 里停用该渠道后再启动。',
    en: 'settings.json sets apiKeyHelper, which conflicts with the active channel: the x-api-key it produces would be sent to the channel endpoint. Remove apiKeyHelper from settings.json, or deactivate the channel in /channel, then retry.',
  },
  'claude-auth-refresh-status': { zh: ' · HTTP {{status}}', en: ' · HTTP {{status}}' },
  'claude-auth-reconnect-failed': { zh: '重新连接 Claude 会话失败；可用 /login 重新登录', en: 'Reconnecting the Claude session failed; sign in again with /login' },
  'claude-auth-reconnect-deferred': { zh: '当前回合结束后再用新凭证重新连接', en: 'Reconnecting with the new credential once the current turn ends' },
  'claude-auth-reconnect-forced': { zh: '等待当前回合结束超时，现在重新连接，正在运行的回合会被中断', en: 'The turn did not finish in time; reconnecting now, which interrupts the running turn' },
  'claude-auth-inputs-dropped': { zh: '重新连接失败，{{n}} 条尚未开始的消息未能送达', en: 'Reconnecting failed; {{n}} message(s) that had not started were not delivered' },
  'claude-auth-route': { zh: '未使用订阅登录：{{route}}', en: 'Subscription sign-in not used: {{route}}' },
  'claude-route-custom-endpoint': { zh: '自定义端点 {{host}}（ANTHROPIC_BASE_URL）', en: 'custom endpoint {{host}} (ANTHROPIC_BASE_URL)' },
  'claude-route-custom-oauth': { zh: '自定义 OAuth 部署', en: 'custom OAuth deployment' },
  'claude-route-unix-socket': { zh: 'Unix 套接字（ANTHROPIC_UNIX_SOCKET）', en: 'Unix socket (ANTHROPIC_UNIX_SOCKET)' },
  'claude-route-gateway': { zh: '云网关', en: 'cloud gateway' },
  'claude-route-api-key-helper': { zh: '设置中的 apiKeyHelper', en: 'apiKeyHelper in settings' },
  'claude-route-settings-unreadable': { zh: '无法读取 Claude 设置，无法确认连接方式', en: 'Claude settings could not be read, so the connection route is unknown' },
  'claude-auth-source': { zh: '凭证来源：{{source}}', en: 'Credential: {{source}}' },
  'claude-auth-missing-hint': { zh: '未找到 Claude 凭证：用 /login 登录 anthropic，或设置 ANTHROPIC_API_KEY、在终端运行 claude login', en: 'No Claude credential found: sign in to anthropic with /login, set ANTHROPIC_API_KEY, or run `claude login` in a terminal' },
  'claude-auth-cli': { zh: 'CLI 报告 · apiKeySource：{{source}} · tokenSource：{{token}}', en: 'CLI reports · apiKeySource: {{source}} · tokenSource: {{token}}' },
  'claude-auth-source-dsh-auth': { zh: 'dsh-auth anthropic 登录', en: 'dsh-auth anthropic sign-in' },
  'claude-auth-source-dsh-auth-expires': { zh: 'dsh-auth anthropic 登录（令牌到期 {{time}}）', en: 'dsh-auth anthropic sign-in (token expires {{time}})' },
  'claude-auth-source-cloud': { zh: '云厂商 {{provider}}（环境变量）', en: 'Cloud provider {{provider}} (environment)' },
  'claude-auth-source-claude-login': { zh: '本机 claude login', en: 'Local `claude login`' },
  'claude-auth-account': { zh: '账户：{{account}}', en: 'Account: {{account}}' },
  'claude-side-query-empty': { zh: '会话还没有保存任何对话，暂无内容可问', en: 'The session has no saved conversation to ask about yet' },
  'claude-side-query-no-answer': { zh: '没有得到回答', en: 'No answer was received' },
  'claude-process-exited': { zh: 'Claude 进程已退出：{{reason}}', en: 'The Claude process exited: {{reason}}' },
  'claude-process-ended': { zh: '会话流已结束', en: 'the session stream ended' },
  'claude-cancel-forced': { zh: '中断 30 秒未得到确认，已强制结束本回合', en: 'The interrupt was not confirmed within 30s; the turn was force-closed' },
  'claude-version-drift': { zh: 'Claude CLI {{version}} 未经本版 dsh-tui 验证（已验证：{{validated}}），继续运行', en: 'Claude CLI {{version}} is not validated with this dsh-tui (validated: {{validated}}); continuing' },
  'claude-sdk-drift': { zh: 'Claude Agent SDK {{version}} 与验证版本 {{validated}} 不一致，继续运行', en: 'Claude Agent SDK {{version}} differs from the validated {{validated}}; continuing' },
  'claude-sdk-missing': { zh: '未安装 Claude Agent SDK：在 dsh-tui 安装目录运行 pnpm add @anthropic-ai/claude-agent-sdk@{{version}}', en: 'The Claude Agent SDK is not installed: run pnpm add @anthropic-ai/claude-agent-sdk@{{version}} in the dsh-tui install directory' },
  'claude-resume-not-found': { zh: '本机 Claude 会话库中没有会话 {{id}}', en: 'No Claude session {{id}} in the local session store' },
  'claude-rewind-files-unavailable': { zh: '该会话没有可用的文件检查点', en: 'No file checkpoints are available for this session' },
  'claude-fork-empty': { zh: '会话还没有保存任何消息，无可分叉的内容', en: 'Nothing to fork yet — the session has no saved messages' },
  'claude-task-unnamed': { zh: '任务 {{id}}（标题未恢复）', en: 'Task {{id}} (subject not recovered)' },
  'claude-task-output-refused': { zh: '不读取任务 {{id}} 的输出：路径不在 Claude 的目录内', en: 'Not reading the output of task {{id}}: the path is outside the Claude directories' },
  'claude-task-output-missing': { zh: '任务 {{id}} 的输出文件还不存在', en: 'The output file of task {{id}} does not exist yet' },
  'claude-task-output-unknown': { zh: '任务 {{id}} 没有报告输出文件', en: 'Task {{id}} reported no output file' },
  'claude-transcript-missing': { zh: '找不到会话 {{id}} 的转录文件', en: 'The transcript file of session {{id}} was not found' },
  'claude-transcript-too-large': { zh: '会话转录超过 {{mb}} MB，不读取', en: 'The session transcript is larger than {{mb}} MB; not reading it' },
  'claude-rewind-not-found': { zh: '该消息不在会话已保存的对话链中', en: 'That message is not in the session\'s saved conversation' },
  'claude-images-too-many': { zh: '一条消息最多附 {{n}} 张图片', en: 'A message carries at most {{n}} images' },
  'claude-images-too-large': { zh: '这条消息的图片合计超过 {{mb}} MB', en: 'The images of this message exceed {{mb}} MB together' },
  'claude-image-too-large': { zh: '图片 {{name}} 超过 {{mb}} MB', en: 'The image {{name}} exceeds {{mb}} MB' },
  'claude-image-type-refused': { zh: 'Claude 不接受图片 {{name}} 的格式（{{type}}）', en: 'Claude does not take the format of {{name}} ({{type}})' },
  'claude-image-unreadable': { zh: '无法读取图片 {{name}}：{{err}}', en: 'The image {{name}} could not be read: {{err}}' },
  'claude-image-gone': { zh: '暂存的图片已不在内存中，请重新粘贴', en: 'the staged image is no longer in memory; paste it again' },
  'claude-session-closed': { zh: 'Claude 会话已关闭', en: 'The Claude session is closed' },
  'claude-start-timeout': { zh: 'Claude CLI 未在时限内完成启动握手', en: 'The Claude CLI did not finish its start handshake in time' },
  'claude-start-mode-downgraded': { zh: '设置中的权限模式 {{mode}} 需在 /permission 里显式选择，本会话先以 default 启动', en: 'The configured permission mode {{mode}} needs an explicit choice in /permission; this session starts in default' },
  'claude-start-mode-env': { zh: '权限模式由 DSH_TUI_CLAUDE_PERMISSION_MODE 指定：{{mode}}', en: 'Permission mode set by DSH_TUI_CLAUDE_PERMISSION_MODE: {{mode}}' },
  'claude-start-mode-env-ignored': { zh: '已忽略 DSH_TUI_CLAUDE_PERMISSION_MODE={{mode}}（只接受 default/acceptEdits/plan/dontAsk/bypassPermissions）', en: 'Ignored DSH_TUI_CLAUDE_PERMISSION_MODE={{mode}} (accepts default/acceptEdits/plan/dontAsk/bypassPermissions)' },
  'claude-start-mode-bypass-not-carried': { zh: '上次的「跳过权限」不会带到新会话，本会话照常审批；可用 /permission 重新开启', en: 'Bypass permissions from the last session is not carried into a new one; approvals are on. Turn it back on with /permission' },
  'claude-input-refused': { zh: 'Claude 拒绝了这条输入', en: 'Claude refused this input' },
  'claude-assistant-error': { zh: 'Claude 错误：{{error}}', en: 'Claude error: {{error}}' },
  'claude-api-retry': { zh: 'API 重试 {{attempt}}/{{max}}{{detail}}…', en: 'API retry {{attempt}}/{{max}}{{detail}}…' },
  'claude-api-retry-status': { zh: ' · HTTP {{status}}', en: ' · HTTP {{status}}' },
  'claude-notification-turn': { zh: '后台任务完成，模型继续处理', en: 'A background task finished; the model continues' },
  'claude-model-fallback': { zh: '{{original}} 拒绝了这次请求{{category}}，已改用 {{model}} 重试（本会话之后都用它）', en: '{{original}} declined this request{{category}}; retried on {{model}} (the session continues on it)' },
  'claude-model-fallback-local': { zh: '一个子任务改由 {{model}} 回答（{{original}} 拒绝了它），会话模型不变', en: 'A side task was answered by {{model}} ({{original}} declined it); the session model is unchanged' },
  'claude-model-refused': { zh: '{{model}} 拒绝了这次请求{{category}}，没有可用的回退模型', en: '{{model}} declined this request{{category}} and no fallback model is available' },
  'claude-refusal-category-suffix': { zh: '（类别：{{category}}）', en: ' (category: {{category}})' },
  'claude-rate-limit-warning': { zh: '订阅用量接近{{window}}上限（{{percent}}%）{{resets}}', en: 'Approaching the {{window}} usage limit ({{percent}}%){{resets}}' },
  'claude-rate-limit-rejected': { zh: '已达到{{window}}用量上限{{resets}}', en: 'The {{window}} usage limit is reached{{resets}}' },
  'claude-rate-limit-resets': { zh: '，{{time}}重置', en: ' — resets {{time}}' },
  'claude-rate-limit-in': { zh: '{{duration}}后', en: 'in {{duration}}' },
  'claude-auth-status-error': { zh: 'Claude 认证出错：{{error}}', en: 'Claude authentication error: {{error}}' },
  'claude-memory-recalled': { zh: '已回忆 {{count}} 条记忆', en: { one: 'Recalled {{count}} memory', other: 'Recalled {{count}} memories' } },
  'claude-memory-synthesized': { zh: '已从记忆中归纳相关上下文', en: 'Recalled a summary of relevant memories' },
  'claude-activity-thinking': { zh: '思考中', en: 'Thinking' },
  'claude-activity-waiting': { zh: '等待确认', en: 'Waiting for approval' },
  'claude-activity-done': { zh: '完成', en: 'Done' },
  'claude-activity-done-tools': { zh: '完成 · {{count}} 个工具', en: { one: 'Done · 1 tool', other: 'Done · {{count}} tools' } },
  'claude-refusal-header': { zh: '模型拒绝', en: 'Model declined' },
  'claude-refusal-question': { zh: '{{model}} 拒绝了这次请求，要换模型重试吗？', en: '{{model}} declined this request. Retry on another model?' },
  'claude-refusal-this-model': { zh: '当前模型', en: 'The current model' },
  'claude-refusal-retry': { zh: '用 {{model}} 重试', en: 'Retry on {{model}}' },
  'claude-refusal-retry-desc': { zh: '本次请求改由回退模型回答', en: 'The fallback model answers this request' },
  'claude-refusal-cancel': { zh: '取消', en: 'Cancel' },
  'claude-refusal-cancel-desc': { zh: '保留拒绝结果，结束本回合', en: 'Keep the refusal and end the turn' },
  'claude-refusal-category': { zh: '拒绝类别：{{category}}', en: 'Refusal category: {{category}}' },
  'claude-doctor-cli': { zh: 'Claude CLI: {{path}}（{{source}}）· 版本 {{version}}', en: 'Claude CLI: {{path}} ({{source}}) · version {{version}}' },
  'claude-doctor-bundled': { zh: 'SDK 自带二进制', en: 'SDK bundled binary' },
  'claude-doctor-sdk': { zh: 'Claude Agent SDK {{version}}（已验证 {{validated}}）', en: 'Claude Agent SDK {{version}} (validated {{validated}})' },
  'claude-doctor-mode': { zh: '起始权限模式: {{mode}}（来源 {{source}}）', en: 'Start permission mode: {{mode}} (from {{source}})' },

  // ── MCP elicitation → questionnaire (the flow is shared; the copy is this
  //    backend's own, per D2 — see src/backends/shared/elicitation.ts) ──
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
  // ── Strings this backend shares with platform surfaces the host also
  //    renders (the status line's rate-limit window, /doctor, rename and
  //    rewind outcomes). The host keeps its own entries for DSH sessions and
  //    codex; a backend cannot read them (D2), so the copy is repeated here. ──
  'channel-conn-settings-mismatch': {
    zh: 'settings.json 的 ANTHROPIC_BASE_URL 与当前渠道 {{name}} 不一致；本会话按渠道配置连接（settings.json 不改，直接运行 claude 时仍按它）',
    en: 'The ANTHROPIC_BASE_URL in settings.json differs from the active channel {{name}}; this session connects as the channel says (settings.json is left as is for running claude directly)',
  },
  'channel-conn-creds-superseded': {
    zh: '本会话使用渠道凭据，settings.json 里的 {{keys}} 本次不生效（settings.json 不改，直接运行 claude 时仍会用到）',
    en: 'This session uses the channel credential; {{keys}} from settings.json do not apply (settings.json is left as is for running claude directly)',
  },
  'doctor-unknown': { zh: '未知', en: 'unknown' },
  'rewind-first-message': { zh: '不能回退到第一条消息之前', en: 'Cannot rewind past the very first message' },
  'rename-failed': { zh: '重命名失败 · {{err}}', en: 'Rename failed · {{err}}' },
  'rename-usage': { zh: '用法  /rename <新名称>', en: 'Usage  /rename <new title>' },
  'status-rate-limit-five-hour': { zh: '5小时', en: '5h' },
  'status-rate-limit-seven-day': { zh: '7天', en: '7d' },
} as const satisfies Record<string, { readonly zh: LocalizedText; readonly en: LocalizedText }>

/** Read-only view of {@link texts} for audits (scripts/verify-i18n.ts and the
 *  backend's own gates), mirroring `i18nDict` on the host side. */
export const claudeTexts: Readonly<Record<string, { readonly zh: LocalizedText; readonly en: LocalizedText }>> = texts

/** A key of {@link texts}; a typo is a compile error. */
export type ClaudeTextKey = keyof typeof texts

/** Values substituted into a string of {@link texts}. */
export type ClaudeTextParams = TextParams

/** Where the live language comes from: the host, in production. */
let localeSource: () => BackendLocale = () => 'zh'

/** Install the language source (`BackendHost.locale`). Called on every
 *  `detect()`/`open()`/`openClaudeSession()`, so a session started after a
 *  `/lang` switch writes in the new language. */
export function installClaudeLocale(source: () => BackendLocale): void {
  localeSource = source
}

/** The language this backend is writing in right now. */
export function claudeLocale(): BackendLocale {
  return localeSource()
}

/**
 * The raw template of one key in the active language, without substitution:
 * the elicitation flow fills its own placeholders
 * (see {@link claudeElicitationText}). A key with no text in this language
 * renders as the key itself, so a typo is visible rather than blank.
 */
export function claudeTemplate(key: ClaudeTextKey): string {
  const locale = localeSource()
  return pickLocalizedText(texts[key][locale], locale, {}) ?? key
}

/** One string of this backend in the active language. */
export function claudeText(key: ClaudeTextKey, params: ClaudeTextParams = {}): string {
  return fillTemplate(claudeTemplate(key), params)
}

/**
 * The elicitation copy of one flow, in the language showing when the flow
 * opens: the option labels of a flow are fixed then, because answers are
 * matched against the strings the panel showed (a language switch meanwhile
 * must not turn a valid answer into a mismatch).
 */
export function claudeElicitationText(): ElicitationText {
  return {
    skip: claudeTemplate('elicit-skip'),
    skipDesc: claudeTemplate('elicit-skip-desc'),
    yes: claudeTemplate('elicit-yes'),
    no: claudeTemplate('elicit-no'),
    send: claudeTemplate('elicit-send'),
    sendDesc: claudeTemplate('elicit-send-desc'),
    decline: claudeTemplate('elicit-decline'),
    declineDesc: claudeTemplate('elicit-decline-desc'),
    confirm: claudeTemplate('elicit-confirm'),
    optional: claudeTemplate('elicit-optional'),
    invalid: claudeTemplate('elicit-invalid'),
    invalidChoice: claudeTemplate('elicit-invalid-choice'),
    invalidRequired: claudeTemplate('elicit-invalid-required'),
    invalidNumber: claudeTemplate('elicit-invalid-number'),
    invalidInteger: claudeTemplate('elicit-invalid-integer'),
    invalidMin: claudeTemplate('elicit-invalid-min'),
    invalidMax: claudeTemplate('elicit-invalid-max'),
    invalidMinLength: claudeTemplate('elicit-invalid-min-length'),
    invalidMaxLength: claudeTemplate('elicit-invalid-max-length'),
    invalidMinItems: claudeTemplate('elicit-invalid-min-items'),
    invalidMaxItems: claudeTemplate('elicit-invalid-max-items'),
    invalidJson: claudeTemplate('elicit-invalid-json'),
    invalidEmail: claudeTemplate('elicit-invalid-email'),
    invalidUri: claudeTemplate('elicit-invalid-uri'),
    invalidDate: claudeTemplate('elicit-invalid-date'),
    invalidDateTime: claudeTemplate('elicit-invalid-date-time'),
    invalidPattern: claudeTemplate('elicit-invalid-pattern'),
    kindInteger: claudeTemplate('elicit-kind-integer'),
    kindNumber: claudeTemplate('elicit-kind-number'),
    hintRange: claudeTemplate('elicit-hint-range'),
    hintMin: claudeTemplate('elicit-hint-min'),
    hintMax: claudeTemplate('elicit-hint-max'),
    hintJson: claudeTemplate('elicit-hint-json'),
    hintFormat: claudeTemplate('elicit-hint-format'),
    urlAccept: claudeTemplate('elicit-url-accept'),
    urlAcceptDesc: claudeTemplate('elicit-url-accept-desc'),
    urlQuestion: claudeTemplate('elicit-url-question'),
    urlDetail: claudeTemplate('elicit-url-detail'),
    urlNotice: claudeTemplate('elicit-url-notice'),
    urlComplete: claudeTemplate('elicit-url-complete'),
    urlMissing: claudeTemplate('elicit-url-missing'),
    unsupported: claudeTemplate('elicit-unsupported'),
  }
}
