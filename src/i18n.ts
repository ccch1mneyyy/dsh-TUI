/**
 * dsh-tui localization — UI strings for Chinese (`zh`, the default) and
 * English (`en`).
 *
 * Resolution order mirrors the `/theme` mechanism (see themePrefs.ts):
 *
 *   1. `DSH_TUI_LANG` env var (`en` / `zh`) — pinned at process start
 *   2. `lang` cordis.yml config key (see Config in index.ts)
 *   3. the persisted `/lang` choice in `~/.dsh-tui/lang.json`
 *   4. the OS locale guess (`LC_ALL` / `LC_MESSAGES` / `LANG`)
 *   5. `zh` (the original hard-coded language)
 *
 * `/lang` switches at runtime and hot-swaps the whole UI. The dictionary is
 * a flat key → per-language string map; `t(key, params)` substitutes
 * `{{name}}` placeholders with the given params. Missing keys render the
 * key itself so a typo is visible in the UI instead of silently blank.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

export type Lang = 'zh' | 'en'

const PREFS_DIR = DATA_DIR

/** The languages shipped with the plugin, in display order. */
export const LANGS = ['zh', 'en'] as const

const dict = {
  // ── channel.ts ───────────────────────────────────────────────────────
  'activity-indicator-already': { zh: '指示器已是：{{name}}', en: 'Indicator already set: {{name}}' },
  'activity-indicator-switched': { zh: '指示器已切换：{{name}}（已保存）', en: 'Indicator switched: {{name}} (saved)' },
  'activity-pref-write-failed': { zh: '无法写入 ~/.dsh-tui/working-activity.json，切换未保存', en: 'Cannot write ~/.dsh-tui/working-activity.json, switch not saved' },
  'model-pref-write-failed': { zh: '无法写入 ~/.dsh-tui/model.json，模型选择不会保存到重启后', en: 'Cannot write ~/.dsh-tui/model.json, the model choice will not survive a restart' },
  'model-route-invalid': { zh: '持久化的模型路由 {{provider}}/{{model}} 不在该 provider 的模型列表中，已整体回退到 {{fallback}}', en: 'Persisted model route {{provider}}/{{model}} is not advertised by that provider; fell back to {{fallback}}' },
  'unknown-activity-preset': { zh: '未知预设「{{name}}」· /activity frames 查看全部', en: 'Unknown preset "{{name}}" · /activity frames to view all' },
  'preset-unavailable': { zh: 'Preset 不可用——当前组合未挂载 agent-presets 名册', en: 'Preset unavailable — the agent-presets roster is not mounted' },
  'preset-agent-running': { zh: 'Agent 运行中，无法切换 preset', en: 'Agent is running, cannot switch preset' },
  'preset-not-found': { zh: 'Preset「{{id}}」不存在 · {{err}}', en: 'Preset "{{id}}" not found · {{err}}' },
  'preset-load-failed': { zh: 'Preset「{{id}}」无法加载 · {{broken}}', en: 'Preset "{{id}}" failed to load · {{broken}}' },
  'preset-already-current': { zh: '当前 preset 已是：{{id}}', en: 'Current preset already: {{id}}' },
  'preset-pref-write-failed': { zh: '无法写入 ~/.dsh-tui/agent-preset.json，选择未保存', en: 'Cannot write ~/.dsh-tui/agent-preset.json, selection not saved' },
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
  'doctor-legacy-dir': { zh: '旧数据目录: ~/.dsh-tui 仍存在（已迁移到 ~/.dsh-tui，确认无误后可自行删除）', en: 'Legacy data directory: ~/.dsh-tui still exists (migrated to ~/.dsh-tui; delete it yourself once satisfied)' },
  'subagent-not-mounted': { zh: '子代理服务未挂载（leaf 未启用 subagent）', en: 'Subagent service not mounted (leaf has no subagent)' },
  'subagent-none': { zh: '当前会话暂无子代理', en: 'No subagents in the current session' },
  'subagent-resumable': { zh: '可续', en: 'resumable' },
  'subagent-oneshot': { zh: '一次性', en: 'one-shot' },
  'subagent-row': { zh: '{{mode}} {{label}}{{activity}} · {{id}}', en: '{{mode}} {{label}}{{activity}} · {{id}}' },
  'subagent-running': { zh: ' 运行中', en: ' running' },
  'subagent-archived': { zh: ' 已归档', en: ' archived' },
  'subagent-query-failed': { zh: '查询失败 · {{err}}', en: 'Query failed · {{err}}' },
  'agent-preset-switched': { zh: 'Agent preset 已切换：{{preset}}', en: 'Agent preset switched: {{preset}}' },
  'context-low-warning': { zh: '上下文即将耗尽（剩余 {{percent}}%）· 运行 /clear 或新建会话', en: 'Context low ({{percent}}% remaining) · Run /clear or start a new session' },
  'rewind-unavailable': { zh: '回退不可用——会话服务未加载', en: 'Rewind unavailable — session services not loaded' },
  'rewind-settling': { zh: '无法回退——回合仍在收尾，请稍候再试', en: 'Cannot rewind — the turn is still settling, try again in a moment' },
  'rewind-fork-failed': { zh: '无法回退到该处 · {{err}}', en: 'Cannot rewind to this point · {{err}}' },
  'rewind-create-failed': { zh: '回退失败——无法创建替代会话', en: 'Rewind failed — could not create the replacement session' },
  'rewind-attach-failed': { zh: '已回退，但工作区挂载失败 · {{err}}', en: 'Session rewound, but workspace attachment failed · {{err}}' },
  'resume-while-working': { zh: '回合运行中，无法恢复会话', en: 'Cannot resume while a turn is running' },
  'resume-unavailable': { zh: '恢复不可用——agents 服务未加载', en: 'Resume unavailable — agents service not loaded' },
  'resume-failed': { zh: '恢复失败 · {{err}}', en: 'Resume failed · {{err}}' },
  'resume-attach-failed': { zh: '已恢复会话，但工作区挂载失败 · {{err}}', en: 'Session resumed, but workspace attachment failed · {{err}}' },
  'new-session-while-working': { zh: '回合运行中，无法新建会话', en: 'Cannot start a new session while a turn is running' },
  'new-session-unavailable': { zh: '新建会话不可用——agents 服务未加载', en: 'New session unavailable — agents service not loaded' },
  'new-session-failed': { zh: '新建会话失败 · {{err}}', en: 'New session failed · {{err}}' },
  'new-session-attach-failed': { zh: '会话已创建，但工作区挂载失败 · {{err}}', en: 'Session created, but workspace attachment failed · {{err}}' },
  'model-switch-while-working': { zh: '回合运行中，无法切换模型', en: 'Cannot switch models while a turn is running' },
  'model-switch-unavailable': { zh: '模型切换不可用——会话服务未加载', en: 'Model switch unavailable — session services not loaded' },
  'model-switch-fork-failed': { zh: '无法切换模型 · {{err}}', en: 'Cannot switch models · {{err}}' },
  'model-switch-failed': { zh: '模型切换失败 · {{err}}', en: 'Model switch failed · {{err}}' },
  'model-switch-attach-failed': { zh: '模型已切换，但工作区挂载失败 · {{err}}', en: 'Model switched, but workspace attachment failed · {{err}}' },
  'compact-unavailable': { zh: '压缩不可用——当前 leaf 没有压缩服务', en: 'Compaction unavailable · no compaction service in this leaf' },
  'compact-while-working': { zh: '回合运行中，无法压缩会话', en: 'Cannot compact while a turn is running' },
  'compact-working': { zh: '正在压缩会话…', en: 'Compacting conversation…' },
  'compact-done': { zh: '会话已压缩', en: 'Conversation compacted' },
  'compact-nothing': { zh: '没有可压缩的内容', en: 'Nothing to compact' },
  'compact-failed': { zh: '压缩失败 · {{err}}', en: 'Compaction failed · {{err}}' },
  'turn-failed': { zh: '回合出错{{detail}}', en: 'Turn error{{detail}}' },

  // ── questions.ts ─────────────────────────────────────────────────────
  'questionnaire-answered': { zh: '📋 问卷已答 · {{total}} 题', en: '📋 Questionnaire answered · {{total}} questions' },

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
  'skill-unavailable': { zh: '技能 {{name}} 已不可用或未开放用户直调', en: 'Skill {{name}} is gone or not user-invocable' },
  'skill-audit-prompt': { zh: '请使用 audit 技能对当前项目做一次全面的代码审计，找出安全、正确性与质量问题。', en: 'Use the audit skill to do a thorough code audit of the current project, finding security, correctness and quality issues.' },
  'skill-bug-prompt': { zh: '请使用 bug 技能协助我记录一份完整的 bug 报告（现象、复现步骤、期望行为）。', en: 'Use the bug skill to help me write a complete bug report (symptoms, reproduction steps, expected behavior).' },
  'skill-practice-prompt': { zh: '请使用 practice 技能陪我进行一轮编程练习。', en: 'Use the practice skill to run a round of programming practice with me.' },
  'skill-review-prompt': { zh: '请使用 review 技能对当前项目做一次全面的代码评审。', en: 'Use the review skill to do a thorough code review of the current project.' },
  'skill-pr-comments-prompt': { zh: '请使用 pr-comments 技能审查当前分支的拉取请求评论并给出改进建议。', en: 'Use the pr-comments skill to review pull request comments on the current branch and suggest improvements.' },
  'skill-release-notes-prompt': { zh: '请使用 release-notes 技能为当前项目生成发布说明。', en: 'Use the release-notes skill to generate release notes for the current project.' },
  'skill-vuln-check-prompt': { zh: '请使用 vuln-check 技能对当前项目做一次安全漏洞检查。', en: 'Use the vuln-check skill to run a security vulnerability check on the current project.' },
  'context-loaded': { zh: '已加载上下文', en: 'Context loaded' },
  'context-panel-expand': { zh: '展开', en: 'Expand' },
  'context-panel-collapse': { zh: '折叠', en: 'Collapse' },
  'copied-chars': { zh: '已复制 {{n}} 个字符', en: 'Copied {{n}} characters' },
  'activity-usage-name': { zh: '/activity frames <名>', en: '/activity frames <name>' },
  'activity-current-preset': { zh: '当前预设  {{name}}', en: 'Current preset  {{name}}' },
  'activity-switch-hint': { zh: '切换      /activity（选择器）或 /activity frames <名>', en: 'Switch      /activity (picker) or /activity frames <name>' },
  'activity-persist-hint': { zh: '持久化    ~/.dsh-tui/working-activity.json（重启后仍生效）', en: 'Persisted    ~/.dsh-tui/working-activity.json (survives restart)' },
  'activity-current-direct': { zh: '当前预设：{{name}} · /activity frames <名> 直接切换：', en: 'Current preset: {{name}} · /activity frames <name> to switch directly:' },
  'activity-random-each': { zh: '每次随机', en: 'random each time' },
  'activity-current-marker': { zh: '  ← 当前', en: '  ← current' },
  'activity-usage': { zh: '用法：/activity | /activity frames <名> | /activity status', en: 'Usage: /activity | /activity frames <name> | /activity status' },
  'preset-current': { zh: '当前 preset  {{name}}', en: 'Current preset  {{name}}' },
  'preset-roster-missing': { zh: '（未挂载名册）', en: '(roster not mounted)' },
  'preset-switch-hint': { zh: '切换        /preset（选择器）或 /preset <id>', en: 'Switch        /preset (picker) or /preset <id>' },
  'preset-persist-hint': { zh: '持久化      ~/.dsh-tui/agent-preset.json（重启后仍生效；cordis.yml preset 优先）', en: 'Persisted      ~/.dsh-tui/agent-preset.json (survives restart; cordis.yml preset wins)' },
  'preset-lock-hint': { zh: '锁定规则    已开始的会话不可切换（官方 blank-only 规则）', en: 'Lock rule     started sessions cannot switch (official blank-only rule)' },
  'preset-roster-unmounted': { zh: '当前组合未挂载 agent-presets 名册（preset 不可用）', en: 'The agent-presets roster is not mounted (presets unavailable)' },
  'theme-name-arg': { zh: '/theme <名字>', en: '/theme <name>' },
  'theme-current': { zh: '当前主题  {{name}}', en: 'Current theme  {{name}}' },
  'theme-switch-hint': { zh: '切换      /theme（选择器）或 /theme <名字>', en: 'Switch      /theme (picker) or /theme <name>' },
  'theme-persist-hint': { zh: '持久化    ~/.dsh-tui/theme.json（重启后仍生效；DSH_TUI_THEME 优先）', en: 'Persisted    ~/.dsh-tui/theme.json (survives restart; DSH_TUI_THEME wins)' },
  'theme-custom-hint': { zh: '自定义    ~/.dsh-tui/themes/<名字>.json（见 README「自定义主题」）', en: 'Custom      ~/.dsh-tui/themes/<name>.json (see README "Custom themes")' },
  'theme-auto-resolved': { zh: '自动解析  当前为 {{name}}（跟随终端背景）', en: 'Auto-resolved  currently {{name}} (follows terminal background)' },
  'theme-switched-saved': { zh: '主题已切换：{{name}}（已保存）', en: 'Theme switched: {{name}} (saved)' },
  'theme-unknown': { zh: '未知主题「{{name}}」· /theme 查看全部', en: 'Unknown theme "{{name}}" · /theme to view all' },
  'status-model': { zh: '模型   {{model}}', en: 'Model   {{model}}' },
  'status-working': { zh: '工作中', en: 'working' },
  'status-idle': { zh: '空闲', en: 'idle' },
  'status-state': { zh: '状态   {{state}}', en: 'Status   {{state}}' },
  'status-session': { zh: '会话   {{id}}', en: 'Session   {{id}}' },
  'status-dir': { zh: '目录   {{cwd}}', en: 'Directory   {{cwd}}' },
  'workspace-picker-title': { zh: '工作区', en: 'Workspace' },
  'workspace-picker-hint': { zh: '**Enter** 切换并新建会话 · Esc 退出 · 也可输入 /workspace open <路径或 URI>', en: '**Enter** switch and start a new session · Esc to exit · or type /workspace open <path-or-URI>' },
  'workspace-none': { zh: '没有可用工作区', en: 'No workspaces available' },
  'workspace-list-failed': { zh: '读取工作区失败 · {{err}}', en: 'Failed to list workspaces · {{err}}' },
  'workspace-uri-invalid': { zh: '无法解析工作区目标：{{uri}}', en: 'Cannot resolve workspace target: {{uri}}' },
  'workspace-uri-failed': { zh: '加载工作区失败 · {{err}}', en: 'Failed to load workspace · {{err}}' },
  'workspace-switch-working': { zh: 'Agent 运行中，无法切换工作区', en: 'Cannot switch workspaces while the agent is running' },
  'workspace-open-invalid': { zh: '无法打开工作区：{target} 不是存在的目录', en: 'Cannot open workspace: {target} is not an existing directory' },
  'workspace-switched': { zh: '已切换工作区：{{target}}', en: 'Workspace switched: {{target}}' },
  'workspace-flow-hint': { zh: '**Enter** 选择 · Esc 退出', en: '**Enter** select · Esc to exit' },
  'workspace-flow-edit-hint': { zh: '**Enter** 选择当前目录 · Tab 手动输入路径 · Esc 退出', en: '**Enter** select current directory · Tab enter a path · Esc to exit' },
  'workspace-flow-input-hint': { zh: '输入绝对路径 · **Enter** 读取目录 · Esc 返回', en: 'Enter an absolute path · **Enter** load directory · Esc back' },
  'workspace-flow-input-empty': { zh: '目录路径不能为空', en: 'Directory path cannot be empty' },
  'workspace-flow-loading': { zh: '正在连接并读取目录… · Esc 关闭', en: 'Connecting and loading directories… · Esc to close' },
  'workspace-command-usage': { zh: '用法：/workspace resume | rename <名称> | open <路径或 URI>{{commands}}', en: 'Usage: /workspace resume | rename <name> | open <path-or-URI>{{commands}}' },
  'workspace-open-usage': { zh: '用法：/workspace open <路径或 URI>', en: 'Usage: /workspace open <path-or-URI>' },
  'workspace-rename-usage': { zh: '用法：/workspace rename <名称>', en: 'Usage: /workspace rename <name>' },
  'workspace-command-unknown': { zh: '未知的 workspace 子命令：{{command}}', en: 'Unknown workspace subcommand: {{command}}' },
  'workspace-command-empty': { zh: '该 workspace 操作没有可选目标', en: 'This workspace action has no available targets' },
  'workspace-command-failed': { zh: 'workspace 操作失败 · {{err}}', en: 'Workspace action failed · {{err}}' },
  'workspace-renamed': { zh: '工作区已重命名：{{title}}', en: 'Workspace renamed: {{title}}' },
  'workspace-rename-failed': { zh: '工作区重命名失败 · {{err}}', en: 'Failed to rename workspace · {{err}}' },
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
  'login-api-key': { zh: 'API key: {{status}}', en: 'API key: {{status}}' },
  'login-key-configured': { zh: '已配置（{{ref}}）', en: 'configured ({{ref}})' },
  'login-key-missing': { zh: '未配置（DEEPSEEK_API_KEY）', en: 'not configured (DEEPSEEK_API_KEY)' },
  'login-credentials-unavailable': { zh: '无法检查（credentials service 不可用）', en: 'unavailable (credentials service unavailable)' },
  'login-credential-source': { zh: '凭据来源: {{source}}', en: 'Credential source: {{source}}' },
  'login-source-none': { zh: '无', en: 'none' },
  'login-credential-storage': { zh: '凭据存储: {{mode}}', en: 'Credential storage: {{mode}}' },
  'login-storage-writable': { zh: '可写', en: 'writable' },
  'login-storage-read-only': { zh: '只读', en: 'read-only' },
  'login-base-url': { zh: 'Base URL: {{url}}', en: 'Base URL: {{url}}' },
  'login-official-endpoint': { zh: '官方端点', en: 'official endpoint' },
  'login-logout-hint': { zh: '使用 /provider 管理 DSH 凭据；若来源为 env，请删除对应环境变量并重启 dsh-tui', en: 'Manage DSH credentials with /provider; for env sources, remove the corresponding environment variable and restart dsh-tui' },
  'permissions-policy-hint': { zh: 'DSH 权限策略由 fs-policy / bash-sandbox 配置决定（当前 leaf：workspace 内读写、写入需已读文件）。', en: 'DSH permission policy is set by fs-policy / bash-sandbox config (current leaf: read/write in workspace, writes need a prior read).' },
  'permissions-approval-hint': { zh: '审批通道已挂载：命令申请权限提升（sandbox_permissions）时弹出审批条，Yes 放行一次、No / Esc 拒绝。', en: 'The approval channel is mounted: sandbox escalations (sandbox_permissions) raise an approval bar — Yes allows once, No / Esc rejects.' },
  'permissions-preset-hint': { zh: '/permission 可查看与切换权限预设（read-only / workspace-write / danger-full-access）。', en: '/permission shows and switches permission presets (read-only / workspace-write / danger-full-access).' },
  'permissions-root-hint': { zh: '当前文件系统策略以工作目录为根：{{cwd}}', en: 'Current filesystem policy is rooted at the working directory: {{cwd}}' },
  'permissions-path-hint': { zh: '模型工具相对路径均解析自该目录；跨目录访问由 fs-policy 拦截。', en: 'Relative paths of model tools resolve from this directory; cross-directory access is blocked by fs-policy.' },
  'hooks-not-mounted': { zh: 'DSH hooks（dsh-hooks-claude / dsh-hooks-codex）未在本 leaf 挂载。', en: 'DSH hooks (dsh-hooks-claude / dsh-hooks-codex) are not mounted in this leaf.' },
  'hooks-mount-hint': { zh: '需要时可在 cordis.yml 挂载对应 hooks 插件。', en: 'Mount the matching hooks plugin in cordis.yml when needed.' },
  'update-unavailable': { zh: '当前运行方式不支持自动更新（需经 dsh --profile 启动），请在终端执行 dsh plugin --profile <name> update @deepseek-harness-tui/dsh-tui', en: 'Automatic update is unavailable in this launch mode (needs dsh --profile). Run dsh plugin --profile <name> update @deepseek-harness-tui/dsh-tui in a terminal.' },
  'update-working': { zh: '当前回合仍在运行，请等待完成后再更新 TUI。', en: 'The current turn is still running. Wait for it to finish before updating the TUI.' },
  'update-starting': { zh: '正在更新 @deepseek-harness-tui/dsh-tui，完成后会自动重启并恢复当前会话……', en: 'Updating @deepseek-harness-tui/dsh-tui. The TUI will restart and resume this session when finished…' },
  'update-available': { zh: '发现新版本：v{{latest}}（当前 v{{current}}）· 输入 /update 更新 TUI', en: 'New version available: v{{latest}} (current v{{current}}) · type /update to update the TUI' },
  'update-already-latest': { zh: '当前已是最新版本（v{{current}}）。', en: 'Already on the latest version (v{{current}}).' },
  'update-check-failed': { zh: '无法确认新版本（网络或 registry 不可达），已尝试直接更新……', en: 'Could not confirm a newer version (network or registry unreachable); attempting the update anyway…' },
  'update-refused-deadlock': { zh: '已取消更新：镜像 registry 目前只能装到 v{{latest}}，而该版本在旧全局启动器的 patch 下会启动死锁（#183/#307）；官方最新为 v{{authoritative}}，待镜像同步后再 /update。', en: 'Update cancelled: the mirror registry can only serve v{{latest}}, which deadlocks boot under older global-launcher patches (#183/#307); official latest is v{{authoritative}} — retry /update after the mirror syncs.' },
  'update-mirror-lag': { zh: '镜像 registry 滞后：本次安装 v{{latest}}；官方最新 v{{authoritative}}，镜像同步后可再 /update。', en: 'Mirror registry lag: installing v{{latest}} now; official latest is v{{authoritative}} — run /update again once the mirror syncs.' },
  'streaming-folded': { zh: '…（前 {{count}} 字符流式期间已折叠，落定后完整显示）', en: '…(first {{count}} chars folded while streaming; full text renders once the turn settles)' },
  'vim-not-implemented': { zh: 'vim 模式暂未实现', en: 'vim mode not implemented yet' },
  'terminal-setup-hint': { zh: '推荐 Windows Terminal（≥110 列、等宽字体、TrueColor）。', en: 'Recommended: Windows Terminal (≥110 columns, monospace, TrueColor).' },
  'terminal-paste-hint': { zh: '{{mod}}V 粘贴文本、文件路径或图片；Ctrl+Shift+V 终端原生粘贴；右键粘贴同样可用。', en: '{{mod}}V pastes text, file paths, or images; Ctrl+Shift+V is native terminal paste; right-click paste also works.' },
  'connect-none': { zh: 'DSH 暂无远程连接机制（CC 的 /connect 对应能力未适配）。', en: 'DSH has no remote connection mechanism (CC\'s /connect equivalent is not adapted).' },
  'theme-switch-failed': { zh: '主题「{{name}}」切换失败（无法写入 ~/.dsh-tui/theme.json）', en: 'Theme "{{name}}" switch failed (cannot write ~/.dsh-tui/theme.json)' },
  'interrupt-delivered': { zh: '已打断当前回合，{{n}} 条消息立即处理', en: 'Interrupted current turn, {{n}} messages processed immediately' },
  'btw-usage': { zh: '用法：/btw <问题> —— 不打断当前对话的快速侧问', en: 'Usage: /btw <question> — quick side question without interrupting the conversation' },
  'btw-answering': { zh: '思考中…', en: 'Answering…' },
  'btw-hint-loading': { zh: 'Esc 取消', en: 'Esc cancel' },
  'btw-hint-done': { zh: '↑/↓ 滚动 · Space/Enter/Esc 关闭 · c 复制', en: '↑/↓ scroll · Space/Enter/Esc dismiss · c copy' },
  'btw-llm-unavailable': { zh: '侧问不可用（llm 服务未挂载）', en: 'Side question unavailable (llm service not mounted)' },
  'exit-press-again': { zh: '再次按 Ctrl+C 退出', en: 'Press Ctrl+C again to exit' },
  'new-session-started': { zh: '已新建会话', en: 'New session started' },
  'command-not-found': { zh: '/{{name}}：没有这个命令', en: '/{{name}}: no such command' },
  'thinking-toggled': { zh: '思考模式：{{state}}', en: 'Thinking {{state}}' },
  'thinking-on': { zh: '开启', en: 'on' },
  'thinking-off': { zh: '关闭', en: 'off' },
  'tokens-usage': { zh: 'Tokens：{{in}} 输入 · {{out}} 输出', en: 'Tokens: {{in}} in · {{out}} out' },
  'tokens-usage-context': { zh: '{{usage}} · 上下文 {{percent}}%', en: '{{usage}} · {{percent}}% of context' },

  // ── plugin.ts — boot-time rename notices (issue #120) ───────────────
  'legacy-dir-migrated': { zh: '数据目录已从 ~/.dsh-tui 复制到 ~/.dsh-tui（旧目录保留，确认无误后可自行删除）', en: 'Data directory copied from ~/.dsh-tui to ~/.dsh-tui (the old directory is kept; delete it yourself once satisfied)' },
  'legacy-env-renamed': { zh: '环境变量 {{old}} 已更名为 {{new}}，旧名不再生效', en: 'Environment variable {{old}} was renamed to {{new}}; the old name no longer takes effect' },

  // ── plugin.ts — /update flow ───────────────────────────────────────
  'update-aborted-no-profile': { zh: 'dsh-tui 更新中止：未解析到 dsh profile。', en: 'dsh-tui update aborted: no dsh profile resolved.' },
  // 0.8.3 launcher alignment bridge: /update only replaces the profile
  // copy; the global `dsh-tui` launcher must be aligned separately.
  'update-launcher-align-unknown': {
    zh: 'Profile 已更新到 v{{version}}。如果你平时使用全局 dsh-tui 命令启动，请同步更新全局启动器：\n  npm install -g @deepseek-harness-tui/dsh-tui@{{version}}',
    en: 'The profile is now v{{version}}. If you normally launch with the global dsh-tui command, align the global launcher too:\n  npm install -g @deepseek-harness-tui/dsh-tui@{{version}}',
  },
  'update-launcher-outdated': {
    zh: 'Profile 已更新到 v{{profile}}，但全局启动器仍是 v{{launcher}}。请同步更新：\n  npm install -g @deepseek-harness-tui/dsh-tui@{{profile}}',
    en: 'The profile is now v{{profile}}, but the global launcher is still v{{launcher}}. Align it with:\n  npm install -g @deepseek-harness-tui/dsh-tui@{{profile}}',
  },

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
  'effort-invalid': { zh: '未知推理等级 {{id}}（当前模型可选：{{ids}}）', en: 'Unknown reasoning effort {{id}} (this model offers: {{ids}})' },
  'effort-current': { zh: '当前推理强度 {{name}}', en: 'Current reasoning effort {{name}}' },
  'effort-usage': { zh: '用法：/effort（滑杆）| /effort <id> | /effort status', en: 'Usage: /effort (slider) | /effort <id> | /effort status' },

  // ── channel.ts — Shift+Tab session modes ────────────────────────────
  'mode-switched': { zh: '模式 → {{name}}', en: 'Mode → {{name}}' },
  'mode-default': { zh: '默认', en: 'default' },
  'mode-plan': { zh: '计划模式', en: 'plan mode' },
  'mode-full': { zh: '完全访问', en: 'full access' },
  'mode-plan-unavailable': { zh: '当前 preset 未注册 /plan 命令，无法切换计划模式', en: 'The active preset does not register /plan; cannot toggle plan mode' },

  // ── components/LogoV2.tsx ───────────────────────────────────────────
  'logo-tagline': { zh: '探索未至之境！', en: 'Explore the uncharted!' },
  'logo-tip-model': { zh: '切换模型', en: 'switch model' },
  'logo-tip-help': { zh: '查看命令', en: 'view commands' },
  'logo-tip-tab': { zh: '自动补全', en: 'autocomplete' },
  'logo-tip-prefix': { zh: '提示：', en: 'Tip: ' },

  // ── components/PromptInput.tsx ──────────────────────────────────────
  'input-sent-after-turn': { zh: '已发送，当前回合结束后处理', en: 'Sent, processed after the current turn' },
  'input-interrupted-next': { zh: '已插话 · 下一步立即处理', en: 'Interrupted · processed next' },
  'input-queued-after-turn': { zh: '已排队 · 回合结束后处理', en: 'Queued · processed after the turn' },
  'input-cannot-retract': { zh: '无法撤回：消息可能已被处理，或当前版本不支持', en: 'Cannot retract: the message may already be processed, or this version doesn\'t support it' },
  'input-retracted': { zh: '已撤回，可编辑后重新发送', en: 'Retracted, editable and resendable' },
  'input-empty': { zh: '输入为空，没有可发送的内容', en: 'Empty input, nothing to send' },
  'input-interrupt-immediate': { zh: '已打断当前回合，正在立即处理', en: 'Interrupted current turn, processing immediately' },
  'input-clipboard-empty': { zh: '剪贴板为空', en: 'Clipboard is empty' },
  'input-editor-unavailable': { zh: '未找到可用编辑器，请设置 $EDITOR（或 $VISUAL）环境变量', en: 'No editor available — set the $EDITOR (or $VISUAL) environment variable' },
  'input-editor-failed': { zh: '外部编辑器失败：{{name}}', en: 'External editor failed: {{name}}' },
  'input-clipboard-read-failed': { zh: '读取剪贴板失败', en: 'Failed to read the clipboard' },
  'input-clipboard-unavailable': { zh: '无法读取剪贴板：没有可用的 wl-paste / xclip / xsel（未安装或会话不可连接）', en: 'Cannot read clipboard: no usable wl-paste / xclip / xsel (not installed or session unreachable)' },
  'input-clipboard-image-saved': { zh: '剪贴板图片已保存为临时文件，已插入路径', en: 'Clipboard image saved to a temp file; path inserted' },
  'input-image-pasted': { zh: '已粘贴图片 {{token}}', en: 'Pasted image {{token}}' },
  'input-image-paste-failed': { zh: '粘贴图片失败：{{err}}', en: 'Could not paste image: {{err}}' },
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

  // ── components/HelpMenu.tsx ─────────────────────────────────────────
  'help-for-commands': { zh: '/ 查看命令', en: '/ for commands' },
  'help-this-help': { zh: '? 查看本帮助', en: '? for this help' },
  'help-verbose-output': { zh: '{{mod}}o 详细输出', en: '{{mod}}o for verbose output' },
  'help-open-trajectory': { zh: '{{mod}}t 打开会话轨迹', en: '{{mod}}t to open trajectory' },
  'help-search-history': { zh: '{{mod}}r 搜索历史', en: '{{mod}}r to search history' },
  'help-interrupt': { zh: 'ctrl+c 打断', en: 'ctrl+c to interrupt' },
  'help-exit': { zh: 'ctrl+d 退出', en: 'ctrl+d to exit' },
  'help-redraw': { zh: '{{mod}}l 重绘', en: '{{mod}}l to redraw' },
  'help-clear-input': { zh: 'esc 清空输入', en: 'esc to clear input' },
  'help-history-nav': { zh: '↑/↓ 历史', en: '↑/↓ for history' },
  'help-move-cursor': { zh: '←/→ 移动光标', en: '←/→ to move cursor' },
  'help-word-jumps': { zh: '{{mod}}←/→ 按词跳转', en: '{{mod}}←/→ for word jumps' },
  'help-complete-command': { zh: 'tab 补全命令', en: 'tab to complete command' },
  'help-cycle-mode': { zh: 'shift+tab 切换模式', en: 'shift+tab to cycle mode' },
  'help-open-editor': { zh: 'ctrl+x 打开编辑器', en: 'ctrl+x to open editor' },
  'help-commands-title': { zh: '命令：', en: 'commands:' },

  // ── components/InterruptedByUser.tsx ────────────────────────────────
  'interrupted-by-user': { zh: '已打断 ', en: 'Interrupted ' },
  'interrupted-ask-next': { zh: '· 接下来想让 DeepSeek 做什么？', en: '· What should DeepSeek do instead?' },

  // ── components/MessageList.tsx ──────────────────────────────────────
  'load-earlier': { zh: ' ↑ 加载更早消息（会话日志完整，/export 导出全文） ', en: ' ↑ load earlier messages (full session log; /export for full text) ' },
  'show-previous-messages': { zh: ' ctrl+e 显示前 {{n}} 条消息 ', en: ' ctrl+e to show {{n}} previous messages ' },
  'resume-none-in-cwd': { zh: '当前目录没有可恢复的历史会话', en: 'No resumable sessions in the current directory' },

  // ── screens/SessionBrowser.tsx + screens/Chat.tsx (/resume) ─────────
  'resume-resumed': { zh: '已恢复会话', en: 'Session resumed' },
  'resume-delete-confirm': { zh: '删除「{{name}}」？会话日志将被永久移除。', en: 'Delete "{{name}}"? The session log is removed permanently.' },
  'resume-deleted': { zh: '已删除会话「{{name}}」', en: 'Deleted session {{name}}' },
  'resume-delete-failed': { zh: '无法删除会话「{{name}}」', en: 'Could not delete session {{name}}' },
  'resume-rename-placeholder': { zh: '新的会话名称…', en: 'New session name…' },
  'resume-rename-failed': { zh: '无法重命名会话「{{name}}」', en: 'Could not rename session {{name}}' },
  'resume-hint-delete': { zh: '**Enter** 删除 · Esc 取消', en: '**Enter** to delete · Esc to cancel' },
  'resume-hint-rename': { zh: '**Enter** 保存 · Esc 取消', en: '**Enter** to save · Esc to cancel' },
  'resume-title': { zh: '恢复会话', en: 'Resume session' },

  // ── screens/Settings.tsx (/settings, issue #165) ───────────────────
  'settings-title': { zh: '插件设置', en: 'Plugin settings' },
  'settings-unavailable': { zh: '设置服务未挂载——只读', en: 'settings service absent — read-only' },
  'settings-empty': { zh: '没有可配置的插件设置（尚无插件注册设置区块）', en: 'No configurable plugin settings (no plugin has registered a section)' },
  'settings-section-unavailable': { zh: '命名空间未注册', en: 'namespace not served' },
  'settings-readonly-heading': { zh: '其他设置命名空间（只读）', en: 'Other settings namespaces (read-only)' },
  'settings-readonly-hint': { zh: '以上命名空间尚无 TUI 设置区块，可手工编辑 {{path}}', en: 'No TUI section for these namespaces yet — edit {{path}} by hand' },
  'settings-badge-override': { zh: '已覆盖', en: 'overridden' },
  'settings-badge-restart': { zh: '重启生效', en: 'applies on restart' },
  'settings-badge-dirty': { zh: '未保存', en: 'unsaved' },
  'settings-badge-saving': { zh: '保存中', en: 'saving' },
  'settings-badge-failed': { zh: '保存失败', en: 'save failed' },
  'settings-field-empty': { zh: '（未设置）', en: '(unset)' },
  'settings-field-invalid': { zh: '无效输入', en: 'invalid' },
  'settings-secret-set': { zh: '●●●●●●（已配置）', en: '●●●●●● (configured)' },
  'settings-secret-unset': { zh: '（未配置）', en: '(not configured)' },
  'settings-secret-staged': { zh: '（待保存）', en: '(pending save)' },
  'settings-saved': { zh: '已保存 {{ns}}', en: 'Saved {{ns}}' },
  'settings-save-failed': { zh: '保存 {{ns}} 失败——请重试', en: 'Saving {{ns}} failed — please retry' },
  'settings-discarded': { zh: '已放弃所有未保存的修改', en: 'Discarded all unsaved edits' },
  'settings-hint-list': { zh: '**Enter** 编辑/切换 · s 保存 · d 放弃 · Esc 放弃/退出', en: '**Enter** edit/toggle · s save · d discard · Esc discard/exit' },
  'settings-hint-edit': { zh: '**Enter** 确认 · Esc 取消', en: '**Enter** to confirm · Esc to cancel' },

  // ── 会话浏览器：行、计数、筛选、预览 ───────────────────────────────
  'session-loading': { zh: '正在读取会话…', en: 'Reading sessions…' },
  'session-list-failed': { zh: '无法读取会话列表 · {{err}}', en: 'Could not read the session list · {{err}}' },
  'session-resume-failed': { zh: '恢复会话失败 · {{err}}', en: 'Resuming the session failed · {{err}}' },
  'session-when-now': { zh: '刚刚', en: 'just now' },
  'session-when-minutes': { zh: '{{n}} 分钟前', en: '{{n}}m ago' },
  'session-when-hours': { zh: '{{n}} 小时前', en: '{{n}}h ago' },
  'session-when-days': { zh: '{{n}} 天前', en: '{{n}}d ago' },
  'session-when-date': { zh: '{{month}} 月 {{day}} 日', en: '{{month}}/{{day}}' },
  'session-children': { zh: '{{n}} 个子运行', en: '{{n}} runs' },
  'session-kind-root': { zh: '对话', en: 'Conversation' },
  'session-kind-fork': { zh: '回溯分支', en: 'Rewound branch' },
  'session-kind-subagent': { zh: '子 agent 运行', en: 'Sub-agent run' },
  'session-project-unknown': { zh: '（未记录目录）', en: '(no directory recorded)' },
  'session-scope-all': { zh: '全部项目', en: 'all projects' },
  'session-search-placeholder': { zh: '输入以搜索 · {{scope}}', en: 'Type to search · {{scope}}' },
  'session-count-shown': { zh: '{{n}} 个会话', en: '{{n}} sessions' },
  'session-count-subagents': { zh: '{{n}} 个子运行已折叠', en: '{{n}} runs folded' },
  'session-count-empty': { zh: '{{n}} 个空会话', en: '{{n}} empty' },
  'session-clean-confirm': { zh: '清理 {{n}} 个没有对话内容的会话？日志将被永久移除。', en: 'Remove {{n}} sessions that hold no conversation? Their logs are deleted permanently.' },
  'session-cleaned': { zh: '已清理 {{n}} 个空会话', en: 'Removed {{n}} empty sessions' },
  'session-preview-times': { zh: '创建于 {{created}} · 最后活动 {{updated}}', en: 'created {{created}} · last active {{updated}}' },
  'session-preview-loading': { zh: '正在读取会话结尾…', en: 'Reading the end of this session…' },
  'session-preview-empty': { zh: '这个会话没有可预览的往来消息', en: 'No exchanges to preview in this session' },
  'session-toggle-on': { zh: '开', en: 'on' },
  'session-toggle-off': { zh: '关', en: 'off' },
  // Three widths of the same hint. The browser picks the widest that fits the
  // terminal, because a hint that wraps costs the rows the list needs and can
  // push its own tail off the bottom of the screen.
  'session-hint-list': { zh: '**Enter** 恢复 · Tab 预览 · {{mod}}a 全部项目（{{projects}}） · {{mod}}s 子运行（{{runs}}） · {{mod}}b 本分支 · {{mod}}r 重命名 · {{mod}}d 删除 · {{mod}}x 清空壳 · Esc 退出', en: '**Enter** resume · Tab preview · {{mod}}a all projects ({{projects}}) · {{mod}}s runs ({{runs}}) · {{mod}}b this branch · {{mod}}r rename · {{mod}}d delete · {{mod}}x clean · Esc exit' },
  'session-hint-list-mid': { zh: '**Enter** 恢复 · Tab 预览 · {{mod}}a 全部项目 · {{mod}}s 子运行 · {{mod}}r 重命名 · {{mod}}d 删除 · Esc 退出', en: '**Enter** resume · Tab preview · {{mod}}a projects · {{mod}}s runs · {{mod}}r rename · {{mod}}d delete · Esc exit' },
  'session-hint-list-short': { zh: '**Enter** 恢复 · Tab 预览 · Esc 退出', en: '**Enter** resume · Tab preview · Esc exit' },

  // ── picker 通用快捷键提示（整句本地化，zh 不用 "to" 结构；**段** 渲染为粗体主快捷键）─
  'hint-confirm-exit': { zh: '**Enter** 确认 · Esc 退出', en: '**Enter** to confirm · Esc to exit' },
  'hint-confirm-cancel': { zh: '**Enter** 确认 · Esc 取消', en: '**Enter** to confirm · Esc to cancel' },
  'hint-select-exit': { zh: '**Enter** 选择 · Esc 退出', en: '**Enter** to select · Esc to exit' },
  'hint-fill-exit': { zh: '**Enter** 填入命令 · Esc 退出', en: '**Enter** to insert · Esc to exit' },
  'hint-rewind-back': { zh: '**Enter** 回退 · Esc 返回', en: '**Enter** to rewind · Esc to back' },
  'hint-ext-dialog-input': { zh: '**Enter** 确认 · Esc 取消', en: '**Enter** to confirm · Esc to cancel' },
  'hint-adjust-done': { zh: '**←/→** 调整 · Enter/Esc 完成', en: '**←/→** to adjust · Enter/Esc to done' },
  'hint-history-search': { zh: '↑/↓ 选择 · **Enter** 确认 · Esc 取消', en: '↑/↓ to navigate · **Enter** to select · Esc to cancel' },
  'hint-expand-ctrl-o': { zh: '（ctrl+o 展开）', en: '(ctrl+o to expand)' },

  // ── components/ModelPicker.tsx / ThemePicker.tsx / ActivityPicker.tsx / EffortSlider.tsx ──
  'picker-title-model': { zh: '模型', en: 'Model' },
  'picker-title-skills': { zh: '技能', en: 'Skills' },
  'skills-loading': { zh: '正在加载技能', en: 'Loading skills' },
  'skills-loading-subtitle': { zh: '正在查询技能注册表…', en: 'Querying the skill registry…' },
  'skills-empty': { zh: '当前会话没有可用技能', en: 'No skills available in this session' },
  'skills-load-failed': { zh: '技能列表加载失败', en: 'Failed to load the skill list' },
  'plugin-scene-crashed': { zh: '插件场景「{{id}}」渲染崩溃：{{err}}（已自动关闭）', en: 'Plugin scene "{{id}}" crashed while rendering: {{err}} (closed)' },
  'skills-source-bundled': { zh: '内置', en: 'built-in' },
  'skills-source-user': { zh: '用户', en: 'user' },
  'skills-source-project': { zh: '项目', en: 'project' },
  'skills-source-runtime': { zh: '运行时', en: 'runtime' },
  'skills-source-custom': { zh: '自定义', en: 'custom' },
  'picker-title-theme': { zh: '颜色主题', en: 'Color theme' },
  'picker-title-activity': { zh: '指示器预设', en: 'Indicator preset' },
  'picker-title-effort': { zh: '推理强度', en: 'Reasoning effort' },
  'model-loading': { zh: '正在加载模型', en: 'Loading models' },
  'model-loading-subtitle': { zh: '正在查询 provider…', en: 'Querying the provider…' },
  'model-switching': { zh: '正在切换模型到 {{name}}…', en: 'Switching model to {{name}}…' },
  'model-switched': { zh: '模型已切换为 {{name}}', en: 'Model switched to {{name}}' },

  // ── components/RewindPicker.tsx ─────────────────────────────────────
  'rewind-title': { zh: '回退', en: 'Rewind' },
  'rewind-subtitle': { zh: '选择一条消息，将对话回退到该处', en: 'Pick a message to rewind the conversation to' },
  'rewind-confirm-title': { zh: '将对话回退到这条消息？', en: 'Rewind conversation to this message?' },
  'rewind-confirm-desc': { zh: '对话从此处重新开始', en: 'conversation restarts here' },
  'rewind-empty': { zh: '没有可回退的消息', en: 'No messages to rewind to' },
  'rewind-last-message': { zh: '最近一条消息', en: 'last message' },
  'rewind-none': { zh: '还没有可回退的消息', en: 'Nothing to rewind yet' },
  'rewind-done': { zh: '已回退——编辑后按 Enter 重新发送', en: 'Rewound — edit and press Enter to resend' },
  'rewind-mode-default': { zh: '仅回退会话', en: 'Conversation only' },
  'rewind-waiting-plugins': { zh: '正在等待插件决定…（Esc 放弃等待）', en: 'Waiting for plugins… (Esc to stop waiting)' },

  // ── 插件扩展缝（dsh-tui-extensions：决策事件 + 托管对话框 + 快捷键）──
  'ext-action-cancelled': { zh: '操作已被插件取消', en: 'Action cancelled by a plugin' },
  'ext-action-handled': { zh: '输入已由插件处理', en: 'Input handled by a plugin' },
  'ext-decision-pending': { zh: '正在等待插件决定（{{event}}）…', en: 'Waiting for a plugin decision ({{event}})…' },
  'ext-stale-dropped': { zh: '等待插件期间会话已切换，该条输入已丢弃', en: 'Session switched while a plugin decided — the input was dropped' },
  'ext-compact-stale': { zh: '等待插件期间会话已切换，压缩已取消', en: 'Session switched while a plugin decided — compaction abandoned' },
  'ext-shortcut-failed': { zh: '插件快捷键 {{combo}} 执行失败', en: 'Plugin shortcut {{combo}} failed' },
  'command-invoke-denied': { zh: '命令调用已被授权文件拒绝（commands.invoke 已撤销）', en: 'Command invocation denied by the grants file (commands.invoke revoked)' },
  'command-invoke-denied-owner': {
    zh: '命令 "/{{name}}" 的调用已被拒绝——注册它的插件 "{{owner}}" 已被撤销 commands.invoke',
    en: 'Command "/{{name}}" invocation denied — its owner plugin "{{owner}}" lost commands.invoke',
  },
  'plugins-check-tui-extension': {
    zh: '注：该 manifest 依赖 TUI 宿主扩展面（tui.dsh/v1alpha1 DecisionEvents / session.*.intercept 权限），判定基于宿主扩展覆盖层而非 vendored 社区注册表。',
    en: 'Note: this manifest relies on the TUI host-extension surface (tui.dsh/v1alpha1 DecisionEvents / session.*.intercept permissions); the verdict used the host extension overlay, not the vendored community registry.',
  },
  // /plugins 诊断面（C-070 信任披露 + 协商诊断）
  'plugins-trust-banner': {
    zh: '插件与宿主同进程运行：授权是行为约束而非安全隔离；通过校验 ≠ 插件安全（C-070）。',
    en: 'Plugins run in-process with the host: grants are behavioral constraints, not a security boundary; passing validation ≠ a safe plugin (C-070).',
  },
  'plugins-host-unavailable': { zh: 'plugin-host 行未挂载：Host Descriptor 与授权矩阵按无信息降级。', en: 'plugin-host row not mounted: Host Descriptor and grant matrix degraded to no-data.' },
  'plugins-contract-dropped': { zh: '已剔除（vendored 哈希漂移）', en: 'dropped (vendored hash drift)' },
  'plugins-matrix-note': { zh: '授权矩阵（✓ 允许 / · 拒绝；仅显示有足迹的插件——授权文件、效果台账与存储目录的并集）：', en: 'Grant matrix (✓ allowed / · denied; plugins with footprints only — union of the grants file, effect ledger, and storage directory):' },
  'plugins-matrix-no-registry': { zh: '（权限注册表不可用）', en: '(permission registry unavailable)' },
  'plugins-matrix-empty': { zh: '（暂无插件足迹）', en: '(no plugin footprints yet)' },
  'plugins-footprint-overflow': { zh: '…另有 {{count}} 个插件未显示', en: '…{{count}} more plugin(s) not shown' },
  'plugins-ledger-empty': { zh: '效果台账为空。', en: 'The effect ledger is empty.' },
  'plugins-ledger-header': { zh: '效果台账（{{file}}）尾 5 条：', en: 'Effect ledger ({{file}}), last 5 records:' },
  'plugins-unknown-subcommand': { zh: '未知子命令：{{sub}}（支持：check <路径>）', en: 'Unknown subcommand: {{sub}} (supported: check <path>)' },
  'plugins-check-usage': { zh: '用法：/plugins check <dsh-plugin.json 路径>', en: 'Usage: /plugins check <path-to-dsh-plugin.json>' },
  'plugins-check-not-found': { zh: '文件不存在：{{path}}', en: 'File not found: {{path}}' },
  'plugins-check-invalid-json': { zh: '不是可解析的 JSON：{{err}}', en: 'Not parseable JSON: {{err}}' },
  'plugins-check-spec-unavailable': { zh: 'vendored 规范数据不可用（dsh-ecosystem-spec/），无法校验。', en: 'Vendored spec data unavailable (dsh-ecosystem-spec/); cannot validate.' },
  'plugins-check-schema-failed': { zh: 'schema 校验失败：{{err}}', en: 'Schema validation failed: {{err}}' },
  'plugins-check-invalid': { zh: '语义校验失败：{{err}}', en: 'Semantic validation failed: {{err}}' },
  'plugins-check-state': { zh: '协商结果：{{state}}', en: 'Negotiation decision: {{state}}' },
  'plugins-check-dropped': { zh: '（宿主描述符已剔除漂移契约：{{dropped}}）', en: '(host descriptor dropped drifted contracts: {{dropped}})' },
  'doctor-plugin-generation': { zh: '插件运行时 generation：{{id}}', en: 'Plugin runtime generation: {{id}}' },
  'doctor-plugin-registry': { zh: '插件规范注册表自检：{{state}}', en: 'Plugin-spec registry self-check: {{state}}' },
  'doctor-plugin-host-missing': { zh: 'plugin-host 行未挂载', en: 'plugin-host row not mounted' },
  'ext-dialog-yes': { zh: '是', en: 'Yes' },
  'ext-dialog-no': { zh: '否', en: 'No' },

  // ── components/ThinkingToggle.tsx + messages/AssistantThinkingMessage.tsx ──
  'thinking-title': { zh: '切换思考模式', en: 'Toggle thinking mode' },
  'thinking-subtitle': { zh: '为本会话启用或关闭思考。', en: 'Enable or disable thinking for this session.' },
  'thinking-enabled': { zh: '启用', en: 'Enabled' },
  'thinking-enabled-desc': { zh: 'DeepSeek 会在回复前先思考', en: 'DeepSeek will think before responding' },
  'thinking-disabled': { zh: '关闭', en: 'Disabled' },
  'thinking-disabled-desc': { zh: 'DeepSeek 不做扩展思考，直接回复', en: 'DeepSeek will respond without extended thinking' },
  'thinking-mid-warning': { zh: '在对话中途切换思考模式会增加延迟，并可能降低质量。建议在会话开始时设置。', en: 'Changing thinking mode mid-conversation will increase latency and may reduce quality. For best results, set this at the start of a session.' },
  'thinking-proceed': { zh: '要继续吗？', en: 'Do you want to proceed?' },
  'thinking-label': { zh: '思考', en: 'Thinking' },

  // ── components/HistorySearchDialog.tsx ──────────────────────────────
  'history-search-title': { zh: '搜索历史', en: 'Search history' },
  'history-search-placeholder': { zh: '输入以搜索…', en: 'Type to search…' },
  'history-search-empty': { zh: '没有匹配的命令', en: 'No matching commands' },
  'time-now': { zh: '刚刚', en: 'now' },
  'time-minutes-ago': { zh: '{{n}} 分钟前', en: '{{n}}m ago' },
  'time-hours-ago': { zh: '{{n}} 小时前', en: '{{n}}h ago' },
  'time-days-ago': { zh: '{{n}} 天前', en: '{{n}}d ago' },

  // ── screens/Chat.tsx（/ 转录搜索条）─────────────────────────────────
  'search-no-matches': { zh: '无匹配', en: 'no matches' },

  'rename-usage': { zh: '用法  /rename <新名称>', en: 'Usage  /rename <new title>' },
  'rename-current': { zh: '当前名称  {{title}}', en: 'Current title  {{title}}' },
  'rename-done': { zh: '已重命名为「{{title}}」', en: 'Renamed to "{{title}}"' },
  'compact-summary-folded': { zh: '摘要已折叠', en: 'Summary folded' },
  'new-message': { zh: '{{n}} 条新消息', en: '1 new message' },
  'new-messages': { zh: '{{n}} 条新消息', en: '{{n}} new messages' },

  // ── components/ThemePicker.tsx ──────────────────────────────────────
  'theme-builtin-base': { zh: '内置 · {{name}} 基底', en: 'Built-in · {{name}} base' },
  'theme-auto-base': { zh: '内置 · 跟随系统/终端背景自动选择 light/dark', en: 'Built-in · follows the system/terminal background (light/dark)' },
  'theme-user-base': { zh: '{{base}} 基底 · ~/.dsh-tui/themes/{{name}}.json', en: '{{base}} base · ~/.dsh-tui/themes/{{name}}.json' },

  // ── components/LoadedContextPanel.tsx ───────────────────────────────
  'context-unavailable': { zh: '当前会话没有已加载的上下文', en: 'No loaded context is available for this session' },
  'context-panel-sections': { zh: '系统提示词 · {{n}} 段', en: 'System prompt · {{n}} sections' },
  'context-panel-files': { zh: '工作区指令 · {{n}} 个文件', en: 'Workspace instructions · {{n}} files' },
  'context-panel-runtime': { zh: '运行时上下文 · {{n}} 项', en: 'Runtime context · {{n}} items' },
  'context-panel-skills': { zh: '技能 · {{n}}', en: 'Skills · {{n}}' },
  'context-panel-tools': { zh: '工具 · {{n}}', en: 'Tools · {{n}}' },

  // ── components/questions/AskUserQuestionPanel.tsx ───────────────────
  'question-select-or-answer': { zh: '至少选择一个选项，或在最后一行输入回答', en: 'Select at least one option, or type an answer on the last line' },
  'question-answer-or-check': { zh: '输入回答或勾选选项后再提交', en: 'Type an answer or check options before submitting' },
  'question-type-answer-first': { zh: '先输入回答内容再提交', en: 'Type your answer before submitting' },
  'question-header-progress': { zh: ' 📋 提问 · 第 {{position}}/{{total}} 题{{remaining}} ', en: ' 📋 Question {{position}}/{{total}} {{remaining}} ' },
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

  // ── components/approvals/ApprovalPanel.tsx ──────────────────────────
  'approval-waiting': { zh: ' ⏳ 等待审批 · {{tool}} ', en: ' Awaiting approval · {{tool}} ' },
  'approval-proceed': { zh: '要允许这次操作吗？', en: 'Do you want to proceed?' },
  'approval-yes': { zh: '允许（仅本次）', en: 'Yes, allow once' },
  'approval-no': { zh: '拒绝', en: 'No' },
  'approval-hint': { zh: '↑/↓ 选择 · Enter 确认 · Esc 拒绝', en: '↑/↓ select · Enter confirm · Esc reject' },

  // ── components/questions/PlanReviewPanel.tsx ────────────────────────
  'plan-review-fallback-header': { zh: '计划评审', en: 'Plan review' },
  'plan-review-feedback-placeholder': { zh: '输入反馈，告诉模型要改什么…', en: 'Tell the model what to change…' },
  'plan-review-approve-needs-empty': { zh: '请先清空反馈再批准（或在输入行回车提交反馈）', en: 'Clear the feedback to approve (or press Enter on the input row to send it)' },
  'plan-review-hint': { zh: '↑/↓ 选择 · 1/2 快选 · 打字输入反馈 · Enter 提交 · Esc 打断评审', en: '↑/↓ select · 1/2 quick-pick · type feedback · Enter submit · Esc dismiss' },

  // ── providerWizard.ts ────────────────────────────────────────────────
  'provider-unavailable': { zh: '/provider 需要经 dsh profile 启动（settings / credentials / llm-pi-ai 服务未挂载）', en: '/provider requires starting through a dsh profile (settings / credentials / llm-pi-ai services not mounted)' },
  'provider-q-mode': { zh: '要添加哪种模型提供方？', en: 'Which kind of model provider do you want to add?' },
  'provider-opt-catalog': { zh: '内置 provider', en: 'Built-in provider' },
  'provider-opt-catalog-desc': { zh: 'openai、anthropic、deepseek 等内置目录，自动继承端点与协议', en: 'Built-in catalog such as openai, anthropic, deepseek — endpoint and protocol inherited' },
  'provider-opt-custom': { zh: '自定义 API 端点', en: 'Custom API endpoint' },
  'provider-opt-custom-desc': { zh: 'OpenAI / Anthropic 兼容的网关或自建服务', en: 'An OpenAI/Anthropic-compatible gateway or self-hosted server' },
  'provider-q-catalog': { zh: '选择 provider', en: 'Choose a provider' },
  'provider-opt-other-route': { zh: '其他（手动输入路由名）', en: 'Other (enter a route name)' },
  'provider-opt-other-route-desc': { zh: '目录里没列出的 catalog 路由', en: 'A catalog route not listed above' },
  'provider-q-route-id': { zh: '输入路由名', en: 'Enter a route name' },
  'provider-q-route-id-detail': { zh: '小写字母开头，可含数字与连字符，如 my-gateway', en: 'Lowercase letter first, digits and dashes allowed, e.g. my-gateway' },
  'provider-route-id-invalid': { zh: '路由名不合法：须以小写字母开头，仅含小写字母 / 数字 / 连字符', en: 'Invalid route name: must start with a lowercase letter, only lowercase letters / digits / dashes' },
  'provider-q-apikey': { zh: '输入 API key', en: 'Enter the API key' },
  'provider-q-apikey-detail': { zh: '密钥将写入 ~/.dsh/.credentials.yaml（权限 0600），不会出现在会话记录中', en: 'The key is stored in ~/.dsh/.credentials.yaml (mode 0600) and never shown in the transcript' },
  'provider-q-baseurl-choice': { zh: '是否覆盖默认 API 端点（baseURL）？', en: 'Override the default API endpoint (baseURL)?' },
  'provider-opt-baseurl-skip': { zh: '跳过，使用默认端点', en: 'Skip — use the default endpoint' },
  'provider-opt-baseurl-input': { zh: '现在输入 baseURL', en: 'Enter a baseURL now' },
  'provider-q-baseurl': { zh: '输入 baseURL', en: 'Enter the baseURL' },
  'provider-q-protocol': { zh: '选择 API 协议', en: 'Choose the wire protocol' },
  'provider-protocol-completions-desc': { zh: 'OpenAI Chat Completions 兼容（大多数网关）', en: 'OpenAI Chat Completions compatible (most gateways)' },
  'provider-protocol-responses-desc': { zh: 'OpenAI Responses API', en: 'OpenAI Responses API' },
  'provider-protocol-anthropic-desc': { zh: 'Anthropic Messages API', en: 'Anthropic Messages API' },
  'provider-discovery-running': { zh: '正在探测该端点公布的模型…', en: 'Discovering the models this endpoint advertises…' },
  'provider-discovery-failed': { zh: '模型探测失败，改为手动输入模型 id', en: 'Model discovery failed — enter model ids manually instead' },
  'provider-q-models': { zh: '选择要启用的模型（可在输入行逗号分隔补充）', en: 'Select the models to enable (add more comma-separated on the input row)' },
  'provider-q-models-fallback': { zh: '输入模型 id（逗号分隔）', en: 'Enter model ids (comma-separated)' },
  'provider-models-required': { zh: '自定义端点至少需要一个模型 id', en: 'A custom endpoint needs at least one model id' },
  'provider-q-confirm': { zh: '确认写入该 provider 配置？', en: 'Write this provider configuration?' },
  'provider-route-exists-warning': { zh: '⚠ 该路由已有配置，写入将覆盖现有设置', en: '⚠ This route is already configured — writing overwrites it' },
  'provider-opt-confirm-write': { zh: '写入并启用', en: 'Write and enable' },
  'provider-opt-confirm-cancel': { zh: '取消', en: 'Cancel' },
  'provider-line-route': { zh: '路由：{{route}}', en: 'Route: {{route}}' },
  'provider-line-keyref': { zh: '密钥引用：{{ref}}（已写入 ~/.dsh/.credentials.yaml）', en: 'Key ref: {{ref}} (stored in ~/.dsh/.credentials.yaml)' },
  'provider-line-keyref-env': { zh: '密钥引用：{{ref}}（进程环境已提供同名变量，跳过写入）', en: 'Key ref: {{ref}} (already in the process environment, write skipped)' },
  'provider-line-baseurl': { zh: 'baseURL：{{url}}', en: 'baseURL: {{url}}' },
  'provider-line-protocol': { zh: '协议：{{api}}', en: 'Protocol: {{api}}' },
  'provider-line-models': { zh: '模型：{{models}}', en: 'Models: {{models}}' },
  'provider-line-models-catalog': { zh: '模型：整个 catalog（未收窄）', en: 'Models: the whole catalog (not narrowed)' },
  'provider-rollback-ok': { zh: '已回滚刚写入的密钥', en: 'Rolled back the just-written key' },
  'provider-rollback-failed': { zh: '密钥回滚失败，请手动检查 ~/.dsh/.credentials.yaml', en: 'Key rollback failed — check ~/.dsh/.credentials.yaml manually' },
  'provider-write-failed': { zh: 'provider 配置写入失败 · {{{err}}}', en: 'Failed to write the provider configuration · {{{err}}}' },
  'provider-cancelled': { zh: '已取消添加 provider', en: 'Provider setup cancelled' },
  'provider-success': { zh: 'provider {{route}} 已添加', en: 'Provider {{route}} added' },
  'provider-switch-hint': { zh: '运行 /model 可切换到新 provider 的模型', en: 'Run /model to switch to the new provider’s models' },
  'provider-q-switch': { zh: '立即切换到新 provider？', en: 'Switch to the new provider now?' },
  'provider-opt-switch-now': { zh: '切换到 {{model}}', en: 'Switch to {{model}}' },
  'provider-opt-switch-keep': { zh: '保持当前模型', en: 'Keep the current model' },

  // ── commands.ts — slash-command descriptions ─────────────────────────
  // zh-only on purpose: the English text stays in `LOCAL_COMMANDS` (and in
  // the DSH registry for external commands) as the single source of truth,
  // so `localizedDescription` falls back to it whenever the active language
  // has no entry here. `cmd-desc-<name>` keys are resolved at render time,
  // so `/lang` switches apply on the next repaint.
  // Conversation
  'cmd-desc-new': { zh: '新开会话' },
  'cmd-desc-clear': { zh: '清空当前会话' },
  'cmd-desc-compact': { zh: '压缩会话历史' },
  'cmd-desc-resume': { zh: '恢复历史会话' },
  'cmd-desc-rename': { zh: '重命名当前会话' },
  'cmd-desc-quit': { zh: '退出 dsh-tui' },
  'cmd-desc-q': { zh: '退出 dsh-tui' },
  'cmd-desc-rewind': { zh: '回退会话到历史消息' },
  'cmd-desc-export': { zh: '导出会话为 Markdown 文件' },
  // Session / environment
  'cmd-desc-context': { zh: '查看已加载的上下文明细' },
  'cmd-desc-status': { zh: '查看会话状态' },
  'cmd-desc-cost': { zh: '查看会话 token 用量' },
  'cmd-desc-config': { zh: '查看 dsh-tui 配置来源' },
  'cmd-desc-settings': { zh: '查看和编辑插件设置' },
  'cmd-desc-doctor': { zh: '运行环境检查' },
  'cmd-desc-init': { zh: '在工作目录创建 AGENTS.md' },
  'cmd-desc-agents': { zh: '查看本会话的子代理' },
  // Model / display
  'cmd-desc-activity': { zh: '切换工作状态指示器预设' },
  'cmd-desc-preset': { zh: '切换 Agent 预设（含梁神模式）' },
  'cmd-desc-theme': { zh: '切换配色主题（auto 跟随系统，或内置/自定义）' },
  'cmd-desc-lang': { zh: '切换界面语言（en / zh）' },
  'cmd-desc-model': { zh: '查看当前模型' },
  'cmd-desc-thinking': { zh: '切换扩展思考显示' },
  'cmd-desc-tokens': { zh: '查看会话 token 用量' },
  // Account / policy
  'cmd-desc-provider': { zh: '添加模型提供方（内置目录或自定义 API 端点）' },
  'cmd-desc-login': { zh: '查看 API 凭证状态' },
  'cmd-desc-logout': { zh: '清除 API 凭证' },
  'cmd-desc-permissions': { zh: '查看权限策略状态' },
  'cmd-desc-add-dir': { zh: '查看文件系统策略范围' },
  'cmd-desc-hooks': { zh: '查看 hooks 状态' },
  'cmd-desc-mcp': { zh: '查看 MCP 状态' },
  'cmd-desc-skills': { zh: '列出所有可用技能' },
  'cmd-desc-plugins': { zh: '显示插件契约、授权与台账诊断' },
  'cmd-desc-update': { zh: '更新 dsh-tui 并重启' },
  // Built-in skills
  'cmd-desc-audit': { zh: '对当前项目做全面代码审计' },
  'cmd-desc-bug': { zh: '记录一份 bug 报告' },
  'cmd-desc-practice': { zh: '与 dsh-tui 进行编程练习' },
  'cmd-desc-review': { zh: '对当前项目做全面代码评审' },
  'cmd-desc-pr_comments': { zh: '审查拉取请求评论' },
  'cmd-desc-release-notes': { zh: '生成发布说明' },
  'cmd-desc-vuln-check': { zh: '运行安全漏洞检查' },
  // Misc
  'cmd-desc-vim': { zh: '切换 vim 模式' },
  'cmd-desc-terminal-setup': { zh: '查看终端配置建议' },
  'cmd-desc-connect': { zh: '连接远程机器' },
  'cmd-desc-workspace': { zh: '切换、重命名或打开工作区' },
  'cmd-desc-workspace-resume': { zh: '切换到另一个工作区', en: 'Switch to another workspace' },
  'cmd-desc-workspace-rename': { zh: '重命名当前工作区', en: 'Rename the current workspace' },
  'cmd-desc-workspace-open': { zh: '打开路径或工作区 URI', en: 'Open a path or workspace URI' },
  // Help / exit
  'cmd-desc-help': { zh: '查看快捷键与命令' },
  'cmd-desc-exit': { zh: '退出 dsh-tui' },
  // Registry-injected (external) commands — zh only; en falls back to the
  // registry's own description, and unlisted externals always fall back.
  'cmd-desc-plan': { zh: '切换计划模式（/plan off 退出）' },
  'cmd-desc-goal': { zh: '设置或查看会话目标' },
  'cmd-desc-feedback': { zh: '提交使用反馈' },

  // ── /lang command ───────────────────────────────────────────────────
  'lang-current': { zh: '当前语言  {{lang}}', en: 'Current language  {{lang}}' },
  'lang-switch-hint': { zh: '切换      /lang en | /lang zh', en: 'Switch      /lang en | /lang zh' },
  'lang-persist-hint': { zh: '持久化    ~/.dsh-tui/lang.json（重启后仍生效；DSH_TUI_LANG 优先）', en: 'Persisted    ~/.dsh-tui/lang.json (survives restart; DSH_TUI_LANG wins)' },
  'lang-switched': { zh: '语言已切换：{{lang}}（已保存）', en: 'Language switched: {{lang}} (saved)' },
  'lang-unknown': { zh: '未知语言「{{lang}}」· /lang 查看全部（en / zh）', en: 'Unknown language "{{lang}}" · /lang to view all (en / zh)' },
  'lang-switch-failed': { zh: '语言「{{lang}}」切换失败（无法写入 ~/.dsh-tui/lang.json）', en: 'Language "{{lang}}" switch failed (cannot write ~/.dsh-tui/lang.json)' },

  // ── screens/StatusLine.tsx ───────────────────────────────────────────
  'status-cache-label': { zh: '缓存 ', en: 'cache ' },

  // ── screens/TrajectoryScene.tsx（issue #80 演进：全屏轨迹场景）──────────
  'traj-title': { zh: '轨迹', en: 'Trajectory' },
  'traj-totals': { zh: '{{turns}} 轮 · {{steps}} 步', en: '{{turns}} turns · {{steps}} rows' },
  'traj-errors': { zh: '{{n}} 错', en: '{{n}} failed' },
  'traj-retries': { zh: '{{n}} 重试', en: '{{n}} retries' },
  'traj-matches': { zh: '{{n}}/{{total}} 匹配', en: '{{n}}/{{total}} matched' },
  'traj-tab-timeline': { zh: '时序', en: 'Timeline' },
  'traj-tab-hotspot': { zh: '热点', en: 'Hotspot' },
  'traj-hot-tools': { zh: '工具', en: 'Tools' },
  'traj-hot-model': { zh: '模型', en: 'Model' },
  'traj-hot-turns': { zh: '轮次', en: 'Turns' },
  'traj-sort-duration': { zh: '按耗时', en: 'by duration' },
  'traj-sort-count': { zh: '按次数', en: 'by count' },
  'traj-sort-tokens': { zh: '按 token', en: 'by tokens' },
  'traj-proj-sequence': { zh: '序号等宽', en: 'even' },
  'traj-proj-time': { zh: '真实墙钟', en: 'wall-clock' },
  'traj-proj-compressed': { zh: '压缩空闲', en: 'compressed' },
  'traj-hint-timeline': {
    zh: '**↑/↓** 移动 · **←/→** 视图 · **[ ]** 跳错 · **{ }** 跳轮 · **/** 查询 · **m** 投影 · **enter** 详情 · **q** 退出',
    en: '**↑/↓** move · **←/→** view · **[ ]** failures · **{ }** turns · **/** query · **m** projection · **enter** detail · **q** exit',
  },
  'traj-hint-hotspot': {
    zh: '**↑/↓** 移动 · **←/→** 视图 · **t** 排序 · **enter** 回时序定位 · **q** 退出',
    en: '**↑/↓** move · **←/→** view · **t** sort · **enter** locate in timeline · **q** exit',
  },
  'traj-hint-query': {
    zh: '**tool:** **kind:** **turn:** **err:** **run:** **>10s** **tok>1k** · 裸词全文 · **enter** 确认 · **esc** 清除',
    en: '**tool:** **kind:** **turn:** **err:** **run:** **>10s** **tok>1k** · bare word = full text · **enter** apply · **esc** clear',
  },
  'traj-hint-expanded': {
    zh: '**j/k** 翻页 · **enter/esc** 收起 · **q** 退出',
    en: '**j/k** page · **enter/esc** collapse · **q** exit',
  },
  'traj-empty': { zh: '暂无轨迹事件', en: 'No trajectory events yet' },
  'traj-hint-failure': { zh: '{{key}} 看完整轨迹', en: '{{key}} for the full trajectory' },
} as const

