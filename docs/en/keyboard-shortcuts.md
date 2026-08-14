<p align="center">
  <a href="../zh/keyboard-shortcuts.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send (`Shift+Enter` inserts a newline); execute the selected item when the command menu is open |
| `Ctrl+C` | Interrupt the current turn; press twice while idle to exit |
| `Esc` | Close command/file menus; double-tap while idle to clear input; **double-tap with empty input to rewind** |
| `Ctrl+O` | Expand/collapse details, including full thoughts, tool arguments, and output |
| `Ctrl+R` | Search message history |
| `/` | Full-text search within the session (`n`/`N` to navigate) |
| `Tab` | Complete commands or `@` file paths |
| `Ctrl+V` | Paste text at the cursor; **files/images copied in Explorer insert their file paths** |
| `?` | Open the shortcut menu |
| `Shift+Up` | Enter message-selection mode (Enter expands one message) |

**Mouse (`fullscreen: true` alternate-screen mode; disabled by default and enabled through a profile-patch override)**

| Action | Result |
|---|---|
| Drag to select | Select text inside the app and **copy immediately on release** using OSC 52 with native `wl-copy`/`xclip`/`xsel` fallbacks; tmux uses `load-buffer -w`. The selection clears and a `Copied N characters` notice appears. |
| Double/triple click | Select a word/line and copy it immediately |
| Wheel | Scroll the message list |
| `Esc` | Cancel an in-progress drag without copying |

> Fullscreen mode renders on the alternate screen, returning to the main screen when the TUI exits.
> Set `fullscreen: false` to use inline mode and return mouse selection to the terminal emulator;
> copy-on-select then depends on terminal settings such as kitty's `copy_on_select yes`.
> Set `CC_TUI_DISABLE_MOUSE=1` to temporarily disable mouse click handling in fullscreen mode.

**Questionnaire (when the model invokes `ask_user_question`)**

| Key | Action |
|---|---|
| `Up/Down` | Select an option |
| `Space` | Toggle an item in a multi-select question |
| `Tab` | Switch to a custom response and type without selecting an option |
| `Enter` | Submit the current selection |
| `Esc` | Abort the question; the model receives `ASK_ABORTED` and can continue |

**Local commands (the complete CC command set, all routed through official DSH mechanisms)**

| Group | Commands |
|---|---|
| Sessions | `/new` new session · `/resume` restore · `/clear` clear screen · `/compact` compact · `/export` export Markdown |
| Status | `/status` session info · `/cost` token usage · `/doctor` environment diagnostics · `/config` configuration sources · `/init` create AGENTS.md |
| Model | `/model` picker · `/thinking` thought display · `/tokens` token details · `/theme` theme picker |
| Account/policy | `/login` credential status · `/logout` logout help · `/permissions` permission info · `/add-dir` file-policy scope · `/hooks` · `/mcp` · `/memory` |
| Skills | `/audit` code audit · `/bug` bug report · `/review` code review · `/practice` coding practice · `/pr_comments` PR comments · `/release-notes` release notes · `/vuln-check` vulnerability check |
| Other | `/agents` subagent list · `/vim` · `/terminal-setup` · `/connect` · `/help` · `/exit` |
| Registry | `/plan` `/goal` (DSH command-registry plugins, automatically included in the `/` menu) |

> The `/` menu is the union of local and registry commands; registry descriptions come from each
> plugin. `/plan [off|message]` toggles plan mode, while
> `/goal [create/edit/pause/resume/clear target]` manages persistent goals.
> Skill commands use the DSH skill system. The `skills/` directory ships in the npm package and is
> registered automatically at plugin startup, with **no manual copying required**. You can override
> a skill by placing its SKILL.md in a discovery directory (`~/.dsh/skills`, `~/.agents/skills`, or
> the project's `.dsh/skills`). A command sends the activation prompt to the model, which loads the
> skill through the skill-directory/loading tools. The npm version of install.sh no longer installs
> skills separately.
