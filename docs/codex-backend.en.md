# Native Codex backend (experimental)

[Documentation index](README.md) · [中文](codex-backend.md) · [Agent backends](agent-backend-design.md)

dsh-TUI can be a frontend for your local Codex: the same interface, with sessions driven by
`codex app-server`, not the DSH Agent or a generic OpenAI API adapter. Codex loads its own
configuration, login, `AGENTS.md`, skills, hooks and MCP servers. Threads are shared with the
official CLI, with no history migration required. `dsh-tui migrate codex` is different: it
imports history into **DSH**, rather than opening a native Codex thread.

> This guide describes the development branch, not a released version. The protocol
> validation baseline is **codex-cli 0.160.1**; the minimum is **0.144.0**. Other versions
> may show a drift warning; the minimum does not guarantee every advanced API. Controls,
> lifecycle and advanced features follow the capabilities actually declared by the backend.
> Protocol/fake-app-server regressions and credential-free offline checks do not prove real
> ChatGPT login, live model turns or real-TTY behavior; those were not run in this round.
> The verified scope is listed at the end, with implementation/live evidence in the
> [progress log](codex-backend-progress.md) (Chinese).

## Install and start

Install dsh-TUI using the [installation guide](getting-started.en.md), then install your own Codex:

```sh
npm install -g @openai/codex@0.160.1
codex --version
dsh-tui --backend codex
```

- dsh-TUI neither bundles the Codex binary nor requires `@openai/codex-sdk`.
- Codex is discovered on `PATH`; set `CODEX_EXECUTABLE` to choose an executable. On Windows,
  npm installations resolve to the real `codex.exe`, not just the launcher wrapper.
- Select Codex through the launchpad kernel entry or `/kernel` to remember the choice. One
  process uses one backend; switching restarts it and is unavailable during a turn. You
  can also set `backend: codex` on the dsh-tui configuration row or use
  `DSH_TUI_BACKEND=codex`. Explicit launch choices take precedence over the remembered one.
- Your `$CODEX_HOME` (default `~/.codex`) and official configuration still apply. dsh-TUI
  **does not write `~/.codex/config.toml`**. Its model, effort and permission choices live
  in `~/.dsh-tui/backends/codex/prefs.json` and apply through per-thread requests.