export type I18nKey = keyof typeof dict
export type I18nParams = Record<string, string | number>

/** The active language, module-level so non-React modules (channel.ts,
 *  loaded-context.ts) resolve strings without a context. Defaults to `zh`
 *  (the original hard-coded language). */
// Resolved at import time (env var → persisted /lang → OS locale → zh) so
// direct consumers of t() — repro/verify scripts that never reach
// plugin.apply — still get the pinned language instead of a hardcoded zh.
let activeLang: Lang = resolveStartupLang()

/** Emitted on every language switch so React screens can re-render. */
type Listener = () => void
const listeners = new Set<Listener>()

/** Subscribe to language switches (mirrors themePrefs subscription style). */
export function subscribeLang(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The currently active language. */
export function getLang(): Lang {
  return activeLang
}

/** Switch the active language and notify subscribers. */
export function setLang(lang: Lang): void {
  activeLang = lang
  for (const listener of listeners) listener()
}

/** Is a string a valid shipped language code? */
export function isLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en'
}

/**
 * Translate a dictionary key into the active language, substituting
 * `{{name}}` placeholders with params. Missing keys render the key itself
 * so a typo is visible instead of silently blank.
 * @param key - Dictionary key (see dict).
 * @param params - Placeholder values.
 */
export function t(key: I18nKey, params: I18nParams = {}): string {
  const entry = dict[key] as { zh: string; en: string } | undefined
  const template = entry?.[activeLang] ?? key
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/**
 * Translate a runtime-computed key (e.g. `cmd-desc-${name}`), falling back
 * to the given text when the key is missing or has no entry in the active
 * language — unlike {@link t}, which renders the key itself. Used where the
 * fallback holds the authoritative text (command descriptions: the en copy
 * lives in `LOCAL_COMMANDS` / the DSH registry, the dict carries zh only).
 * @param key - Dictionary key, computed at runtime so it is not type-checked.
 * @param fallback - Text used when no translation exists.
 */
export function tOr(key: string, fallback: string): string {
  const entry = (dict as Record<string, { zh?: string; en?: string }>)[key]
  return entry?.[activeLang] ?? fallback
}

// ── persistence (~/.dsh-tui/lang.json) ─────────────────────────────────

/**
 * Parse a persisted `{ lang }` value; anything else yields undefined.
 * @param text - Raw file contents.
 */
export function parseLangPref(text: string): Lang | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const lang = (parsed as Record<string, unknown>).lang
    return isLang(lang) ? lang : undefined
  } catch {
    return undefined
  }
}

