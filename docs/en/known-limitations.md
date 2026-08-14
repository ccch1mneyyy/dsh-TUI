<p align="center">
  <a href="../zh/known-limitations.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Known Limitations

- Injected context from plugin source content is not displayed separately; it is included in the
  system-prompt segment of the context meter.
- `/model` switches through a session fork because DSH has no in-place model-switch API. History is
  preserved unchanged in the new session, which routes to the new model; the old session remains in
  the `/resume` list. The choice is written to `~/.dsh-cc/model.json` and is honored after restarts
  and by `/new` (rewinds keep the current model too).
- Ctrl+V clipboard access depends on PowerShell `Get-Clipboard`. If another process such as Explorer
  briefly locks the clipboard, the TUI retries automatically; a persistent lock fails silently and
  shows `Clipboard is empty`.
- Exit terminates the process without waiting for the agent's asynchronous flush; the persistence
  plugin provides the fallback.
- DSH `/permission` sandbox switching is not adapted. It requires an approval service and approval
  UI, and this TUI deliberately does not mount a flow it cannot consume. `/permissions` only explains
  the current behavior.
- `/vim`, `/connect`, `/hooks`, and `/memory` are Claude Code-compatible placeholders. DSH has no
  equivalent mechanism or the corresponding leaf is not mounted, so each command provides an
  explicit explanation instead of failing silently.