- Backend identification/title displays Codex. With the brand setting on `auto` (the
  default) the whole look goes lavender: the CODEX title, the "Build anything with Codex"
  tagline and the `codex-lavender`/`codex-paper` theme pair (monochrome base with lavender
  accents, following your terminal's lightness). A manual `/theme` pick or a pinned
  `dsh-tui.brand` value is never overridden; the companion stays on the default whale.

Resume a thread created by the official client or dsh-TUI:

```sh
dsh-tui --backend codex --resume <thread-id>
dsh-tui --backend codex --resume   # last Codex thread used by this dsh-TUI installation
codex resume <thread-id>           # return to the official frontend; release its writer first
```

Failed resume reports an error; it does not silently create a new conversation. Resume
uses the thread’s recorded working directory by default. The official selector may filter
by directory and default provider; select all directories/providers or use the id directly.
Two Codex writers cannot open the same thread concurrently. An “active writer” error means
you should normally exit that thread in the other terminal, not delete locks or kill
someone else’s process.

## Login and credentials

### Selection order

1. **The active `/channel` connection**: use its Responses API endpoint and key; do not
   inject subscription tokens.
2. **dsh-auth `openai-codex` ChatGPT subscription login**: only on a confirmed first-party
   OpenAI route, through the official externally managed `chatgptAuthTokens` mode. Tokens
   passed to Codex stay in memory, not Codex `auth.json`; app-server requests refreshes.
3. **Your native Codex credentials**: Codex reads its own `$CODEX_HOME` credential file or
   keychain, environment variables and provider configuration. dsh-TUI does not copy,
   change or reinterpret them.
4. With no credentials you can still open the UI, but need `/login` before a model call.

Subscription tokens are not sent to relays. Custom `model_provider`, overridden provider
base URLs, a non-official `OPENAI_BASE_URL`, or unreadable configuration prevent injection; the environment
is handed to Codex unchanged. Non-first-party routes should use their own provider
credentials or a channel key. Account status shows only credential source, subscription
type and host, not an email address or key.

### The three `/login` methods

| Method | Purpose and storage |
| --- | --- |
| Built-in ChatGPT OAuth | Uses the standard profile’s dsh-auth login wizard; omitted if that OAuth service is absent. dsh-auth manages credentials; the external token passed to Codex is not written to Codex’s credential file |
| Codex device code | Follow the displayed verification link and one-time code in a browser. Codex manages native login storage; cancel the wait in the UI if needed |
| OpenAI API key | Enter it in a masked field. **It is written to your own Codex credential store**, not kept as a temporary in-memory key. Put relay keys in `/channel` instead of treating them as first-party login |

Success follows the server’s login result, not the immediate `account/login/start` reply.
Failed refresh or managed-token login prompts for `/login` and stops injection. It **does
not call `account/logout` or delete your existing native Codex login**. `/logout` delegates
only to the host OAuth service to remove the matching `openai-codex` dsh-auth credential.
It does not remove channel keys, other providers or native login. The running app-server
may retain an already-loaded managed token: **restart dsh-TUI normally to stop using it**.
Logout does not interrupt, reconnect or modify official configuration. Manage native
login with the official Codex client in your own external terminal.

Using ChatGPT subscription tokens in third-party clients is subject to OpenAI’s terms.
External token management is an official app-server interface, not a project guarantee
that every subscription/workspace allows third-party frontends. Login paths without a real
account check remain unverified; use an API key if concerned. Never post credentials or
account information in issues, logs or documentation.

## Relay channels: `/channel`

Channels support an **OpenAI-compatible Responses API** (`wireApi: responses`), not Chat
Completions endpoints. Use `/channel` to select/create a profile, configure a connection
and exact model-name mappings. Import from the current Codex provider settings is available
when its environment key can be read. Mappings are exact replacements, not Claude model tiers.

- Metadata lives in `~/.dsh-tui/backends/codex/channels.json`; it contains only a `tokenRef`.
  The key is stored in the DSH credential store, not that JSON. Do not put keys in `env` or URLs.
- Base URLs must use HTTPS; HTTP is allowed only for `localhost` and `127.0.0.1`. Usernames/
  passwords, query strings, fragments and credential-looking path segments such as `sk-`,
  `key=` or long random strings are rejected.
- Provider definitions use `codex app-server -c ...` process arguments. Keys only enter the
  child environment. **The endpoint hostname and non-secret provider arguments may be
  visible to other local users in process listings.** Environment variables are not secret
  from administrators either. Use trusted machines and endpoints.
- An incomplete active connection, missing key or unsafe URL refuses startup instead of
  silently falling back to subscription login.
- Do not mix relay and ChatGPT login. `/login` asks you to address an active channel first.
  A connection change follows the UI restart flow, resuming the thread with the new
  provider/credential environment without interrupting an active turn. Mapping-only
  profile switches may avoid restart. Do not change connections during an active turn.

## Models, reasoning effort, Plan and permissions

`/model` lists Codex’s models and channel mappings. `/effort` offers only the current model’s
actual supported levels; not every model has `xhigh`. Model switching handles incompatible
effort levels; default effort is delegated to the model. Idle changes apply immediately;
changes during a turn apply to the next one, not to reasoning already in progress.

**Collaboration mode and permissions are orthogonal.** `/permission` reuses the existing picker:

| Option | Approval and sandbox |
| --- | --- |
| Read Only (`read-only`) | On-request approvals, read-only sandbox |
| Default (`auto`) | On-request approvals, workspace-write sandbox |
| Full Access (`full-access`) | No approval prompts or file sandbox; requires an explicit selection |
| Plan (`plan`) | Planning collaboration mode; keeps the underlying permission preset rather than replacing its sandbox |

- **`Shift+Tab` only toggles Plan**, returning to the previous permission preset when leaving
  it. It does not cycle into Full Access.
- `/plan` enters Plan; `/plan <task>` enters it and submits the task. Choosing an explicit
  permission preset returns to Default collaboration. Plan does not mean all tools are
  forbidden: the actual security boundary remains Codex’s permission policy.
- Defaults resolve per field: an explicit dsh-TUI choice > your Codex configuration >
  `auto` when unset. An unreadable configuration is not overwritten with `auto`.
- Completed plans offer implementation, implementation with cleared context, or staying
  in Plan/continuing with feedback. Clearing context continues in a new thread, preserving
  the original. Plan approval does not silently enable Full Access.
- Command, file, network and permission approvals use server-provided choices. Allow-once,
  session allowance or remembered rules appear only when supported. Questions and MCP forms
  share the existing panel, with secret answers masked.

## Daily commands and input

| Entry | Behavior |
| --- | --- |
| `Enter` / `Tab` / `Ctrl+Enter` while working | Steer / queue a follow-up / interrupt and send now; non-steerable turns fall back to follow-up |
| `Esc` / `Ctrl+C` | Dismiss the focused panel or interrupt. Cancelling a model question also interrupts its turn rather than leaving it hung |
| `/review` | Review uncommitted changes inline; requires idle state and consumes model usage |
| `/review base <branch>` / `/review commit <sha>` | Review against a branch or commit; other arguments are custom review instructions |
| `/diff` | Latest turn’s aggregated diff; otherwise try Git diff against the remote, then show an empty-state notice |
| `/<skill-name> [arguments]` | Invoke a discovered, enabled Codex skill; completion updates as skills change. Local commands take precedence on name collisions |
| `/init` | Submit Codex’s AGENTS.md initialization prompt, not the DSH template generator; a model turn with normal approvals/usage |
| `/mcp` | Codex MCP status and tool counts, with reconnect but no runtime toggle |
| `/usage` | Server-reported quota windows, utilization, reset times and credits; relays may not provide them |
| `/status`, `/context`, `/compact` | Status, raw context readings, Codex compaction; unavailable category details are not invented |
| `/new`, `/clear`, `/export` | New thread, clear the view only, export the current transcript. `/clear` **does not reset context** |
| `!cmd` / `!!cmd` | dsh-TUI’s local shell / include output in a follow-up, not a verbatim copy of the official `!` persistence semantics |

File cards use real hunk line numbers. Running command cards show a bounded live output
tail; use `Ctrl+O` for details. Official `userShell` turns in history appear as terminal cards.

### Reading context and quota

The context bar follows the official 12,000-token baseline (`T` is the most recent
`last.totalTokens`, not cumulative billed tokens; `W` is the model window):

```text
effective = max(0, W - 12000)
used      = max(0, T - 12000)
used share = used / effective       # when effective > 0
remaining share = 1 - used share
```

Display handles unknown/invalid windows; `/context` keeps the raw `T / W` reading. Token
ledger totals, subscription quota and context occupancy are different quantities. Codex
transcripts do not normally retain full billed usage, so resuming history does not invent
past tokens/cost. Fresh usage notifications update the readings.

## Session lifecycle

- `/resume` opens the native-thread browser, grouped by project, with all-project browsing.
  `Enter` resumes, `Ctrl+R` renames and `Ctrl+D` **archives**. Confirmation and completion
  say the transcript is retained, not physically deleted. Current, occupied or active-worker
  threads cannot be archived. The catalog lists up to 500 recent ordinary threads, excluding
  ephemeral forks and child threads from the main list.
- `/rename` changes the official thread title; `/color` stores a session accent, not a global theme.
- `/fork` creates a resumable copy without switching. Double `Esc` or `/rewind` conversation
  rewind creates a copy before the selected question, returns the question to the composer
  and preserves the original. Rewinding the first question creates an empty thread. **File-only
  and conversation+files rewind are unsupported**; the Git working tree does not revert.
- Resume replays the newest 20 full turns before live continuation. Load older messages uses
  prefetched full-item pages, not tool-omitting summaries. Retry when prefetch is still pending;
  repeated failure reports a notice. Active resume deduplicates redelivered approvals and
  never invents usage absent from history.

## Images

Paste images or mention PNG/JPEG/GIF/WebP files with `@`. Limits: **20 MiB per image**,
**2048 pixels per side**, **2048 × 2048 pixels**, **20 images per message**, and **50 MiB
per message**. Staging checks the capability limits; sending rereads and checks the image.
Resize rejected images as prompted rather than assuming an unsent attachment was handled.

Inputs are data URLs persisted with the thread, not disposable clipboard paths. Resume
shows persisted input images; missing historical localImage files show unavailable
placeholders without automatically downloading remote images. Codex imageView and completed
imageGeneration results also display images: `savedPath` takes precedence over embedded data.
Real model vision and image generation were not tested in this round.

## Subagents and background tasks

- `/agents` or `Ctrl+A` opens the subagent panel. Child text, tools and usage stay in its
  card/details, not the parent transcript. Details load paginated history on demand; you can
  interrupt active subagents belonging to the current session.
- Messaging is **parent-mediated**: the parent model relays it through Codex `send_input`,
  not a direct child-inbox operation. A receipt means issued, not necessarily read or
  executed. Cross-parent history/control access is refused.
- `/jobs` shows unified-exec background terminals with the existing stop controls. Inventory
  refreshes at turn boundaries and polls about every **2 seconds** while terminals remain
  live. This is experimental: unsupported methods disable the capability with a notice.
- Output is the **last 64 KiB observed by this session**, not arbitrary historical output
  file access. A resumed terminal may have no observed output. Only a complete inventory
  establishes disappearance. Without a native exit code, completion summaries explicitly say
  **exit unknown**; they do not imply exit 0 or success.
- Interrupting the model turn and stopping a background terminal are separate actions.

## Goals, side queries and hooks

| Entry | Behavior |
| --- | --- |
| `/goal` | Current goal, phase, token/time budget; values come from Codex |
| `/goal <objective>`, `/goal edit <objective>` | Set or replace a native goal |
| `/goal --budget 50k <objective>` | Token budget, also accepting 50000 or 1.5m |
| `/goal pause`, `/goal resume`, `/goal clear` | Pause, resume or clear; no duplicate DSH round loop |
| `/btw <question>`, `/recap` | One model call on an ephemeral fork, without writing the parent thread or persistent session list |
| Hooks | hookPrompt as injected input; start/completion/failure notices, using Codex configuration rather than the DSH `/hooks` manager |

usageLimited/budgetLimited goals show a blocked state and reason. Unsupported goal APIs
do not expose the capability. `/btw`/`/recap` use a read-only sandbox with no approval
escalation, request answer-only behavior and reject tool/approval requests. Cancellation
interrupts the temporary turn and unsubscribes the fork. They consume model quota, not
free local summaries. Ephemeral fork creation/non-persistence was checked offline; actual
side-query model answers were not tested in this round.

## Limitations and troubleshooting

- `/skills` and `/hooks` are DSH management entries, not Codex skill/hook management. Invoke
  Codex skills as `/<skill-name>` from completion; unavailable local commands are not model passthrough.
- DSH presets, providers, workspace home, migration management and `/tree` are not Codex
  capabilities. Unsupported commands are marked unavailable rather than silently executed.
- This scope does not add every official slash alias, voice, apps/plugins management,
  worktree/daemon, pets, memories, remote control or physical deletion. Theme/companion
  choices remain dsh-TUI settings; native compatibility does not replace the palette.
- `/doctor` reports executable/version, drift, Codex home, credential source, provider host,
  sandbox issues and unknown protocol items. If Linux lacks bubblewrap, install it as
  prompted and keep the needed sandbox; do not choose Full Access merely to hide an error.
  Operating-system sandbox behavior belongs to official Codex.
- 401/login failure: check the channel/route, then `/login`. Quota limits: `/usage`. Context
  limits: `/compact`. “Active writer”: exit that session in the other terminal first.
- An app-server exit triggers reconnection notices; failed reconnection leaves a read-only
  session rather than pretending inputs were delivered.
- Bug reports should include versions, platform, minimal steps and redacted diagnostics
  only. Exports and raw ANSI/debug logs may contain text, paths or secrets; do not publish them raw.

## Verification in this round

- The real official 0.160.1 app-server passed nine offline checks under an isolated home: handshake/home isolation, thread creation, model listing, zero-context reading, orthogonal permission/Plan settings, persistent rename, ephemeral fork, full-page resume and archive. There was no model turn or charge and no write to user ~/.codex/config.toml.
- Protocol/mapping, controls, lifecycle and advanced interfaces use fake-app-server and redacted-fixture regressions. Focused tests also drive the real headless browser for archive/default-delete semantics and the production channel for host OAuth-only logout. They prove wiring, state and boundaries, not acceptance of every real account/model request.
- Not run in this round: real ChatGPT OAuth/device-code/API-key login, credentialed model turns, real vision/subagent/background-terminal/goal/side-query turns, or real-TTY inline/fullscreen/narrow-terminal interaction. Missing credentials or an interactive terminal are recorded as unverified, not passed; see the progress log for exact results.
