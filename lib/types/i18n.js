/**
 * dsh-tui localization — UI strings for Chinese (`zh`, the default) and
 * English (`en`).
 *
 * Resolution order mirrors the `/theme` mechanism (see themePrefs.ts):
 *
 *   1. `CC_TUI_LANG` env var (`en` / `zh`) — pinned at process start
 *   2. `lang` cordis.yml config key (see Config in index.ts)
 *   3. the persisted `/lang` choice in `~/.dsh-cc/lang.json`
 *   4. the OS locale guess (`LC_ALL` / `LC_MESSAGES` / `LANG`)
 *   5. `zh` (the original hard-coded language)
 *
 * `/lang` switches at runtime and hot-swaps the whole UI. The dictionary is
 * a flat key → per-language string map; `t(key, params)` substitutes
 * `{{name}}` placeholders with the given params. Missing keys render the
 * key itself so a typo is visible in the UI instead of silently blank.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const PREFS_DIR = join(homedir(), '.dsh-cc');
/** The languages shipped with the plugin, in display order. */
export const LANGS = ['zh', 'en'];
const dict = {
    // ── channel.ts ───────────────────────────────────────────────────────
    'activity-indicator-already': { zh: '指示器已是：{{name}}', en: 'Indicator already set: {{name}}' },
    'activity-indicator-switched': { zh: '指示器已切换：{{name}}（已保存）', en: 'Indicator switched: {{name}} (saved)' },
    'activity-pref-write-failed': { zh: '无法写入 ~/.dsh-cc/working-activity.json，切换未保存', en: 'Cannot write ~/.dsh-cc/working-activity.json, switch not saved' },
    'model-pref-write-failed': { zh: '无法写入 ~/.dsh-cc/model.json，模型选择不会保存到重启后', en: 'Cannot write ~/.dsh-cc/model.json, the model choice will not survive a restart' },
    'model-route-invalid': { zh: '持久化的模型路由 {{provider}}/{{model}} 不在该 provider 的模型列表中，已整体回退到 {{fallback}}', en: 'Persisted model route {{provider}}/{{model}} is not advertised by that provider; fell back to {{fallback}}' },
    'unknown-activity-preset': { zh: '未知预设「{{name}}」· /activity frames 查看全部', en: 'Unknown preset "{{name}}" · /activity frames to view all' },
    'preset-unavailable': { zh: 'Preset 不可用——当前组合未挂载 agent-presets 名册', en: 'Preset unavailable — the agent-presets roster is not mounted' },
    'preset-agent-running': { zh: 'Agent 运行中，无法切换 preset', en: 'Agent is running, cannot switch preset' },
    'preset-not-found': { zh: 'Preset「{{id}}」不存在 · {{err}}', en: 'Preset "{{id}}" not found · {{err}}' },
    'preset-load-failed': { zh: 'Preset「{{id}}」无法加载 · {{broken}}', en: 'Preset "{{id}}" failed to load · {{broken}}' },
    'preset-already-current': { zh: '当前 preset 已是：{{id}}', en: 'Current preset already: {{id}}' },
    'preset-pref-write-failed': { zh: '无法写入 ~/.dsh-cc/agent-preset.json，选择未保存', en: 'Cannot write ~/.dsh-cc/agent-preset.json, selection not saved' },
    'preset-locked-saved-default': { zh: '会话已开始，preset 已锁定（当前：{{current}}）· 已保存为默认：{{id}}（/new 或下次启动生效）', en: 'Session already started, preset locked (current: {{current}}) · Saved as default: {{id}} (applies on /new or next start)' },
    'preset-switch-failed': { zh: 'Preset 切换失败 · {{err}}', en: 'Preset switch failed · {{err}}' },
    'preset-switched-pref-failed': { zh: 'Preset 已切换：{{id}}，但默认偏好写入失败（重启后不保留）', en: 'Preset switched: {{id}}, but writing the default preference failed (won\'t persist after restart)' },
    'preset-switched-saved': { zh: 'Preset 已切换：{{id}}（已保存为默认）', en: 'Preset switched: {{id}} (saved as default)' },
    'mcp-none-configured': { zh: '未配置 MCP 服务器。', en: 'No MCP servers configured.' },
    'mcp-insert-hint': { zh: '在 profile 补丁层（~/.dsh/profiles/dsh-tui/cordis.patch.yml）insert 一行即可，例：', en: 'Insert one line in the profile patch layer (~/.dsh/profiles/dsh-tui/cordis.patch.yml), e.g.:' },
    'mcp-readme-hint': { zh: '详见仓库 README 的 MCP 章节。', en: 'See the MCP section of the repo README.' },
    'mcp-server-tools': { zh: '{{server}}（{{count}} 个工具）: {{tools}}', en: '{{server}} ({{count}} tools): {{tools}}' },
    'child-stderr-line': { zh: '子进程 stderr: {{line}}', en: 'Subprocess stderr: {{line}}' },
    'child-stderr-line-repeat': { zh: '子进程 stderr: {{line}}（重复 {{count}} 次）', en: 'Subprocess stderr: {{line}} (repeated {{count}}×)' },
    'export-title': { zh: '# dsh-tui 会话导出', en: '# dsh-tui session export' },
    'export-time': { zh: '- 导出时间: {{time}}', en: '- Exported: {{time}}' },
    'export-model': { zh: '- 模型: {{model}}', en: '- Model: {{model}}' },
    'export-session': { zh: '- 会话: {{id}}', en: '- Session: {{id}}' },
    'export-dir': { zh: '- 目录: {{cwd}}', en: '- Directory: {{cwd}}' },
    'mentions-attached': { zh: '已附加 {{count}} 个文件引用', en: 'Attached {{count}} file reference(s)' },
    'mentions-missing': { zh: '未找到引用: {{paths}}', en: 'References not found: {{paths}}' },
    'send-failed': { zh: '发送失败 · {{err}}', en: 'Send failed · {{err}}' },
    'export-user-section': { zh: '## 用户', en: '## User' },
    'export-thinking-section': { zh: '## 思考', en: '## Thinking' },
    'export-assistant-section': { zh: '## 助手', en: '## Assistant' },
    'export-tool-section': { zh: '## 工具 · {{name}}', en: '## Tool · {{name}}' },
    'export-result-section': { zh: '### 结果', en: '### Result' },
    'agentsmd-project': { zh: '## 项目', en: '## Project' },
    'agentsmd-project-body': { zh: '（在此描述项目的目标、结构与约定——这份文件会注入给每个 agent 作为工作区上下文。）', en: '(Describe the project\'s goals, structure and conventions here — this file is injected to every agent as workspace context.)' },
    'agentsmd-conventions': { zh: '## 约定', en: '## Conventions' },
    'agentsmd-convention-read': { zh: '- 改动前先阅读相关模块', en: '- Read the relevant modules before making changes' },
    'agentsmd-convention-style': { zh: '- 保持与现有代码风格一致', en: '- Keep consistent with the existing code style' },
    'doctor-api-key': { zh: 'API key: {{state}}', en: 'API key: {{state}}' },
    'doctor-key-configured': { zh: '已配置', en: 'configured' },
    'doctor-key-missing': { zh: '未配置（DEEPSEEK_API_KEY）', en: 'not configured (DEEPSEEK_API_KEY)' },
    'doctor-model': { zh: '模型: {{model}} · 提供方: {{provider}}', en: 'Model: {{model}} · Provider: {{provider}}' },
    'doctor-cwd': { zh: '工作目录: {{cwd}}', en: 'Working directory: {{cwd}}' },
    'doctor-context-window': { zh: '上下文窗口: {{window}} tokens', en: 'Context window: {{window}} tokens' },
    'doctor-unknown': { zh: '未知', en: 'unknown' },
    'doctor-session': { zh: '会话: {{id}}', en: 'Session: {{id}}' },
    'doctor-config': { zh: '配置: {{candidate}} {{state}}', en: 'Config: {{candidate}} {{state}}' },
    'doctor-config-missing': { zh: '（不存在）', en: '(missing)' },
    'doctor-storage': { zh: '会话存储: {{dir}} {{state}}', en: 'Session storage: {{dir}} {{state}}' },
    'doctor-storage-uninit': { zh: '（未初始化）', en: '(not initialized)' },
    'subagent-not-mounted': { zh: '子代理服务未挂载（leaf 未启用 subagent）', en: 'Subagent service not mounted (leaf has no subagent)' },
    'subagent-none': { zh: '当前会话暂无子代理', en: 'No subagents in the current session' },
    'subagent-resumable': { zh: '可续', en: 'resumable' },
    'subagent-oneshot': { zh: '一次性', en: 'one-shot' },
    'subagent-row': { zh: '{{mode}} {{label}}{{activity}} · {{id}}', en: '{{mode}} {{label}}{{activity}} · {{id}}' },
    'subagent-running': { zh: ' 运行中', en: ' running' },
    'subagent-archived': { zh: ' 已归档', en: ' archived' },
    'subagent-query-failed': { zh: '查询失败 · {{err}}', en: 'Query failed · {{err}}' },
    'agent-preset-switched': { zh: 'Agent preset 已切换：{{preset}}', en: 'Agent preset switched: {{preset}}' },
    // ── questions.ts ─────────────────────────────────────────────────────
    'questionnaire-answered': { zh: '问卷已答 · {{total}} 题', en: 'Questionnaire answered · {{total}} questions' },
    // ── customTheme.ts (doc example only) ───────────────────────────────
    'theme-sakura-name': { zh: '樱花粉', en: 'Sakura Pink' },
    // ── utils/loaded-context.ts ─────────────────────────────────────────
    'context-truncated': { zh: '…（已截断）', en: '… (truncated)' },
    'context-sections': { zh: '系统提示词 {{n}} 段', en: 'System prompt {{n}} sections' },
    'context-files': { zh: '工作区指令 ×{{n}}', en: 'Workspace instructions ×{{n}}' },
    'context-runtime': { zh: '运行时上下文 {{n}} 项', en: 'Runtime context {{n}} items' },
    'context-skills': { zh: '技能 {{n}}', en: 'Skills {{n}}' },
    'context-tools': { zh: '工具 {{n}}', en: 'Tools {{n}}' },
    // ── screens/Chat.tsx ────────────────────────────────────────────────
    'skill-audit-prompt': { zh: '请使用 audit 技能对当前项目做一次全面的代码审计，找出安全、正确性与质量问题。', en: 'Use the audit skill to do a thorough code audit of the current project, finding security, correctness and quality issues.' },
    'skill-bug-prompt': { zh: '请使用 bug 技能协助我记录一份完整的 bug 报告（现象、复现步骤、期望行为）。', en: 'Use the bug skill to help me write a complete bug report (symptoms, reproduction steps, expected behavior).' },
    'skill-practice-prompt': { zh: '请使用 practice 技能陪我进行一轮编程练习。', en: 'Use the practice skill to run a round of programming practice with me.' },
    'skill-review-prompt': { zh: '请使用 review 技能对当前项目做一次全面的代码评审。', en: 'Use the review skill to do a thorough code review of the current project.' },
    'skill-pr-comments-prompt': { zh: '请使用 pr-comments 技能审查当前分支的拉取请求评论并给出改进建议。', en: 'Use the pr-comments skill to review pull request comments on the current branch and suggest improvements.' },
    'skill-release-notes-prompt': { zh: '请使用 release-notes 技能为当前项目生成发布说明。', en: 'Use the release-notes skill to generate release notes for the current project.' },
    'skill-vuln-check-prompt': { zh: '请使用 vuln-check 技能对当前项目做一次安全漏洞检查。', en: 'Use the vuln-check skill to run a security vulnerability check on the current project.' },
    'context-loaded': { zh: '已加载上下文', en: 'Context loaded' },
    'copied-chars': { zh: '已复制 {{n}} 个字符', en: 'Copied {{n}} characters' },
    'activity-usage-name': { zh: '/activity frames <名>', en: '/activity frames <name>' },
    'activity-current-preset': { zh: '当前预设  {{name}}', en: 'Current preset  {{name}}' },
    'activity-switch-hint': { zh: '切换      /activity（选择器）或 /activity frames <名>', en: 'Switch      /activity (picker) or /activity frames <name>' },
    'activity-persist-hint': { zh: '持久化    ~/.dsh-cc/working-activity.json（重启后仍生效）', en: 'Persisted    ~/.dsh-cc/working-activity.json (survives restart)' },
    'activity-current-direct': { zh: '当前预设：{{name}} · /activity frames <名> 直接切换：', en: 'Current preset: {{name}} · /activity frames <name> to switch directly:' },
    'activity-random-each': { zh: '每次随机', en: 'random each time' },
    'activity-current-marker': { zh: '  ← 当前', en: '  ← current' },
    'activity-usage': { zh: '用法：/activity | /activity frames <名> | /activity status', en: 'Usage: /activity | /activity frames <name> | /activity status' },
    'preset-current': { zh: '当前 preset  {{name}}', en: 'Current preset  {{name}}' },
    'preset-roster-missing': { zh: '（未挂载名册）', en: '(roster not mounted)' },
    'preset-switch-hint': { zh: '切换        /preset（选择器）或 /preset <id>', en: 'Switch        /preset (picker) or /preset <id>' },
    'preset-persist-hint': { zh: '持久化      ~/.dsh-cc/agent-preset.json（重启后仍生效；cordis.yml preset 优先）', en: 'Persisted      ~/.dsh-cc/agent-preset.json (survives restart; cordis.yml preset wins)' },
    'preset-lock-hint': { zh: '锁定规则    已开始的会话不可切换（官方 blank-only 规则）', en: 'Lock rule     started sessions cannot switch (official blank-only rule)' },
    'preset-roster-unmounted': { zh: '当前组合未挂载 agent-presets 名册（preset 不可用）', en: 'The agent-presets roster is not mounted (presets unavailable)' },
    'theme-name-arg': { zh: '/theme <名字>', en: '/theme <name>' },
    'theme-current': { zh: '当前主题  {{name}}', en: 'Current theme  {{name}}' },
    'theme-switch-hint': { zh: '切换      /theme（选择器）或 /theme <名字>', en: 'Switch      /theme (picker) or /theme <name>' },
    'theme-persist-hint': { zh: '持久化    ~/.dsh-cc/theme.json（重启后仍生效；CC_TUI_THEME 优先）', en: 'Persisted    ~/.dsh-cc/theme.json (survives restart; CC_TUI_THEME wins)' },
    'theme-custom-hint': { zh: '自定义    ~/.dsh-cc/themes/<名字>.json（见 README「自定义主题」）', en: 'Custom      ~/.dsh-cc/themes/<name>.json (see README "Custom themes")' },
    'theme-switched-saved': { zh: '主题已切换：{{name}}（已保存）', en: 'Theme switched: {{name}} (saved)' },
    'theme-unknown': { zh: '未知主题「{{name}}」· /theme 查看全部', en: 'Unknown theme "{{name}}" · /theme to view all' },
    'status-model': { zh: '模型   {{model}}', en: 'Model   {{model}}' },
    'status-working': { zh: '工作中', en: 'working' },
    'status-idle': { zh: '空闲', en: 'idle' },
    'status-state': { zh: '状态   {{state}}', en: 'Status   {{state}}' },
    'status-session': { zh: '会话   {{id}}', en: 'Session   {{id}}' },
    'status-dir': { zh: '目录   {{cwd}}', en: 'Directory   {{cwd}}' },
    'cost-cache-rate': { zh: '缓存率 {{rate}}% · {{read}} 读 / {{write}} 写', en: 'Cache rate {{rate}}% · {{read}} read / {{write}} write' },
    'cost-context': { zh: '上下文 {{pct}}%', en: 'Context {{pct}}%' },
    'status-title': { zh: '标题   {{title}}', en: 'Title   {{title}}' },
    'cost-cache-hit-rate': { zh: '缓存命中率 {{rate}}% · 缓存 {{read}} 读 / {{write}} 写', en: 'Cache hit rate {{rate}}% · cache {{read}} read / {{write}} write' },
    'cost-note': { zh: '注：DSH 不提供 API 费用计量，以上为 token 用量（按 provider 账单计费）', en: 'Note: DSH provides no API cost metering; the above is token usage (billed by your provider)' },
    'doctor-example-config': { zh: '示例配置  {{path}}', en: 'Example config  {{path}}' },
    'doctor-user-config': { zh: '用户配置  {{path}}', en: 'User config  {{path}}' },
    'doctor-launch-hint': { zh: '启动方式  dsh-tui.cmd / dsh --profile dsh-tui', en: 'Launch      dsh-tui.cmd / dsh --profile dsh-tui' },
    'doctor-route-hint': { zh: '模型路由  由 cordis.yml 的 llm-deepseek 段决定（/model 仅提示重启生效）', en: 'Model route  set by the llm-deepseek block in cordis.yml (/model only hints at restart)' },
    'export-failed': { zh: '导出失败（无法写入工作目录）', en: 'Export failed (cannot write to working directory)' },
    'export-saved': { zh: '已导出: {{target}}', en: 'Exported: {{target}}' },
    'agentsmd-create-failed': { zh: '创建 AGENTS.md 失败', en: 'Failed to create AGENTS.md' },
    'agentsmd-exists': { zh: 'AGENTS.md 已存在，未覆盖', en: 'AGENTS.md already exists, not overwritten' },
    'agentsmd-created': { zh: '已创建 {{result}}', en: 'Created {{result}}' },
    'login-api-key': { zh: 'API key: {{key}}', en: 'API key: {{key}}' },
    'login-key-missing': { zh: '未配置（DEEPSEEK_API_KEY）', en: 'not configured (DEEPSEEK_API_KEY)' },
    'login-base-url': { zh: 'Base URL: {{url}}', en: 'Base URL: {{url}}' },
    'login-official-endpoint': { zh: '官方端点', en: 'official endpoint' },
    'login-source-hint': { zh: '来源：环境变量 → 工作区 .env（run.ts 兜底读取）', en: 'Source: env var → workspace .env (run.ts fallback)' },
    'login-logout-hint': { zh: 'DSH 凭证来自环境变量 DEEPSEEK_API_KEY — 删除该环境变量后重启 dsh-tui 即登出', en: 'DSH credentials come from the DEEPSEEK_API_KEY env var — remove it and restart dsh-tui to log out' },
    'permissions-policy-hint': { zh: 'DSH 权限策略由 fs-policy / bash-sandbox 配置决定（当前 leaf：workspace 内读写、写入需已读文件）。', en: 'DSH permission policy is set by fs-policy / bash-sandbox config (current leaf: read/write in workspace, writes need a prior read).' },
    'permissions-approval-hint': { zh: 'DSH 的 /permission 预设切换需要 approval 服务 + 审批 UI，dsh-tui 未挂载。', en: 'DSH /permission preset switching needs the approval service + approval UI, not mounted in dsh-tui.' },
    'permissions-root-hint': { zh: '当前文件系统策略以工作目录为根：{{cwd}}', en: 'Current filesystem policy is rooted at the working directory: {{cwd}}' },
    'permissions-path-hint': { zh: '模型工具相对路径均解析自该目录；跨目录访问由 fs-policy 拦截。', en: 'Relative paths of model tools resolve from this directory; cross-directory access is blocked by fs-policy.' },
    'hooks-not-mounted': { zh: 'DSH hooks（dsh-hooks-claude / dsh-hooks-codex）未在本 leaf 挂载。', en: 'DSH hooks (dsh-hooks-claude / dsh-hooks-codex) are not mounted in this leaf.' },
    'hooks-mount-hint': { zh: '需要时可在 cordis.yml 挂载对应 hooks 插件。', en: 'Mount the matching hooks plugin in cordis.yml when needed.' },
    'memory-none': { zh: 'DSH 暂无持久记忆服务。', en: 'DSH has no persistent memory service yet.' },
    'memory-hint': { zh: '长期约定可写入 AGENTS.md（工作区上下文）或技能（~/.dsh/skills）。', en: 'Long-term conventions can go into AGENTS.md (workspace context) or skills (~/.dsh/skills).' },
    'update-unavailable': { zh: '当前运行方式不支持自动更新（需经 dsh --profile 启动），请在终端执行 dsh plugin --profile <name> update @deepseek-harness-tui/dsh-tui', en: 'Automatic update is unavailable in this launch mode (needs dsh --profile). Run dsh plugin --profile <name> update @deepseek-harness-tui/dsh-tui in a terminal.' },
    'update-working': { zh: '当前回合仍在运行，请等待完成后再更新 TUI。', en: 'The current turn is still running. Wait for it to finish before updating the TUI.' },
    'update-starting': { zh: '正在更新 @deepseek-harness-tui/dsh-tui，完成后会自动重启并恢复当前会话……', en: 'Updating @deepseek-harness-tui/dsh-tui. The TUI will restart and resume this session when finished…' },
    'update-available': { zh: '发现新版本：v{{latest}}（当前 v{{current}}）· 输入 /update 更新 TUI', en: 'New version available: v{{latest}} (current v{{current}}) · type /update to update the TUI' },
    'update-already-latest': { zh: '当前已是最新版本（v{{current}}）。', en: 'Already on the latest version (v{{current}}).' },
    'update-check-failed': { zh: '无法确认新版本（网络或 registry 不可达），已尝试直接更新……', en: 'Could not confirm a newer version (network or registry unreachable); attempting the update anyway…' },
    'vim-not-implemented': { zh: 'vim 模式暂未实现', en: 'vim mode not implemented yet' },
    'terminal-setup-hint': { zh: '推荐 Windows Terminal（≥110 列、等宽字体、TrueColor）。', en: 'Recommended: Windows Terminal (≥110 columns, monospace, TrueColor).' },
    'terminal-paste-hint': { zh: 'Ctrl+V 粘贴文本/文件路径；Ctrl+Shift+V 终端原生粘贴；右键粘贴同样可用。', en: 'Ctrl+V pastes text/file paths; Ctrl+Shift+V is native terminal paste; right-click paste also works.' },
    'connect-none': { zh: 'DSH 暂无远程连接机制（CC 的 /connect 对应能力未适配）。', en: 'DSH has no remote connection mechanism (CC\'s /connect equivalent is not adapted).' },
    'theme-switch-failed': { zh: '主题「{{name}}」切换失败（无法写入 ~/.dsh-cc/theme.json）', en: 'Theme "{{name}}" switch failed (cannot write ~/.dsh-cc/theme.json)' },
    'interrupt-delivered': { zh: '已打断当前回合，{{n}} 条消息立即处理', en: 'Interrupted current turn, {{n}} messages processed immediately' },
    // ── components/ActivityLine.tsx ──────────────────────────────────────
    'activity-ctx-warn': { zh: '⚠ 上下文', en: '⚠ ctx ' },
    // ── components/ActivityPicker.tsx ─────────────────────────────────────
    'activity-random-each-preset': { zh: '每次随机一个预设', en: 'random preset each time' },
    // ── components/PresetPicker.tsx ──────────────────────────────────────
    'preset-default-tag': { zh: '（默认）', en: ' (default)' },
    'preset-broken-tag': { zh: '（无法加载）', en: ' (failed to load)' },
    // ── channel.ts — reasoning-effort notifications ──────────────────────
    'effort-unavailable': { zh: '推理等级切换不可用（llm 服务未挂载）', en: 'Reasoning effort switching unavailable (llm service not mounted)' },
    'effort-read-failed': { zh: '推理等级读取失败 · {{error}}', en: 'Failed to read reasoning efforts · {{error}}' },
    'effort-single-tier': { zh: '当前模型只有一档推理等级（{{name}}）', en: 'Current model has a single reasoning effort ({{name}})' },
    'effort-unsupported': { zh: '当前模型不支持推理等级切换', en: 'Current model does not support reasoning effort switching' },
    'effort-switched': { zh: '推理强度 → {{name}}', en: 'Reasoning effort → {{name}}' },
    // ── components/LogoV2.tsx ───────────────────────────────────────────
    'logo-tagline': { zh: '探索未至之境！', en: 'Explore the uncharted!' },
    'logo-tip-model': { zh: '切换模型', en: 'switch model' },
    'logo-tip-help': { zh: '查看命令', en: 'view commands' },
    'logo-tip-tab': { zh: '自动补全', en: 'autocomplete' },
    // ── components/PromptInput.tsx ──────────────────────────────────────
    'input-sent-after-turn': { zh: '已发送，当前回合结束后处理', en: 'Sent, processed after the current turn' },
    'input-interrupted-next': { zh: '已插话 · 下一步立即处理', en: 'Interrupted · processed next' },
    'input-queued-after-turn': { zh: '已排队 · 回合结束后处理', en: 'Queued · processed after the turn' },
    'input-cannot-retract': { zh: '无法撤回：消息可能已被处理，或当前版本不支持', en: 'Cannot retract: the message may already be processed, or this version doesn\'t support it' },
    'input-retracted': { zh: '已撤回，可编辑后重新发送', en: 'Retracted, editable and resendable' },
    'input-empty': { zh: '输入为空，没有可发送的内容', en: 'Empty input, nothing to send' },
    'input-interrupt-immediate': { zh: '已打断当前回合，正在立即处理', en: 'Interrupted current turn, processing immediately' },
    'input-clipboard-empty': { zh: '剪贴板为空', en: 'Clipboard is empty' },
    'input-pending-steer-label': { zh: '插话 · 下一步送达', en: 'Steer · delivered next' },
    'input-pending-queue-label': { zh: '排队 · 回合结束后送达', en: 'Queued · delivered after the turn' },
    'input-pending-actions-hint': { zh: '撤回 · Esc 打断并立即发送', en: 'Retract · Esc interrupts and sends immediately' },
    // ── components/whaleFrames.ts (frame labels) ────────────────────────
    'frame-blink': { zh: '眨眼', en: 'blink' },
    'frame-fin-1': { zh: '动腹鳍1', en: 'fin1' },
    'frame-fin-2': { zh: '动腹鳍2', en: 'fin2' },
    'frame-spout-1': { zh: '喷水花1', en: 'spout1' },
    'frame-spout-2': { zh: '喷水花2', en: 'spout2' },
    'frame-spout-3': { zh: '喷水花3', en: 'spout3' },
    'frame-spout-4': { zh: '喷水花4', en: 'spout4' },
    'frame-spout-5': { zh: '喷水花5', en: 'spout5' },
    'frame-spout-6': { zh: '喷水花6', en: 'spout6' },
    'frame-tail-1': { zh: '摆尾巴1', en: 'tail1' },
    'frame-tail-2': { zh: '摆尾巴2', en: 'tail2' },
    'frame-tail-3': { zh: '摆尾巴3', en: 'tail3' },
    // ── components/MessageList.tsx ──────────────────────────────────────
    'load-earlier': { zh: ' ↑ 加载更早消息（会话日志完整，/export 导出全文） ', en: ' ↑ load earlier messages (full session log; /export for full text) ' },
    'resume-none-in-cwd': { zh: '当前目录没有可恢复的历史会话', en: 'No resumable sessions in the current directory' },
    'compact-summary-folded': { zh: '摘要已折叠', en: 'Summary folded' },
    // ── components/ThemePicker.tsx ──────────────────────────────────────
    'theme-builtin-base': { zh: '内置 · {{name}} 基底', en: 'Built-in · {{name}} base' },
    'theme-user-base': { zh: '{{base}} 基底 · ~/.dsh-cc/themes/{{name}}.json', en: '{{base}} base · ~/.dsh-cc/themes/{{name}}.json' },
    // ── components/LoadedContextPanel.tsx ───────────────────────────────
    'context-panel-collapse': { zh: '折叠', en: 'Collapse' },
    'context-panel-expand': { zh: '展开', en: 'Expand' },
    'context-panel-sections': { zh: '系统提示词 · {{n}} 段', en: 'System prompt · {{n}} sections' },
    'context-panel-files': { zh: '工作区指令 · {{n}} 个文件', en: 'Workspace instructions · {{n}} files' },
    'context-panel-runtime': { zh: '运行时上下文 · {{n}} 项', en: 'Runtime context · {{n}} items' },
    'context-panel-skills': { zh: '技能 · {{n}}', en: 'Skills · {{n}}' },
    'context-panel-tools': { zh: '工具 · {{n}}', en: 'Tools · {{n}}' },
    // ── components/questions/AskUserQuestionPanel.tsx ───────────────────
    'question-select-or-answer': { zh: '至少选择一个选项，或在最后一行输入回答', en: 'Select at least one option, or type an answer on the last line' },
    'question-answer-or-check': { zh: '输入回答或勾选选项后再提交', en: 'Type an answer or check options before submitting' },
    'question-type-answer-first': { zh: '先输入回答内容再提交', en: 'Type your answer before submitting' },
    'question-header-progress': { zh: ' 提问 · 第 {{position}}/{{total}} 题{{remaining}} ', en: ' Question {{position}}/{{total}} {{remaining}} ' },
    'question-remaining-more': { zh: ' · 还剩 {{n}} 题', en: ' · {{n}} left' },
    'question-hint-type': { zh: '输入回答', en: 'Type answer' },
    'question-hint-enter': { zh: 'Enter 提交', en: 'Enter submit' },
    'question-hint-back': { zh: '↑ 返回选项', en: '↑ back to options' },
    'question-hint-esc': { zh: 'Esc 中断', en: 'Esc cancel' },
    'question-hint-selected': { zh: '已选 {{n}}', en: 'Selected {{n}}' },
    'question-hint-select': { zh: '↑/↓ 选择', en: '↑/↓ select' },
    'question-hint-multi': { zh: 'Space 多选', en: 'Space multi-select' },
    'question-hint-attach': { zh: '输入文字附带回答', en: 'Type text to attach an answer' },
    'question-custom-tab': { zh: '自定义回答', en: 'Custom answer' },
    'question-attached-label': { zh: '（附加：{{label}}）', en: '(attached: {{label}})' },
    'question-direct-input': { zh: '直接输入…', en: 'Type directly…' },
    // ── /lang command ───────────────────────────────────────────────────
    'lang-current': { zh: '当前语言  {{lang}}', en: 'Current language  {{lang}}' },
    'lang-switch-hint': { zh: '切换      /lang en | /lang zh', en: 'Switch      /lang en | /lang zh' },
    'lang-persist-hint': { zh: '持久化    ~/.dsh-cc/lang.json（重启后仍生效；CC_TUI_LANG 优先）', en: 'Persisted    ~/.dsh-cc/lang.json (survives restart; CC_TUI_LANG wins)' },
    'lang-switched': { zh: '语言已切换：{{lang}}（已保存）', en: 'Language switched: {{lang}} (saved)' },
    'lang-unknown': { zh: '未知语言「{{lang}}」· /lang 查看全部（en / zh）', en: 'Unknown language "{{lang}}" · /lang to view all (en / zh)' },
    'lang-switch-failed': { zh: '语言「{{lang}}」切换失败（无法写入 ~/.dsh-cc/lang.json）', en: 'Language "{{lang}}" switch failed (cannot write ~/.dsh-cc/lang.json)' },
};
/** The active language, module-level so non-React modules (channel.ts,
 *  loaded-context.ts) resolve strings without a context. Defaults to `zh`
 *  (the original hard-coded language). */
