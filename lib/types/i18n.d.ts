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
export type Lang = 'zh' | 'en';
/** The languages shipped with the plugin, in display order. */
export declare const LANGS: readonly ["zh", "en"];
declare const dict: {
    readonly 'activity-indicator-already': {
        readonly zh: "指示器已是：{{name}}";
        readonly en: "Indicator already set: {{name}}";
    };
    readonly 'activity-indicator-switched': {
        readonly zh: "指示器已切换：{{name}}（已保存）";
        readonly en: "Indicator switched: {{name}} (saved)";
    };
    readonly 'activity-pref-write-failed': {
        readonly zh: "无法写入 ~/.dsh-cc/working-activity.json，切换未保存";
        readonly en: "Cannot write ~/.dsh-cc/working-activity.json, switch not saved";
    };
    readonly 'model-pref-write-failed': {
        readonly zh: "无法写入 ~/.dsh-cc/model.json，模型选择不会保存到重启后";
        readonly en: "Cannot write ~/.dsh-cc/model.json, the model choice will not survive a restart";
    };
    readonly 'model-route-invalid': {
        readonly zh: "持久化的模型路由 {{provider}}/{{model}} 不在该 provider 的模型列表中，已整体回退到 {{fallback}}";
        readonly en: "Persisted model route {{provider}}/{{model}} is not advertised by that provider; fell back to {{fallback}}";
    };
    readonly 'unknown-activity-preset': {
        readonly zh: "未知预设「{{name}}」· /activity frames 查看全部";
        readonly en: "Unknown preset \"{{name}}\" · /activity frames to view all";
    };
    readonly 'preset-unavailable': {
        readonly zh: "Preset 不可用——当前组合未挂载 agent-presets 名册";
        readonly en: "Preset unavailable — the agent-presets roster is not mounted";
    };
    readonly 'preset-agent-running': {
        readonly zh: "Agent 运行中，无法切换 preset";
        readonly en: "Agent is running, cannot switch preset";
    };
    readonly 'preset-not-found': {
        readonly zh: "Preset「{{id}}」不存在 · {{err}}";
        readonly en: "Preset \"{{id}}\" not found · {{err}}";
    };
    readonly 'preset-load-failed': {
        readonly zh: "Preset「{{id}}」无法加载 · {{broken}}";
        readonly en: "Preset \"{{id}}\" failed to load · {{broken}}";
    };
    readonly 'preset-already-current': {
        readonly zh: "当前 preset 已是：{{id}}";
        readonly en: "Current preset already: {{id}}";
    };
    readonly 'preset-pref-write-failed': {
        readonly zh: "无法写入 ~/.dsh-cc/agent-preset.json，选择未保存";
        readonly en: "Cannot write ~/.dsh-cc/agent-preset.json, selection not saved";
    };
    readonly 'preset-locked-saved-default': {
        readonly zh: "会话已开始，preset 已锁定（当前：{{current}}）· 已保存为默认：{{id}}（/new 或下次启动生效）";
        readonly en: "Session already started, preset locked (current: {{current}}) · Saved as default: {{id}} (applies on /new or next start)";
    };
    readonly 'preset-switch-failed': {
        readonly zh: "Preset 切换失败 · {{err}}";
        readonly en: "Preset switch failed · {{err}}";
    };
    readonly 'preset-switched-pref-failed': {
        readonly zh: "Preset 已切换：{{id}}，但默认偏好写入失败（重启后不保留）";
        readonly en: "Preset switched: {{id}}, but writing the default preference failed (won't persist after restart)";
    };
    readonly 'preset-switched-saved': {
        readonly zh: "Preset 已切换：{{id}}（已保存为默认）";
        readonly en: "Preset switched: {{id}} (saved as default)";
    };
    readonly 'mcp-none-configured': {
        readonly zh: "未配置 MCP 服务器。";
        readonly en: "No MCP servers configured.";
    };
    readonly 'mcp-insert-hint': {
        readonly zh: "在 profile 补丁层（~/.dsh/profiles/dsh-tui/cordis.patch.yml）insert 一行即可，例：";
        readonly en: "Insert one line in the profile patch layer (~/.dsh/profiles/dsh-tui/cordis.patch.yml), e.g.:";
    };
    readonly 'mcp-readme-hint': {
        readonly zh: "详见仓库 README 的 MCP 章节。";
        readonly en: "See the MCP section of the repo README.";
    };
    readonly 'mcp-server-tools': {
        readonly zh: "{{server}}（{{count}} 个工具）: {{tools}}";
        readonly en: "{{server}} ({{count}} tools): {{tools}}";
    };
    readonly 'child-stderr-line': {
        readonly zh: "子进程 stderr: {{line}}";
        readonly en: "Subprocess stderr: {{line}}";
    };
    readonly 'child-stderr-line-repeat': {
        readonly zh: "子进程 stderr: {{line}}（重复 {{count}} 次）";
        readonly en: "Subprocess stderr: {{line}} (repeated {{count}}×)";
    };
    readonly 'export-title': {
        readonly zh: "# dsh-tui 会话导出";
        readonly en: "# dsh-tui session export";
    };
    readonly 'export-time': {
        readonly zh: "- 导出时间: {{time}}";
        readonly en: "- Exported: {{time}}";
    };
    readonly 'export-model': {
        readonly zh: "- 模型: {{model}}";
        readonly en: "- Model: {{model}}";
    };
    readonly 'export-session': {
        readonly zh: "- 会话: {{id}}";
        readonly en: "- Session: {{id}}";
    };
    readonly 'export-dir': {
        readonly zh: "- 目录: {{cwd}}";
        readonly en: "- Directory: {{cwd}}";
    };
    readonly 'mentions-attached': {
        readonly zh: "已附加 {{count}} 个文件引用";
        readonly en: "Attached {{count}} file reference(s)";
    };
    readonly 'mentions-missing': {
        readonly zh: "未找到引用: {{paths}}";
        readonly en: "References not found: {{paths}}";
    };
    readonly 'send-failed': {
        readonly zh: "发送失败 · {{err}}";
        readonly en: "Send failed · {{err}}";
    };
    readonly 'export-user-section': {
        readonly zh: "## 用户";
        readonly en: "## User";
    };
    readonly 'export-thinking-section': {
        readonly zh: "## 思考";
        readonly en: "## Thinking";
    };
    readonly 'export-assistant-section': {
        readonly zh: "## 助手";
        readonly en: "## Assistant";
    };
    readonly 'export-tool-section': {
        readonly zh: "## 工具 · {{name}}";
        readonly en: "## Tool · {{name}}";
    };
    readonly 'export-result-section': {
        readonly zh: "### 结果";
        readonly en: "### Result";
    };
    readonly 'agentsmd-project': {
        readonly zh: "## 项目";
        readonly en: "## Project";
    };
    readonly 'agentsmd-project-body': {
        readonly zh: "（在此描述项目的目标、结构与约定——这份文件会注入给每个 agent 作为工作区上下文。）";
        readonly en: "(Describe the project's goals, structure and conventions here — this file is injected to every agent as workspace context.)";
    };
    readonly 'agentsmd-conventions': {
        readonly zh: "## 约定";
        readonly en: "## Conventions";
    };
    readonly 'agentsmd-convention-read': {
        readonly zh: "- 改动前先阅读相关模块";
        readonly en: "- Read the relevant modules before making changes";
    };
    readonly 'agentsmd-convention-style': {
        readonly zh: "- 保持与现有代码风格一致";
        readonly en: "- Keep consistent with the existing code style";
    };
    readonly 'doctor-api-key': {
        readonly zh: "API key: {{state}}";
        readonly en: "API key: {{state}}";
    };
    readonly 'doctor-key-configured': {
        readonly zh: "已配置";
        readonly en: "configured";
    };
    readonly 'doctor-key-missing': {
        readonly zh: "未配置（DEEPSEEK_API_KEY）";
        readonly en: "not configured (DEEPSEEK_API_KEY)";
    };
    readonly 'doctor-model': {
        readonly zh: "模型: {{model}} · 提供方: {{provider}}";
        readonly en: "Model: {{model}} · Provider: {{provider}}";
    };
    readonly 'doctor-cwd': {
        readonly zh: "工作目录: {{cwd}}";
        readonly en: "Working directory: {{cwd}}";
    };
    readonly 'doctor-context-window': {
        readonly zh: "上下文窗口: {{window}} tokens";
        readonly en: "Context window: {{window}} tokens";
    };
    readonly 'doctor-unknown': {
        readonly zh: "未知";
        readonly en: "unknown";
    };
    readonly 'doctor-session': {
        readonly zh: "会话: {{id}}";
        readonly en: "Session: {{id}}";
    };
    readonly 'doctor-config': {
        readonly zh: "配置: {{candidate}} {{state}}";
        readonly en: "Config: {{candidate}} {{state}}";
    };
    readonly 'doctor-config-missing': {
        readonly zh: "（不存在）";
        readonly en: "(missing)";
    };
    readonly 'doctor-storage': {
        readonly zh: "会话存储: {{dir}} {{state}}";
        readonly en: "Session storage: {{dir}} {{state}}";
    };
    readonly 'doctor-storage-uninit': {
        readonly zh: "（未初始化）";
        readonly en: "(not initialized)";
    };
    readonly 'subagent-not-mounted': {
        readonly zh: "子代理服务未挂载（leaf 未启用 subagent）";
        readonly en: "Subagent service not mounted (leaf has no subagent)";
    };
    readonly 'subagent-none': {
        readonly zh: "当前会话暂无子代理";
        readonly en: "No subagents in the current session";
    };
    readonly 'subagent-resumable': {
        readonly zh: "可续";
        readonly en: "resumable";
    };
    readonly 'subagent-oneshot': {
        readonly zh: "一次性";
        readonly en: "one-shot";
    };
    readonly 'subagent-row': {
        readonly zh: "{{mode}} {{label}}{{activity}} · {{id}}";
        readonly en: "{{mode}} {{label}}{{activity}} · {{id}}";
    };
    readonly 'subagent-running': {
        readonly zh: " 运行中";
        readonly en: " running";
    };
    readonly 'subagent-archived': {
        readonly zh: " 已归档";
        readonly en: " archived";
    };
    readonly 'subagent-query-failed': {
        readonly zh: "查询失败 · {{err}}";
        readonly en: "Query failed · {{err}}";
    };
    readonly 'agent-preset-switched': {
        readonly zh: "Agent preset 已切换：{{preset}}";
        readonly en: "Agent preset switched: {{preset}}";
    };
    readonly 'questionnaire-answered': {
        readonly zh: "📋 问卷已答 · {{total}} 题";
        readonly en: "📋 Questionnaire answered · {{total}} questions";
    };
    readonly 'theme-sakura-name': {
        readonly zh: "樱花粉";
        readonly en: "Sakura Pink";
    };
    readonly 'context-truncated': {
        readonly zh: "…（已截断）";
        readonly en: "… (truncated)";
    };
    readonly 'context-sections': {
        readonly zh: "系统提示词 {{n}} 段";
        readonly en: "System prompt {{n}} sections";
    };
    readonly 'context-files': {
        readonly zh: "工作区指令 ×{{n}}";
        readonly en: "Workspace instructions ×{{n}}";
    };
    readonly 'context-runtime': {
        readonly zh: "运行时上下文 {{n}} 项";
        readonly en: "Runtime context {{n}} items";
    };
    readonly 'context-skills': {
        readonly zh: "技能 {{n}}";
        readonly en: "Skills {{n}}";
    };
    readonly 'context-tools': {
        readonly zh: "工具 {{n}}";
        readonly en: "Tools {{n}}";
    };
    readonly 'skill-audit-prompt': {
        readonly zh: "请使用 audit 技能对当前项目做一次全面的代码审计，找出安全、正确性与质量问题。";
        readonly en: "Use the audit skill to do a thorough code audit of the current project, finding security, correctness and quality issues.";
    };
    readonly 'skill-bug-prompt': {
        readonly zh: "请使用 bug 技能协助我记录一份完整的 bug 报告（现象、复现步骤、期望行为）。";
        readonly en: "Use the bug skill to help me write a complete bug report (symptoms, reproduction steps, expected behavior).";
    };
    readonly 'skill-practice-prompt': {
        readonly zh: "请使用 practice 技能陪我进行一轮编程练习。";
        readonly en: "Use the practice skill to run a round of programming practice with me.";
    };
    readonly 'skill-review-prompt': {
        readonly zh: "请使用 review 技能对当前项目做一次全面的代码评审。";
        readonly en: "Use the review skill to do a thorough code review of the current project.";
    };
    readonly 'skill-pr-comments-prompt': {
        readonly zh: "请使用 pr-comments 技能审查当前分支的拉取请求评论并给出改进建议。";
        readonly en: "Use the pr-comments skill to review pull request comments on the current branch and suggest improvements.";
    };
    readonly 'skill-release-notes-prompt': {
        readonly zh: "请使用 release-notes 技能为当前项目生成发布说明。";
        readonly en: "Use the release-notes skill to generate release notes for the current project.";
    };
    readonly 'skill-vuln-check-prompt': {
        readonly zh: "请使用 vuln-check 技能对当前项目做一次安全漏洞检查。";
        readonly en: "Use the vuln-check skill to run a security vulnerability check on the current project.";
    };
    readonly 'context-loaded': {
        readonly zh: "已加载上下文";
        readonly en: "Context loaded";
    };
    readonly 'copied-chars': {
        readonly zh: "已复制 {{n}} 个字符";
        readonly en: "Copied {{n}} characters";
    };
    readonly 'activity-usage-name': {
        readonly zh: "/activity frames <名>";
        readonly en: "/activity frames <name>";
    };
    readonly 'activity-current-preset': {
        readonly zh: "当前预设  {{name}}";
        readonly en: "Current preset  {{name}}";
    };
    readonly 'activity-switch-hint': {
        readonly zh: "切换      /activity（选择器）或 /activity frames <名>";
        readonly en: "Switch      /activity (picker) or /activity frames <name>";
    };
    readonly 'activity-persist-hint': {
        readonly zh: "持久化    ~/.dsh-cc/working-activity.json（重启后仍生效）";
        readonly en: "Persisted    ~/.dsh-cc/working-activity.json (survives restart)";
    };
    readonly 'activity-current-direct': {
        readonly zh: "当前预设：{{name}} · /activity frames <名> 直接切换：";
        readonly en: "Current preset: {{name}} · /activity frames <name> to switch directly:";
    };
    readonly 'activity-random-each': {
        readonly zh: "每次随机";
        readonly en: "random each time";
    };
    readonly 'activity-current-marker': {
        readonly zh: "  ← 当前";
        readonly en: "  ← current";
    };
    readonly 'activity-usage': {
        readonly zh: "用法：/activity | /activity frames <名> | /activity status";
        readonly en: "Usage: /activity | /activity frames <name> | /activity status";
    };
    readonly 'preset-current': {
        readonly zh: "当前 preset  {{name}}";
        readonly en: "Current preset  {{name}}";
    };
    readonly 'preset-roster-missing': {
        readonly zh: "（未挂载名册）";
        readonly en: "(roster not mounted)";
    };
    readonly 'preset-switch-hint': {
        readonly zh: "切换        /preset（选择器）或 /preset <id>";
        readonly en: "Switch        /preset (picker) or /preset <id>";
    };
    readonly 'preset-persist-hint': {
        readonly zh: "持久化      ~/.dsh-cc/agent-preset.json（重启后仍生效；cordis.yml preset 优先）";
        readonly en: "Persisted      ~/.dsh-cc/agent-preset.json (survives restart; cordis.yml preset wins)";
    };
    readonly 'preset-lock-hint': {
        readonly zh: "锁定规则    已开始的会话不可切换（官方 blank-only 规则）";
        readonly en: "Lock rule     started sessions cannot switch (official blank-only rule)";
    };
    readonly 'preset-roster-unmounted': {
        readonly zh: "当前组合未挂载 agent-presets 名册（preset 不可用）";
        readonly en: "The agent-presets roster is not mounted (presets unavailable)";
    };
    readonly 'theme-name-arg': {
        readonly zh: "/theme <名字>";
        readonly en: "/theme <name>";
    };
    readonly 'theme-current': {
        readonly zh: "当前主题  {{name}}";
        readonly en: "Current theme  {{name}}";
    };
    readonly 'theme-switch-hint': {
        readonly zh: "切换      /theme（选择器）或 /theme <名字>";
        readonly en: "Switch      /theme (picker) or /theme <name>";
    };
    readonly 'theme-persist-hint': {
        readonly zh: "持久化    ~/.dsh-cc/theme.json（重启后仍生效；CC_TUI_THEME 优先）";
        readonly en: "Persisted    ~/.dsh-cc/theme.json (survives restart; CC_TUI_THEME wins)";
    };
    readonly 'theme-custom-hint': {
        readonly zh: "自定义    ~/.dsh-cc/themes/<名字>.json（见 README「自定义主题」）";
        readonly en: "Custom      ~/.dsh-cc/themes/<name>.json (see README \"Custom themes\")";
    };
    readonly 'theme-switched-saved': {
        readonly zh: "主题已切换：{{name}}（已保存）";
        readonly en: "Theme switched: {{name}} (saved)";
    };
    readonly 'theme-unknown': {
        readonly zh: "未知主题「{{name}}」· /theme 查看全部";
        readonly en: "Unknown theme \"{{name}}\" · /theme to view all";
    };
    readonly 'status-model': {
        readonly zh: "模型   {{model}}";
        readonly en: "Model   {{model}}";
    };
    readonly 'status-working': {
        readonly zh: "工作中";
        readonly en: "working";
    };
    readonly 'status-idle': {
        readonly zh: "空闲";
        readonly en: "idle";
    };
    readonly 'status-state': {
        readonly zh: "状态   {{state}}";
        readonly en: "Status   {{state}}";
    };
    readonly 'status-session': {
        readonly zh: "会话   {{id}}";
        readonly en: "Session   {{id}}";
    };
    readonly 'status-dir': {
        readonly zh: "目录   {{cwd}}";
        readonly en: "Directory   {{cwd}}";
    };
    readonly 'cost-cache-rate': {
        readonly zh: "缓存率 {{rate}}% · {{read}} 读 / {{write}} 写";
        readonly en: "Cache rate {{rate}}% · {{read}} read / {{write}} write";
    };
    readonly 'cost-context': {
        readonly zh: "上下文 {{pct}}%";
        readonly en: "Context {{pct}}%";
    };
    readonly 'status-title': {
        readonly zh: "标题   {{title}}";
        readonly en: "Title   {{title}}";
    };
    readonly 'cost-cache-hit-rate': {
        readonly zh: "缓存命中率 {{rate}}% · 缓存 {{read}} 读 / {{write}} 写";
        readonly en: "Cache hit rate {{rate}}% · cache {{read}} read / {{write}} write";
    };
    readonly 'cost-note': {
        readonly zh: "注：DSH 不提供 API 费用计量，以上为 token 用量（按 provider 账单计费）";
        readonly en: "Note: DSH provides no API cost metering; the above is token usage (billed by your provider)";
    };
    readonly 'doctor-example-config': {
        readonly zh: "示例配置  {{path}}";
        readonly en: "Example config  {{path}}";
    };
    readonly 'doctor-user-config': {
        readonly zh: "用户配置  {{path}}";
        readonly en: "User config  {{path}}";
    };
    readonly 'doctor-launch-hint': {
        readonly zh: "启动方式  dsh-tui.cmd / dsh --profile dsh-tui";
        readonly en: "Launch      dsh-tui.cmd / dsh --profile dsh-tui";
    };
    readonly 'doctor-route-hint': {
        readonly zh: "模型路由  由 cordis.yml 的 llm-deepseek 段决定（/model 仅提示重启生效）";
        readonly en: "Model route  set by the llm-deepseek block in cordis.yml (/model only hints at restart)";
    };
    readonly 'export-failed': {
        readonly zh: "导出失败（无法写入工作目录）";
        readonly en: "Export failed (cannot write to working directory)";
    };
    readonly 'export-saved': {
        readonly zh: "已导出: {{target}}";
        readonly en: "Exported: {{target}}";
    };
    readonly 'agentsmd-create-failed': {
        readonly zh: "创建 AGENTS.md 失败";
        readonly en: "Failed to create AGENTS.md";
    };
    readonly 'agentsmd-exists': {
        readonly zh: "AGENTS.md 已存在，未覆盖";
        readonly en: "AGENTS.md already exists, not overwritten";
    };
    readonly 'agentsmd-created': {
        readonly zh: "已创建 {{result}}";
        readonly en: "Created {{result}}";
    };
    readonly 'login-api-key': {
        readonly zh: "API key: {{key}}";
        readonly en: "API key: {{key}}";
    };
    readonly 'login-key-missing': {
        readonly zh: "未配置（DEEPSEEK_API_KEY）";
        readonly en: "not configured (DEEPSEEK_API_KEY)";
    };
    readonly 'login-base-url': {
        readonly zh: "Base URL: {{url}}";
        readonly en: "Base URL: {{url}}";
    };
    readonly 'login-official-endpoint': {
        readonly zh: "官方端点";
        readonly en: "official endpoint";
    };
    readonly 'login-source-hint': {
        readonly zh: "来源：环境变量 → 工作区 .env（run.ts 兜底读取）";
        readonly en: "Source: env var → workspace .env (run.ts fallback)";
    };
    readonly 'login-logout-hint': {
        readonly zh: "DSH 凭证来自环境变量 DEEPSEEK_API_KEY — 删除该环境变量后重启 dsh-tui 即登出";
        readonly en: "DSH credentials come from the DEEPSEEK_API_KEY env var — remove it and restart dsh-tui to log out";
    };
    readonly 'permissions-policy-hint': {
        readonly zh: "DSH 权限策略由 fs-policy / bash-sandbox 配置决定（当前 leaf：workspace 内读写、写入需已读文件）。";
        readonly en: "DSH permission policy is set by fs-policy / bash-sandbox config (current leaf: read/write in workspace, writes need a prior read).";
    };
    readonly 'permissions-approval-hint': {
        readonly zh: "DSH 的 /permission 预设切换需要 approval 服务 + 审批 UI，dsh-tui 未挂载。";
        readonly en: "DSH /permission preset switching needs the approval service + approval UI, not mounted in dsh-tui.";
    };
    readonly 'permissions-root-hint': {
        readonly zh: "当前文件系统策略以工作目录为根：{{cwd}}";
        readonly en: "Current filesystem policy is rooted at the working directory: {{cwd}}";
    };
    readonly 'permissions-path-hint': {
        readonly zh: "模型工具相对路径均解析自该目录；跨目录访问由 fs-policy 拦截。";
        readonly en: "Relative paths of model tools resolve from this directory; cross-directory access is blocked by fs-policy.";
    };
    readonly 'hooks-not-mounted': {
        readonly zh: "DSH hooks（dsh-hooks-claude / dsh-hooks-codex）未在本 leaf 挂载。";
        readonly en: "DSH hooks (dsh-hooks-claude / dsh-hooks-codex) are not mounted in this leaf.";
    };
    readonly 'hooks-mount-hint': {
        readonly zh: "需要时可在 cordis.yml 挂载对应 hooks 插件。";
        readonly en: "Mount the matching hooks plugin in cordis.yml when needed.";
    };
    readonly 'memory-none': {
        readonly zh: "DSH 暂无持久记忆服务。";
        readonly en: "DSH has no persistent memory service yet.";
    };
    readonly 'memory-hint': {
        readonly zh: "长期约定可写入 AGENTS.md（工作区上下文）或技能（~/.dsh/skills）。";
        readonly en: "Long-term conventions can go into AGENTS.md (workspace context) or skills (~/.dsh/skills).";
    };
    readonly 'update-unavailable': {
        readonly zh: "当前运行方式不支持自动更新（需经 dsh --profile 启动），请在终端执行 dsh plugin --profile <name> update @deepseek-harness-tui/dsh-tui";
        readonly en: "Automatic update is unavailable in this launch mode (needs dsh --profile). Run dsh plugin --profile <name> update @deepseek-harness-tui/dsh-tui in a terminal.";
    };
    readonly 'update-working': {
        readonly zh: "当前回合仍在运行，请等待完成后再更新 TUI。";
        readonly en: "The current turn is still running. Wait for it to finish before updating the TUI.";
    };
    readonly 'update-starting': {
        readonly zh: "正在更新 @deepseek-harness-tui/dsh-tui，完成后会自动重启并恢复当前会话……";
        readonly en: "Updating @deepseek-harness-tui/dsh-tui. The TUI will restart and resume this session when finished…";
    };
    readonly 'update-available': {
        readonly zh: "发现新版本：v{{latest}}（当前 v{{current}}）· 输入 /update 更新 TUI";
        readonly en: "New version available: v{{latest}} (current v{{current}}) · type /update to update the TUI";
    };
    readonly 'update-already-latest': {
        readonly zh: "当前已是最新版本（v{{current}}）。";
        readonly en: "Already on the latest version (v{{current}}).";
    };
    readonly 'update-check-failed': {
        readonly zh: "无法确认新版本（网络或 registry 不可达），已尝试直接更新……";
        readonly en: "Could not confirm a newer version (network or registry unreachable); attempting the update anyway…";
    };
    readonly 'vim-not-implemented': {
        readonly zh: "vim 模式暂未实现";
        readonly en: "vim mode not implemented yet";
    };
    readonly 'terminal-setup-hint': {
        readonly zh: "推荐 Windows Terminal（≥110 列、等宽字体、TrueColor）。";
        readonly en: "Recommended: Windows Terminal (≥110 columns, monospace, TrueColor).";
    };
    readonly 'terminal-paste-hint': {
        readonly zh: "{{mod}}V 粘贴文本/文件路径；Ctrl+Shift+V 终端原生粘贴；右键粘贴同样可用。";
        readonly en: "{{mod}}V pastes text/file paths; Ctrl+Shift+V is native terminal paste; right-click paste also works.";
    };
    readonly 'connect-none': {
        readonly zh: "DSH 暂无远程连接机制（CC 的 /connect 对应能力未适配）。";
        readonly en: "DSH has no remote connection mechanism (CC's /connect equivalent is not adapted).";
    };
    readonly 'theme-switch-failed': {
        readonly zh: "主题「{{name}}」切换失败（无法写入 ~/.dsh-cc/theme.json）";
        readonly en: "Theme \"{{name}}\" switch failed (cannot write ~/.dsh-cc/theme.json)";
    };
    readonly 'interrupt-delivered': {
        readonly zh: "已打断当前回合，{{n}} 条消息立即处理";
        readonly en: "Interrupted current turn, {{n}} messages processed immediately";
    };
    readonly 'btw-usage': {
        readonly zh: "用法：/btw <问题> —— 不打断当前对话的快速侧问";
        readonly en: "Usage: /btw <question> — quick side question without interrupting the conversation";
    };
    readonly 'btw-answering': {
        readonly zh: "思考中…";
        readonly en: "Answering…";
    };
    readonly 'btw-hint-loading': {
        readonly zh: "Esc 取消";
        readonly en: "Esc cancel";
    };
    readonly 'btw-hint-done': {
        readonly zh: "↑/↓ 滚动 · Space/Enter/Esc 关闭 · c 复制";
        readonly en: "↑/↓ scroll · Space/Enter/Esc dismiss · c copy";
    };
    readonly 'btw-llm-unavailable': {
        readonly zh: "侧问不可用（llm 服务未挂载）";
        readonly en: "Side question unavailable (llm service not mounted)";
    };
    readonly 'activity-ctx-warn': {
        readonly zh: "⚠ 上下文";
        readonly en: "⚠ ctx ";
    };
    readonly 'activity-random-each-preset': {
        readonly zh: "每次随机一个预设";
        readonly en: "random preset each time";
    };
    readonly 'preset-default-tag': {
        readonly zh: "（默认）";
        readonly en: " (default)";
    };
    readonly 'preset-broken-tag': {
        readonly zh: "（无法加载）";
        readonly en: " (failed to load)";
    };
    readonly 'effort-unavailable': {
        readonly zh: "推理等级切换不可用（llm 服务未挂载）";
        readonly en: "Reasoning effort switching unavailable (llm service not mounted)";
    };
    readonly 'effort-read-failed': {
        readonly zh: "推理等级读取失败 · {{error}}";
        readonly en: "Failed to read reasoning efforts · {{error}}";
    };
    readonly 'effort-single-tier': {
        readonly zh: "当前模型只有一档推理等级（{{name}}）";
        readonly en: "Current model has a single reasoning effort ({{name}})";
    };
    readonly 'effort-unsupported': {
        readonly zh: "当前模型不支持推理等级切换";
        readonly en: "Current model does not support reasoning effort switching";
    };
    readonly 'effort-switched': {
        readonly zh: "推理强度 → {{name}}";
        readonly en: "Reasoning effort → {{name}}";
    };
    readonly 'effort-invalid': {
        readonly zh: "未知推理等级 {{id}}（当前模型可选：{{ids}}）";
        readonly en: "Unknown reasoning effort {{id}} (this model offers: {{ids}})";
    };
    readonly 'effort-current': {
        readonly zh: "当前推理强度 {{name}}";
        readonly en: "Current reasoning effort {{name}}";
    };
    readonly 'effort-usage': {
        readonly zh: "用法：/effort（滑杆）| /effort <id> | /effort status";
        readonly en: "Usage: /effort (slider) | /effort <id> | /effort status";
    };
    readonly 'mode-switched': {
        readonly zh: "模式 → {{name}}";
        readonly en: "Mode → {{name}}";
    };
    readonly 'mode-default': {
        readonly zh: "默认";
        readonly en: "default";
    };
    readonly 'mode-plan': {
        readonly zh: "计划模式";
        readonly en: "plan mode";
    };
    readonly 'mode-full': {
        readonly zh: "完全访问";
        readonly en: "full access";
    };
    readonly 'mode-plan-unavailable': {
        readonly zh: "当前 preset 未注册 /plan 命令，无法切换计划模式";
        readonly en: "The active preset does not register /plan; cannot toggle plan mode";
    };
    readonly 'logo-tagline': {
        readonly zh: "探索未至之境！";
        readonly en: "Explore the uncharted!";
    };
    readonly 'logo-tip-model': {
        readonly zh: "切换模型";
        readonly en: "switch model";
    };
    readonly 'logo-tip-help': {
        readonly zh: "查看命令";
        readonly en: "view commands";
    };
    readonly 'logo-tip-tab': {
        readonly zh: "自动补全";
        readonly en: "autocomplete";
    };
    readonly 'input-sent-after-turn': {
        readonly zh: "已发送，当前回合结束后处理";
        readonly en: "Sent, processed after the current turn";
    };
    readonly 'input-interrupted-next': {
        readonly zh: "已插话 · 下一步立即处理";
        readonly en: "Interrupted · processed next";
    };
    readonly 'input-queued-after-turn': {
        readonly zh: "已排队 · 回合结束后处理";
        readonly en: "Queued · processed after the turn";
    };
    readonly 'input-cannot-retract': {
        readonly zh: "无法撤回：消息可能已被处理，或当前版本不支持";
        readonly en: "Cannot retract: the message may already be processed, or this version doesn't support it";
    };
    readonly 'input-retracted': {
        readonly zh: "已撤回，可编辑后重新发送";
        readonly en: "Retracted, editable and resendable";
    };
    readonly 'input-empty': {
        readonly zh: "输入为空，没有可发送的内容";
        readonly en: "Empty input, nothing to send";
    };
    readonly 'input-interrupt-immediate': {
        readonly zh: "已打断当前回合，正在立即处理";
        readonly en: "Interrupted current turn, processing immediately";
    };
    readonly 'input-clipboard-empty': {
        readonly zh: "剪贴板为空";
        readonly en: "Clipboard is empty";
    };
    readonly 'input-pending-steer-label': {
        readonly zh: "插话 · 下一步送达";
        readonly en: "Steer · delivered next";
    };
    readonly 'input-pending-queue-label': {
        readonly zh: "排队 · 回合结束后送达";
        readonly en: "Queued · delivered after the turn";
    };
    readonly 'input-pending-actions-hint': {
        readonly zh: "撤回 · Esc 打断并立即发送";
        readonly en: "Retract · Esc interrupts and sends immediately";
    };
    readonly 'frame-blink': {
        readonly zh: "眨眼";
        readonly en: "blink";
    };
    readonly 'frame-fin-1': {
        readonly zh: "动腹鳍1";
        readonly en: "fin1";
    };
    readonly 'frame-fin-2': {
        readonly zh: "动腹鳍2";
        readonly en: "fin2";
    };
    readonly 'frame-spout-1': {
        readonly zh: "喷水花1";
        readonly en: "spout1";
    };
    readonly 'frame-spout-2': {
        readonly zh: "喷水花2";
        readonly en: "spout2";
    };
    readonly 'frame-spout-3': {
        readonly zh: "喷水花3";
        readonly en: "spout3";
    };
    readonly 'frame-spout-4': {
        readonly zh: "喷水花4";
        readonly en: "spout4";
    };
    readonly 'frame-spout-5': {
        readonly zh: "喷水花5";
        readonly en: "spout5";
    };
    readonly 'frame-spout-6': {
        readonly zh: "喷水花6";
        readonly en: "spout6";
    };
    readonly 'frame-tail-1': {
        readonly zh: "摆尾巴1";
        readonly en: "tail1";
    };
    readonly 'frame-tail-2': {
        readonly zh: "摆尾巴2";
        readonly en: "tail2";
    };
    readonly 'frame-tail-3': {
        readonly zh: "摆尾巴3";
        readonly en: "tail3";
    };
    readonly 'load-earlier': {
        readonly zh: " ↑ 加载更早消息（会话日志完整，/export 导出全文） ";
        readonly en: " ↑ load earlier messages (full session log; /export for full text) ";
    };
    readonly 'resume-none-in-cwd': {
        readonly zh: "当前目录没有可恢复的历史会话";
        readonly en: "No resumable sessions in the current directory";
    };
    readonly 'rename-usage': {
        readonly zh: "用法  /rename <新名称>";
        readonly en: "Usage  /rename <new title>";
    };
    readonly 'rename-current': {
        readonly zh: "当前名称  {{title}}";
        readonly en: "Current title  {{title}}";
    };
    readonly 'rename-done': {
        readonly zh: "已重命名为「{{title}}」";
        readonly en: "Renamed to \"{{title}}\"";
    };
    readonly 'compact-summary-folded': {
        readonly zh: "摘要已折叠";
        readonly en: "Summary folded";
    };
    readonly 'theme-builtin-base': {
        readonly zh: "内置 · {{name}} 基底";
        readonly en: "Built-in · {{name}} base";
    };
    readonly 'theme-user-base': {
        readonly zh: "{{base}} 基底 · ~/.dsh-cc/themes/{{name}}.json";
        readonly en: "{{base}} base · ~/.dsh-cc/themes/{{name}}.json";
    };
    readonly 'context-panel-collapse': {
        readonly zh: "折叠";
        readonly en: "Collapse";
    };
    readonly 'context-panel-expand': {
        readonly zh: "展开";
        readonly en: "Expand";
    };
    readonly 'context-panel-sections': {
        readonly zh: "系统提示词 · {{n}} 段";
        readonly en: "System prompt · {{n}} sections";
    };
    readonly 'context-panel-files': {
        readonly zh: "工作区指令 · {{n}} 个文件";
        readonly en: "Workspace instructions · {{n}} files";
    };
    readonly 'context-panel-runtime': {
        readonly zh: "运行时上下文 · {{n}} 项";
        readonly en: "Runtime context · {{n}} items";
    };
    readonly 'context-panel-skills': {
        readonly zh: "技能 · {{n}}";
        readonly en: "Skills · {{n}}";
    };
    readonly 'context-panel-tools': {
        readonly zh: "工具 · {{n}}";
        readonly en: "Tools · {{n}}";
    };
    readonly 'question-select-or-answer': {
        readonly zh: "至少选择一个选项，或在最后一行输入回答";
        readonly en: "Select at least one option, or type an answer on the last line";
    };
    readonly 'question-answer-or-check': {
        readonly zh: "输入回答或勾选选项后再提交";
        readonly en: "Type an answer or check options before submitting";
    };
    readonly 'question-type-answer-first': {
        readonly zh: "先输入回答内容再提交";
        readonly en: "Type your answer before submitting";
    };
    readonly 'question-header-progress': {
        readonly zh: " 📋 提问 · 第 {{position}}/{{total}} 题{{remaining}} ";
        readonly en: " 📋 Question {{position}}/{{total}} {{remaining}} ";
    };
    readonly 'question-remaining-more': {
        readonly zh: " · 还剩 {{n}} 题";
        readonly en: " · {{n}} left";
    };
    readonly 'question-hint-type': {
        readonly zh: "输入回答";
        readonly en: "Type answer";
    };
    readonly 'question-hint-enter': {
        readonly zh: "Enter 提交";
        readonly en: "Enter submit";
    };
    readonly 'question-hint-back': {
        readonly zh: "↑ 返回选项";
        readonly en: "↑ back to options";
    };
    readonly 'question-hint-esc': {
        readonly zh: "Esc 中断";
        readonly en: "Esc cancel";
    };
    readonly 'question-hint-selected': {
        readonly zh: "已选 {{n}}";
        readonly en: "Selected {{n}}";
    };
    readonly 'question-hint-select': {
        readonly zh: "↑/↓ 选择";
        readonly en: "↑/↓ select";
    };
    readonly 'question-hint-multi': {
        readonly zh: "Space 多选";
        readonly en: "Space multi-select";
    };
    readonly 'question-hint-attach': {
        readonly zh: "输入文字附带回答";
        readonly en: "Type text to attach an answer";
    };
    readonly 'question-custom-tab': {
        readonly zh: "自定义回答";
        readonly en: "Custom answer";
    };
    readonly 'question-attached-label': {
        readonly zh: "（附加：{{label}}）";
        readonly en: "(attached: {{label}})";
    };
    readonly 'question-direct-input': {
        readonly zh: "直接输入…";
        readonly en: "Type directly…";
    };
    readonly 'approval-waiting': {
        readonly zh: " ⏳ 等待审批 · {{tool}} ";
        readonly en: " Awaiting approval · {{tool}} ";
    };
    readonly 'approval-proceed': {
        readonly zh: "要允许这次操作吗？";
        readonly en: "Do you want to proceed?";
    };
    readonly 'approval-yes': {
        readonly zh: "允许（仅本次）";
        readonly en: "Yes, allow once";
    };
    readonly 'approval-no': {
        readonly zh: "拒绝";
        readonly en: "No";
    };
    readonly 'approval-hint': {
        readonly zh: "↑/↓ 选择 · Enter 确认 · Esc 拒绝";
        readonly en: "↑/↓ select · Enter confirm · Esc reject";
    };
    readonly 'plan-review-fallback-header': {
        readonly zh: "计划评审";
        readonly en: "Plan review";
    };
    readonly 'plan-review-feedback-placeholder': {
        readonly zh: "输入反馈，告诉模型要改什么…";
        readonly en: "Tell the model what to change…";
    };
    readonly 'plan-review-approve-needs-empty': {
        readonly zh: "请先清空反馈再批准（或在输入行回车提交反馈）";
        readonly en: "Clear the feedback to approve (or press Enter on the input row to send it)";
    };
    readonly 'plan-review-hint': {
        readonly zh: "↑/↓ 选择 · 1/2 快选 · 打字输入反馈 · Enter 提交 · Esc 打断评审";
        readonly en: "↑/↓ select · 1/2 quick-pick · type feedback · Enter submit · Esc dismiss";
    };
    readonly 'provider-unavailable': {
        readonly zh: "/provider 需要经 dsh profile 启动（settings / credentials / llm-pi-ai 服务未挂载）";
        readonly en: "/provider requires starting through a dsh profile (settings / credentials / llm-pi-ai services not mounted)";
    };
    readonly 'provider-q-mode': {
        readonly zh: "要添加哪种模型提供方？";
        readonly en: "Which kind of model provider do you want to add?";
    };
    readonly 'provider-opt-catalog': {
        readonly zh: "内置 provider";
        readonly en: "Built-in provider";
    };
    readonly 'provider-opt-catalog-desc': {
        readonly zh: "openai、anthropic、deepseek 等内置目录，自动继承端点与协议";
        readonly en: "Built-in catalog such as openai, anthropic, deepseek — endpoint and protocol inherited";
    };
    readonly 'provider-opt-custom': {
        readonly zh: "自定义 API 端点";
        readonly en: "Custom API endpoint";
    };
    readonly 'provider-opt-custom-desc': {
        readonly zh: "OpenAI / Anthropic 兼容的网关或自建服务";
        readonly en: "An OpenAI/Anthropic-compatible gateway or self-hosted server";
    };
    readonly 'provider-q-catalog': {
        readonly zh: "选择 provider";
        readonly en: "Choose a provider";
    };
    readonly 'provider-opt-other-route': {
        readonly zh: "其他（手动输入路由名）";
        readonly en: "Other (enter a route name)";
    };
    readonly 'provider-opt-other-route-desc': {
        readonly zh: "目录里没列出的 catalog 路由";
        readonly en: "A catalog route not listed above";
    };
    readonly 'provider-q-route-id': {
        readonly zh: "输入路由名";
        readonly en: "Enter a route name";
    };
    readonly 'provider-q-route-id-detail': {
        readonly zh: "小写字母开头，可含数字与连字符，如 my-gateway";
        readonly en: "Lowercase letter first, digits and dashes allowed, e.g. my-gateway";
    };
    readonly 'provider-route-id-invalid': {
        readonly zh: "路由名不合法：须以小写字母开头，仅含小写字母 / 数字 / 连字符";
        readonly en: "Invalid route name: must start with a lowercase letter, only lowercase letters / digits / dashes";
    };
    readonly 'provider-q-apikey': {
        readonly zh: "输入 API key";
        readonly en: "Enter the API key";
    };
    readonly 'provider-q-apikey-detail': {
        readonly zh: "密钥将写入 ~/.dsh/.credentials.yaml（权限 0600），不会出现在会话记录中";
        readonly en: "The key is stored in ~/.dsh/.credentials.yaml (mode 0600) and never shown in the transcript";
    };
    readonly 'provider-q-baseurl-choice': {
        readonly zh: "是否覆盖默认 API 端点（baseURL）？";
        readonly en: "Override the default API endpoint (baseURL)?";
    };
    readonly 'provider-opt-baseurl-skip': {
        readonly zh: "跳过，使用默认端点";
        readonly en: "Skip — use the default endpoint";
    };
    readonly 'provider-opt-baseurl-input': {
        readonly zh: "现在输入 baseURL";
        readonly en: "Enter a baseURL now";
    };
    readonly 'provider-q-baseurl': {
        readonly zh: "输入 baseURL";
        readonly en: "Enter the baseURL";
    };
    readonly 'provider-q-protocol': {
        readonly zh: "选择 API 协议";
        readonly en: "Choose the wire protocol";
    };
    readonly 'provider-protocol-completions-desc': {
        readonly zh: "OpenAI Chat Completions 兼容（大多数网关）";
        readonly en: "OpenAI Chat Completions compatible (most gateways)";
    };
    readonly 'provider-protocol-responses-desc': {
        readonly zh: "OpenAI Responses API";
        readonly en: "OpenAI Responses API";
    };
    readonly 'provider-protocol-anthropic-desc': {
        readonly zh: "Anthropic Messages API";
        readonly en: "Anthropic Messages API";
    };
    readonly 'provider-discovery-running': {
        readonly zh: "正在探测该端点公布的模型…";
        readonly en: "Discovering the models this endpoint advertises…";
    };
    readonly 'provider-discovery-failed': {
        readonly zh: "模型探测失败，改为手动输入模型 id";
        readonly en: "Model discovery failed — enter model ids manually instead";
    };
    readonly 'provider-q-models': {
        readonly zh: "选择要启用的模型（可在输入行逗号分隔补充）";
        readonly en: "Select the models to enable (add more comma-separated on the input row)";
    };
    readonly 'provider-q-models-fallback': {
        readonly zh: "输入模型 id（逗号分隔）";
        readonly en: "Enter model ids (comma-separated)";
    };
    readonly 'provider-models-required': {
        readonly zh: "自定义端点至少需要一个模型 id";
        readonly en: "A custom endpoint needs at least one model id";
    };
    readonly 'provider-q-confirm': {
        readonly zh: "确认写入该 provider 配置？";
        readonly en: "Write this provider configuration?";
    };
    readonly 'provider-route-exists-warning': {
        readonly zh: "⚠ 该路由已有配置，写入将覆盖现有设置";
        readonly en: "⚠ This route is already configured — writing overwrites it";
    };
    readonly 'provider-opt-confirm-write': {
        readonly zh: "写入并启用";
        readonly en: "Write and enable";
    };
    readonly 'provider-opt-confirm-cancel': {
        readonly zh: "取消";
        readonly en: "Cancel";
    };
    readonly 'provider-line-route': {
        readonly zh: "路由：{{route}}";
        readonly en: "Route: {{route}}";
    };
    readonly 'provider-line-keyref': {
        readonly zh: "密钥引用：{{ref}}（已写入 ~/.dsh/.credentials.yaml）";
        readonly en: "Key ref: {{ref}} (stored in ~/.dsh/.credentials.yaml)";
    };
    readonly 'provider-line-keyref-env': {
        readonly zh: "密钥引用：{{ref}}（进程环境已提供同名变量，跳过写入）";
        readonly en: "Key ref: {{ref}} (already in the process environment, write skipped)";
    };
    readonly 'provider-line-baseurl': {
        readonly zh: "baseURL：{{url}}";
        readonly en: "baseURL: {{url}}";
    };
    readonly 'provider-line-protocol': {
        readonly zh: "协议：{{api}}";
        readonly en: "Protocol: {{api}}";
    };
    readonly 'provider-line-models': {
        readonly zh: "模型：{{models}}";
        readonly en: "Models: {{models}}";
    };
    readonly 'provider-line-models-catalog': {
        readonly zh: "模型：整个 catalog（未收窄）";
        readonly en: "Models: the whole catalog (not narrowed)";
    };
    readonly 'provider-rollback-ok': {
        readonly zh: "已回滚刚写入的密钥";
        readonly en: "Rolled back the just-written key";
    };
    readonly 'provider-rollback-failed': {
        readonly zh: "密钥回滚失败，请手动检查 ~/.dsh/.credentials.yaml";
        readonly en: "Key rollback failed — check ~/.dsh/.credentials.yaml manually";
    };
    readonly 'provider-write-failed': {
        readonly zh: "provider 配置写入失败 · {{err}}";
        readonly en: "Failed to write the provider configuration · {{err}}";
    };
    readonly 'provider-cancelled': {
        readonly zh: "已取消添加 provider";
        readonly en: "Provider setup cancelled";
    };
    readonly 'provider-success': {
        readonly zh: "provider {{route}} 已添加";
        readonly en: "Provider {{route}} added";
    };
    readonly 'provider-switch-hint': {
        readonly zh: "运行 /model 可切换到新 provider 的模型";
        readonly en: "Run /model to switch to the new provider’s models";
    };
    readonly 'provider-q-switch': {
        readonly zh: "立即切换到新 provider？";
        readonly en: "Switch to the new provider now?";
    };
    readonly 'provider-opt-switch-now': {
        readonly zh: "切换到 {{model}}";
        readonly en: "Switch to {{model}}";
    };
    readonly 'provider-opt-switch-keep': {
        readonly zh: "保持当前模型";
        readonly en: "Keep the current model";
    };
    readonly 'cmd-desc-new': {
        readonly zh: "新开会话";
    };
    readonly 'cmd-desc-clear': {
        readonly zh: "清空当前会话";
    };
    readonly 'cmd-desc-compact': {
        readonly zh: "压缩会话历史";
    };
    readonly 'cmd-desc-resume': {
        readonly zh: "恢复历史会话";
    };
    readonly 'cmd-desc-rename': {
        readonly zh: "重命名当前会话";
    };
    readonly 'cmd-desc-quit': {
        readonly zh: "退出 dsh-tui";
    };
    readonly 'cmd-desc-q': {
        readonly zh: "退出 dsh-tui";
    };
    readonly 'cmd-desc-rewind': {
        readonly zh: "回退会话到历史消息";
    };
    readonly 'cmd-desc-export': {
        readonly zh: "导出会话为 Markdown 文件";
    };
    readonly 'cmd-desc-status': {
        readonly zh: "查看会话状态";
    };
    readonly 'cmd-desc-cost': {
        readonly zh: "查看会话 token 用量";
    };
    readonly 'cmd-desc-config': {
        readonly zh: "查看 dsh-cc 配置来源";
    };
    readonly 'cmd-desc-doctor': {
        readonly zh: "运行环境检查";
    };
    readonly 'cmd-desc-init': {
        readonly zh: "在工作目录创建 AGENTS.md";
    };
    readonly 'cmd-desc-agents': {
        readonly zh: "查看本会话的子代理";
    };
    readonly 'cmd-desc-activity': {
        readonly zh: "切换工作状态指示器预设";
    };
    readonly 'cmd-desc-preset': {
        readonly zh: "切换 Agent 预设（standard/code/minimal/cordis）";
    };
    readonly 'cmd-desc-theme': {
        readonly zh: "切换配色主题（内置或自定义）";
    };
    readonly 'cmd-desc-lang': {
        readonly zh: "切换界面语言（en / zh）";
    };
    readonly 'cmd-desc-model': {
        readonly zh: "查看当前模型";
    };
    readonly 'cmd-desc-thinking': {
        readonly zh: "切换扩展思考显示";
    };
    readonly 'cmd-desc-tokens': {
        readonly zh: "查看会话 token 用量";
    };
    readonly 'cmd-desc-provider': {
        readonly zh: "添加模型提供方（内置目录或自定义 API 端点）";
    };
    readonly 'cmd-desc-login': {
        readonly zh: "查看 API 凭证状态";
    };
    readonly 'cmd-desc-logout': {
        readonly zh: "清除 API 凭证";
    };
    readonly 'cmd-desc-permissions': {
        readonly zh: "查看权限策略状态";
    };
    readonly 'cmd-desc-add-dir': {
        readonly zh: "查看文件系统策略范围";
    };
    readonly 'cmd-desc-hooks': {
        readonly zh: "查看 hooks 状态";
    };
    readonly 'cmd-desc-mcp': {
        readonly zh: "查看 MCP 状态";
    };
    readonly 'cmd-desc-memory': {
        readonly zh: "查看记忆状态";
    };
    readonly 'cmd-desc-update': {
        readonly zh: "更新 dsh-cc-tui 并重启";
    };
    readonly 'cmd-desc-audit': {
        readonly zh: "对当前项目做全面代码审计";
    };
    readonly 'cmd-desc-bug': {
        readonly zh: "记录一份 bug 报告";
    };
    readonly 'cmd-desc-practice': {
        readonly zh: "与 dsh-cc 进行编程练习";
    };
    readonly 'cmd-desc-review': {
        readonly zh: "对当前项目做全面代码评审";
    };
    readonly 'cmd-desc-pr_comments': {
        readonly zh: "审查拉取请求评论";
    };
    readonly 'cmd-desc-release-notes': {
        readonly zh: "生成发布说明";
    };
    readonly 'cmd-desc-vuln-check': {
        readonly zh: "运行安全漏洞检查";
    };
    readonly 'cmd-desc-vim': {
        readonly zh: "切换 vim 模式";
    };
    readonly 'cmd-desc-terminal-setup': {
        readonly zh: "查看终端配置建议";
    };
    readonly 'cmd-desc-connect': {
        readonly zh: "连接远程机器";
    };
    readonly 'cmd-desc-help': {
        readonly zh: "查看快捷键与命令";
    };
    readonly 'cmd-desc-exit': {
        readonly zh: "退出 dsh-tui";
    };
    readonly 'cmd-desc-plan': {
        readonly zh: "切换计划模式（/plan off 退出）";
    };
    readonly 'cmd-desc-goal': {
        readonly zh: "设置或查看会话目标";
    };
    readonly 'cmd-desc-feedback': {
        readonly zh: "提交使用反馈";
    };
    readonly 'lang-current': {
        readonly zh: "当前语言  {{lang}}";
        readonly en: "Current language  {{lang}}";
    };
    readonly 'lang-switch-hint': {
        readonly zh: "切换      /lang en | /lang zh";
        readonly en: "Switch      /lang en | /lang zh";
    };
    readonly 'lang-persist-hint': {
        readonly zh: "持久化    ~/.dsh-cc/lang.json（重启后仍生效；CC_TUI_LANG 优先）";
        readonly en: "Persisted    ~/.dsh-cc/lang.json (survives restart; CC_TUI_LANG wins)";
    };
    readonly 'lang-switched': {
        readonly zh: "语言已切换：{{lang}}（已保存）";
        readonly en: "Language switched: {{lang}} (saved)";
    };
    readonly 'lang-unknown': {
        readonly zh: "未知语言「{{lang}}」· /lang 查看全部（en / zh）";
        readonly en: "Unknown language \"{{lang}}\" · /lang to view all (en / zh)";
    };
    readonly 'lang-switch-failed': {
        readonly zh: "语言「{{lang}}」切换失败（无法写入 ~/.dsh-cc/lang.json）";
        readonly en: "Language \"{{lang}}\" switch failed (cannot write ~/.dsh-cc/lang.json)";
    };
    readonly 'trace-title': {
        readonly zh: "轨迹";
        readonly en: "Trace";
    };
    readonly 'trace-subtitle': {
        readonly zh: "会话事件时间线 · 过滤：{{filter}} · {{count}} 条";
        readonly en: "Session event timeline · filter: {{filter}} · {{count}} entries";
    };
    readonly 'trace-empty': {
        readonly zh: "暂无轨迹事件";
        readonly en: "No trace events yet";
    };
    readonly 'trace-filter-all': {
        readonly zh: "全部";
        readonly en: "all";
    };
    readonly 'trace-filter-tool': {
        readonly zh: "工具";
        readonly en: "tools";
    };
    readonly 'trace-filter-thinking': {
        readonly zh: "思考";
        readonly en: "thinking";
    };
    readonly 'trace-filter-message': {
        readonly zh: "消息";
        readonly en: "messages";
    };
    readonly 'trace-filter-progress': {
        readonly zh: "进度";
        readonly en: "progress";
    };
};
export type I18nKey = keyof typeof dict;
export type I18nParams = Record<string, string | number>;
/** Emitted on every language switch so React screens can re-render. */
type Listener = () => void;
/** Subscribe to language switches (mirrors themePrefs subscription style). */
export declare function subscribeLang(listener: Listener): () => void;
/** The currently active language. */
export declare function getLang(): Lang;
/** Switch the active language and notify subscribers. */
export declare function setLang(lang: Lang): void;
/** Is a string a valid shipped language code? */
export declare function isLang(value: unknown): value is Lang;
/**
 * Translate a dictionary key into the active language, substituting
 * `{{name}}` placeholders with params. Missing keys render the key itself
 * so a typo is visible instead of silently blank.
 * @param key - Dictionary key (see dict).
 * @param params - Placeholder values.
 */