/** The persisted `/lang` choice, or undefined when unset or invalid. */
export function readLangPref(dir: string = PREFS_DIR): Lang | undefined {
  try {
    return parseLangPref(readFileSync(join(dir, 'lang.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Persist the chosen language (best effort). */
export function writeLangPref(lang: Lang, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'lang.json'), JSON.stringify({ lang }, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * Guess the user's language from the OS locale (`LC_ALL`, `LC_MESSAGES`,
 * `LANG`), defaulting to `zh`. Only consulted when nothing else (env var,
 * cordis.yml `lang`, persisted `/lang` choice) pinned a language.
 * The POSIX/C locale means "no locale selected" and conventionally maps to
 * English — importantly it is what CI runners (LANG=C.UTF-8) report, so
 * tests asserting English UI copy stay deterministic. An absent locale
 * variable (typical on Windows) still defaults to `zh`.
 */
export function detectLocaleLang(): Lang {
  // `||` (not `??`): an EMPTY locale variable means "unset" and must fall
  // through to the next one — runners and shells sometimes export LC_ALL=''.
  const raw =
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    ''
  const locale = raw.split('.')[0]?.toLowerCase() ?? ''
  if (locale.startsWith('zh')) return 'zh'
  if (locale.startsWith('en')) return 'en'
  if (locale === 'c' || locale === 'posix') return 'en'
  return 'zh'
}

/**
 * Resolve the startup language: `DSH_TUI_LANG` when it holds a valid value
 * (pinned at process start — the repro/verify scripts rely on this for
 * deterministic UI copy), else the persisted `/lang` choice, else the OS
 * locale guess, else `zh` (the original hard-coded language). The
 * cordis.yml `lang` precedence lives in plugin.apply.
 */
export function resolveStartupLang(): Lang {
  const envLang = process.env.DSH_TUI_LANG
  if (isLang(envLang)) return envLang
  return readLangPref() ?? detectLocaleLang()
}