let activeLang = 'zh';
const listeners = new Set();
/** Subscribe to language switches (mirrors themePrefs subscription style). */
export function subscribeLang(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
/** The currently active language. */
export function getLang() {
    return activeLang;
}
/** Switch the active language and notify subscribers. */
export function setLang(lang) {
    activeLang = lang;
    for (const listener of listeners)
        listener();
}
/** Is a string a valid shipped language code? */
export function isLang(value) {
    return value === 'zh' || value === 'en';
}
/**
 * Translate a dictionary key into the active language, substituting
 * `{{name}}` placeholders with params. Missing keys render the key itself
 * so a typo is visible instead of silently blank.
 * @param key - Dictionary key (see dict).
 * @param params - Placeholder values.
 */
export function t(key, params = {}) {
    const entry = dict[key];
    const template = entry?.[activeLang] ?? key;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => name in params ? String(params[name]) : match);
}
// ── persistence (~/.dsh-cc/lang.json) ──────────────────────────────────
/**
 * Parse a persisted `{ lang }` value; anything else yields undefined.
 * @param text - Raw file contents.
 */
export function parseLangPref(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const lang = parsed.lang;
        return isLang(lang) ? lang : undefined;
    }
    catch {
        return undefined;
    }
}
/** The persisted `/lang` choice, or undefined when unset or invalid. */
export function readLangPref(dir = PREFS_DIR) {
    try {
        return parseLangPref(readFileSync(join(dir, 'lang.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Persist the chosen language (best effort). */
export function writeLangPref(lang, dir = PREFS_DIR) {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'lang.json'), JSON.stringify({ lang }, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Guess the user's language from the OS locale (`LC_ALL`, `LC_MESSAGES`,
 * `LANG`), defaulting to `zh`. Only consulted when nothing else (env var,
 * cordis.yml `lang`, persisted `/lang` choice) pinned a language.
 */
export function detectLocaleLang() {
    const raw = process.env.LC_ALL ??
        process.env.LC_MESSAGES ??
        process.env.LANG ??
        '';
    const locale = raw.split('.')[0]?.toLowerCase() ?? '';
    if (locale.startsWith('zh'))
        return 'zh';
    if (locale.startsWith('en'))
        return 'en';
    return 'zh';
}
/**
 * Resolve the startup language: the persisted `/lang` choice, else the OS
 * locale guess, else `zh` (the original hard-coded language). The env var /
 * config precedence lives in plugin.apply (see {@link resolveStartupLang}
 * consumers).
 */
export function resolveStartupLang() {
    return readLangPref() ?? detectLocaleLang();
}