export declare function t(key: I18nKey, params?: I18nParams): string;
/**
 * Translate a runtime-computed key (e.g. `cmd-desc-${name}`), falling back
 * to the given text when the key is missing or has no entry in the active
 * language — unlike {@link t}, which renders the key itself. Used where the
 * fallback holds the authoritative text (command descriptions: the en copy
 * lives in `LOCAL_COMMANDS` / the DSH registry, the dict carries zh only).
 * @param key - Dictionary key, computed at runtime so it is not type-checked.
 * @param fallback - Text used when no translation exists.
 */
export declare function tOr(key: string, fallback: string): string;
/**
 * Parse a persisted `{ lang }` value; anything else yields undefined.
 * @param text - Raw file contents.
 */
export declare function parseLangPref(text: string): Lang | undefined;
/** The persisted `/lang` choice, or undefined when unset or invalid. */
export declare function readLangPref(dir?: string): Lang | undefined;
/** Persist the chosen language (best effort). */
export declare function writeLangPref(lang: Lang, dir?: string): boolean;
/**
 * Guess the user's language from the OS locale (`LC_ALL`, `LC_MESSAGES`,
 * `LANG`), defaulting to `zh`. Only consulted when nothing else (env var,
 * cordis.yml `lang`, persisted `/lang` choice) pinned a language.
 */
export declare function detectLocaleLang(): Lang;
/**
 * Resolve the startup language: the persisted `/lang` choice, else the OS
 * locale guess, else `zh` (the original hard-coded language). The env var /
 * config precedence lives in plugin.apply (see {@link resolveStartupLang}
 * consumers).
 */
export declare function resolveStartupLang(): Lang;
export {};
//# sourceMappingURL=i18n.d.ts.map