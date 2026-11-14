# Getting Started

[Documentation index](README.md) · [简体中文](getting-started.md)

## Prerequisites

- Node.js `^22.19 || >=24`; CI uses Node 24.
- The official DeepSeek Harness CLI: `@deepseek-ai/dsh`.
- `pnpm` **10 or newer** (CI uses 11). `dsh plugin` delegates profile
  installation to pnpm; pnpm 9 hoists transitive dependencies differently,
  leaving `dsh-working-activity` unresolvable inside the profile — the TUI
  then exits right after startup with almost no error output (issue #60, see
  Troubleshooting below).
- An interactive terminal TTY. `dsh-tui` cannot start with stdout redirected.
- The `deepseek-official` route needs `DEEPSEEK_API_KEY`; on DSH 0.2.0-rc.1+
  the standard profile can instead sign in to the separate DeepSeek account
  route with `/auth login deepseek-account`. Other supported accounts use
  `/provider` or `/auth`. Set `DEEPSEEK_BASE_URL` for a compatible custom endpoint.

macOS/Linux:

```sh
export DEEPSEEK_API_KEY='your-key'
```

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'your-key'
```

Never commit a real credential. You can also set nothing at all: the **first step of the
first-run guide** signs in to a subscription (OAuth, including DeepSeek account browser
authorization) or adds a model provider with an API key, writes it into the DSH credential
store (`$DSH_HOME/.credentials.yaml`, by default `~/.dsh/.credentials.yaml`) and picks one of
the models it brought in as the default — the environment variable is only the "you can also
do this" path. A normal profile launch reads the environment variable directly when it is set.

## Install

```sh
# Install the official CLI
npm install -g @deepseek-ai/dsh

# Install pnpm if needed (or use: corepack enable pnpm)
npm install -g pnpm

# Add the scoped package to the dsh-tui profile
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
```

From a checkout, the repository helper wraps the profile command:

```sh
sh install.sh
```

`install.sh` checks for `dsh` and `pnpm` and then runs the profile plugin
command. It does not copy source files and does not require a local build.

## Migrate from the former package

Earlier releases used the unscoped `dsh-cc-tui` package and a `cc-tui` profile:

- `CC_TUI_*`/`DSH_CC_*` environment variables.
- a `~/.dsh-cc` data directory.

The current identity is `@deepseek-harness-tui/dsh-tui` in a `dsh-tui` profile,
using only `DSH_TUI_*` variables and `~/.dsh-tui`. Create the new profile with:

```sh
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
dsh --profile dsh-tui
```

The current release no longer reads the old names and does not migrate data
automatically. After first launch, copy themes, configuration and history
files from the old data directory (`~/.dsh-cc`) into `~/.dsh-tui` yourself.

Once the new profile works:

- `$DSH_HOME/profiles/cc-tui` and the old data directory are just
  former-installation leftovers and may be removed when convenient.
- Do not add both packages to the same profile.

## What installation does

On the first `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`, the official CLI:

1. Initializes `$DSH_HOME/profiles/dsh-tui/`. When `DSH_HOME` is unset, the
   default root is normally `~/.dsh`.
2. Uses `@deepseek-ai/dsh-base` as the first profile bundle.
3. Installs `@deepseek-harness-tui/dsh-tui` inside the profile with pnpm.
4. Reads the package's `dsh.bundle.patch` metadata and adds its
   `cordis.patch.yml` as a composition layer.

The important startup order is:

```text
dsh-base -> other bundles -> @deepseek-harness-tui/dsh-tui patch -> user profile patch
```

- The base supplies agent, model, session, filesystem, shell, policy, and
  registry services.
- The plugin patch overrides or inserts the TUI, agent-preset roster, SQLite
  session persistence, and live activity row.

`dsh-working-activity` is already a dependency of this package and is inserted
by the `dsh-tui` patch. Do not separately add `dsh-working-activity` to the
same profile or duplicate rows may be mounted.

## Start the TUI

```sh
dsh --profile dsh-tui
```

The process starts in the current directory, which is also the Agent's default
workspace. Change into the target project before starting it.

On DSH 0.2.1 and later the Agent can move its session to another directory
(the `working_directory` tool, or a Git worktree). The status line, Git branch,
`@` completion and `!` commands follow that directory, including after
`/resume`. The session stays registered under the project it started in.

On Windows, the checkout also provides:

```bat
dsh-tui.cmd
dsh-tui.cmd --resume
```

- `--resume` reads `%USERPROFILE%\.dsh-tui\resume.txt` and restores the
  session last selected by the TUI.
- Set `DSH_TUI_WORKSPACE` to override the working directory used by the batch
  launcher.

## CLI subcommands

`dsh-tui help` (or `dst help`) prints the full usage; the `dst` alias accepts
the same commands:

| Command | Purpose |
| --- | --- |
| `dsh-tui update` | Align the whole set (profile TUI, global dsh engine, global launcher) and verify it, without entering or restarting the TUI; same decision as the in-TUI `/update` |
| `dsh-tui doctor` | Environment checks: dsh/pnpm, profile install and version alignment, whether the API key is set (state only, never the value), config file presence; complements the in-TUI `/doctor` session diagnostics |
| `dsh-tui safe` | Safe mode: read-only diagnostics, inventory, repair guidance (`safe --rescue` also creates/verifies the clean rescue profile) |
| `dsh-tui version` | Show the launcher and profile versions (`--version`/`-v` are equivalent) |
| `dsh-tui help` | Show usage (`--help`/`-h` are equivalent) |

`help`/`version` work even when dsh is missing or the profile is not
initialized; every other argument is forwarded verbatim to
`dsh --profile dsh-tui`.

## Safe mode (`dsh-tui safe`)

When dsh exits unexpectedly, safe mode provides read-only environment
diagnostics, a profile plugin inventory, and repair guidance.

- **Two entries**: run `dsh-tui safe` manually; or accept the prompt after
  dsh exits with a non-zero code.
  - The prompt only appears in interactive terminals; scripts and pipes get
    a single hint line and keep the exit code.
  - It covers only a non-zero exit of the final dsh child process, not a
    startup hang (a spawn failure counts as exit code 1).
- **Read-only**: diagnostics, inventory, and guidance never change state. Two
  exceptions:
  - Retry normal startup; when `~/.dsh-tui/resume.txt` holds a pointer it is
    passed along (`DSH_TUI_RESUME_SESSION`), so a retry after a crash returns
    to the session you were in instead of a blank one.
  - Create/reuse the rescue profile, writing only to
    `$DSH_HOME/profiles/dsh-tui-safe/`.
  Note: every dsh launch writes `$DSH_HOME/profiles/node_modules` fallback
  links and the pnpm global store (not introduced by safe mode).
- **The rescue profile must be clean, or it refuses to start**. Each check
  blocks startup if it fails:
  - The candidate directory exists but is not a recognizable profile.
  - The existing profile's root manifest declares third-party plugins.
  - `$DSH_HOME/cordis.patch.yml` (home layer): **rejects if it exists**.
  - `dsh-tui-safe/cordis.patch.yml` (profile layer): **rejects only if it has
    entries**; the default "comments + `[]`" does not count as entries.
  Before deleting or rebuilding a rescue profile, it checks the top-level
  entries by **name and shape**; any other name or shape makes it refuse and
  list them — never silently deleting your files.
- **Non-interactive**: `dsh-tui safe --rescue` runs the same gate plus
  create/reuse and only reports the verdict (exit 0 when ready, 1 when
  refused).
- **Outdated launcher**: upgrade first when the profile copy is unreadable or
  too old:
  `npm install -g --legacy-peer-deps @deepseek-harness-tui/dsh-tui@<version>`.
- **Run repair commands yourself** (safe mode only lists them):
  - `dsh plugin --profile dsh-tui remove <third-party plugin>` removes
    suspects one by one;
  - `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<version>`
    reinstalls/aligns;
  - `dsh-tui doctor` runs environment diagnostics.

## Running in VS Code / Herdr / any terminal

- **VS Code**: run directly in the integrated terminal, or use the
  `dsh-tui-vscode` companion extension on the Marketplace (real terminal
  sessions, session history, specific-session resume, IDE selection channel).
  See [VS Code guide](vscode.en.md).
- **Herdr**: run `dsh-tui` directly in a [Herdr](https://herdr.dev) pane with
  no extra setup; dsh-TUI reports `idle` / `working` / `blocked` through
  Herdr's local integration API (questionnaires and tool approvals count as
  `blocked`), and stays completely inactive outside Herdr.
  Extended keys are negotiated inside the pane on macOS; the outer terminal
  and Herdr keybindings must still pass Cmd chords through.
- **Any terminal**: dsh-TUI reports `idle` / `working` / `blocked` / `done` /
  `error` over the pty using
  [OSC 7501 (Program Status Protocol)](https://www.superlogical.com/rex/docs/build/program-status),
  so a terminal or agentic inbox that implements it can show what the session
  is doing and when it needs you. Terminals that do not implement it ignore the
  sequence, so there is nothing to configure; set `DSH_TUI_PROGRAM_STATUS=0` to
  turn the reports off.

## Update to the latest version

The project moves fast. One `/update` (or `dsh-tui update`) aligns **one
mutually compatible set** across three layers and verifies it; the in-TUI
`/update` then restarts and resumes the session, while `dsh-tui update` only
aligns — it neither enters nor restarts the TUI:

1. **The TUI inside the profile**: `dsh plugin --profile dsh-tui update @deepseek-harness-tui/dsh-tui@<version>`.
2. **The global `dsh` engine**: the highest version published on the registry
   inside the target TUI's `dsh-app-boot` peer range, installed into the **same
   global prefix** with the detected package manager (npm `--prefix` /
   `pnpm add -g`). pnpm is auto-updated only when its owning install group is
   proven to contain `dsh` alone: a one-package `pnpm add -g` replaces the whole
   group and removes its other commands, so multi-member groups, shared-store
   installs and unprovable homes are left untouched with `pnpm list -g --depth 0`
   inspection guidance.
3. **The global `dsh-tui` launcher**: file-by-file atomic replacement for npm
   layouts (`bin/dsh-tui.js` and `package.json` are separate renames, so a
   failure between them leaves only the first replaced); `pnpm add -g` for pnpm
   layouts only when the group is proven to contain just the launcher, with
   multi-member or unprovable groups left untouched (details below).

The order is fixed — TUI → engine → launcher. A failed TUI install leaves the
engine untouched, so the old pair normally still boots; a timeout or
cancellation can leave a half-installed profile, though (see "Bounded update
installation" below), and the failure notice prints the recovery command. A
failed engine install keeps the update restartable while the current pair is
still inside the new TUI's range, and prints the engine repair command. When the
engine step cannot be automated at all (unproven pnpm group, unwritable prefix,
unrecognised layout, unreachable registry), the update still continues while
the current engine is inside the range, but the reason (with a manual command
when one is available) is reported and `dsh-tui update` exits non-zero instead
of claiming a whole-set success. **Launcher alignment is normally best effort,
but a failure after the engine advances blocks the restart** and prints the
manual repair command: an old launcher in the same npm prefix may keep the new
engine from loading the updated profile. When the engine did not advance, a
launcher failure remains a warning and does not block the restart.
**Never downgrade**: an engine or launcher ahead of the target is left alone and
reported as drift at boot and by `/update`.
There are two refusals. When the preflight sees "the TUI must move, but the
current engine is outside the new TUI's peer range", nothing is torn down and
nothing restarts: the official plugin manager validates the new TUI against the
dsh that is RUNNING, and the engine step runs after the TUI. A **below-range**
engine that can be upgraded automatically must be aligned first and `/update`
rerun (the refusal prints that command); an engine **above** the range (newer
than this TUI validates) is never downgraded and never paired with an
unvalidated TUI — the refusal only asks to wait for a dsh-tui release that
declares it, with no install command. When the preflight passes but the engine
step fails only after the TUI moved (the version did not advance, or the old
engine is no longer loadable), the new TUI is kept and only the restart is
refused. "The old engine is still loadable"
needs positive proof — its `bin.dsh` entry starts in a fresh process and
`--version` exits 0, or `dsh --version` runs — an existing entry file or a
readable manifest is not enough. On POSIX, if pnpm keeps the old store tree
behind a shared runtime fallback link, that link is atomically refreshed only
when the new entry belongs to the same pnpm home, matches the target version
and passes the startup probe; both the profile link and PATH are then verified.
The profile's own dependencies, real directories and links to other installs
are left untouched. Windows does not attempt a non-atomic junction replacement:
the old link and unverified result remain, requiring manual inspection and
recreation of the shared fallback link. A preflight refusal writes the current
version, target range and next step (with the manual command when one can run)
into the transcript; when the engine step fails only after the TUI was torn
down, the same details go to the terminal's stderr (`dsh-tui update` writes
stderr too). The toast stays a short pointer. A preflight refusal also names its
next step: an engine below the required range but installable is upgraded first
(and `/update` rerun afterwards), an engine above the range waits for a TUI
release that declares it (no downgrade/install), an unreachable registry is a
retry (not a compatibility verdict), a
dsh release missing from the declared range is a wait (no impossible install
command is printed), `DSH_TUI_UPDATE_ENGINE=0` is a switch to drop, and an
unrecognised/unwritable/ambiguous global install is a repair. When the TUI is
already current and the registry has a newer dsh outside that TUI's declared
peer range, `/update` says it is waiting for a dsh-tui release instead of
silently stopping at the validated line or installing an unvalidated engine.
After pnpm rotates a global install group, a direct DSH launch re-resolves and
probes its actual JS entry while preserving host options such as `--profile`
and `--patch`. An unproven entry refuses the restart and prints the repair
command instead of executing a deleted path in the old group.

Manual fallbacks (the refusal names the matching layout command when one can
run; an above-range engine only asks you to wait for a TUI release and never to
downgrade; for an unpublished release it only asks you to wait):

```sh
# TUI only
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
# engine
npm install -g @deepseek-ai/dsh@0.2.2-rc.2
# or, for a pnpm global layout (first confirm the global group holds dsh
# alone; a one-package install replaces the whole group and its other commands):
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.2
# global launcher
npm install -g --legacy-peer-deps @deepseek-harness-tui/dsh-tui@latest
# or, only after confirming the pnpm global group contains this package alone:
pnpm add -g --config.auto-install-peers=false @deepseek-harness-tui/dsh-tui@latest
```

When you launch through the global `dsh-tui` command, the launcher is aligned
automatically after a successful `/update`, and only against a global install it
can prove: an npm global install is replaced file by file, each write atomic on
its own (`bin/dsh-tui.js` and `package.json` are separate renames, so a failure
between them leaves only the first replaced; the launcher step reports that
failure and blocks the restart if the engine advanced; otherwise it remains
restartable), and it needs a matching global bin link or shim — project-local
npm/npx installs are never overwritten. A pnpm global
install goes through `pnpm add -g` only when its group is proven to contain just
the launcher, never through the store's symlinks. pnpm 11+ isolates packages
installed together into a group; recreating a multi-member group can lose other
tools' required peers even when their direct versions stay unchanged, so such
groups, and groups that cannot be proven, are left untouched with guidance to
inspect and preserve their dependencies rather than reinstalled automatically.
An undetermined install shape is also left untouched, leaving only the boot-time
notice. For older launchers carrying only a version marker, `dsh-tui` and `dst`
must not resolve to different installations on PATH. A pnpm logical group or
owning shim takes precedence over an inherited `PNPM_HOME`; the location of a
shared store is not ownership evidence. A failed alignment step prints a manual
install command only when that command is known to be safe.

Escape hatches: `DSH_TUI_UPDATE_ENGINE=0` skips the automatic engine install
(with a pinned engine, a TUI upgrade that no longer supports it is still
refused); `DSH_TUI_UPDATE_LAUNCHER=0` skips launcher alignment;
`DSH_TUI_DSH_PM=npm|pnpm` overrides package-manager detection (for diagnosing
an abnormal prefix).

- Without `@latest`, pnpm resolves within the version range already recorded
  in the profile's `package.json` (for example `^0.1.4`), so it may stay on an
  old line. That is the usual reason "re-running the install command" appears
  to change nothing.
- To repair a version mismatch, prefer the **exact-version** command from the
  refusal/failure notice (for example
  `npm install -g @deepseek-harness-tui/dsh-tui@0.8.3`); use `@latest` only for
  routine upgrades — it may be newer than the profile and stay misaligned.
- pnpm 11+ global installs are grouped: a one-package `pnpm add -g` replaces the
  whole group and removes its other tools. `/update` never recreates multi-member
  groups; even re-adding every direct version can lose their auto-installed peers.
  Run `pnpm list -g --depth 0` to inspect the group, and preserve every member and
  its installed peers before a manual repair. Use a separate global prefix when
  reinstalling the launcher alone. Do not apply the single-package command above
  to a multi-member group or use `pnpm update -g --latest` (it upgrades every
  member to latest).
- A pnpm global alignment has two preconditions. It works without an exported
  `PNPM_HOME` — the home is derived from the shim's own directory (`<PNPM_HOME>`
  or `<PNPM_HOME>/bin`) and only accepted when that group provably owns this
  package. And the launcher-only group install resolves **no peers**: every
  `@deepseek-ai/*` package is provided by the profile at runtime, while pnpm's
  peer auto-install follows their peer ranges onto an **unpublished stable
  line** and fails with `ERR_PNPM_NO_MATCHING_VERSION`, so both the alignment
  and the manual command above pass `--config.auto-install-peers=false` — the
  same intent as npm's `--legacy-peer-deps`.
- pnpm ≥11 refuses versions published within 24 hours (`minimumReleaseAge`).
  `/update` and `dsh-tui update` waive that window for the engine and launcher
  steps (`PNPM_CONFIG_MINIMUM_RELEASE_AGE=0`); add the same prefix when running
  the `pnpm add -g` lines above by hand, or a just-published version will not
  install.
- To confirm: the startup banner shows the running version
  (`✦ dsh-TUI vX.Y.Z`), and the post-restart `DSH_TUI_UPDATED_FROM` /
  `DSH_TUI_UPDATED_DSH_FROM` checks verify each layer actually advanced.
- Your `cordis.patch.yml` override layer survives updates untouched.
- Session storage may move between versions (since 0.3.7, `/resume` uses the
  JSONL session store shared with dsh web), so older sessions missing from the
  list after a major update is expected — the underlying data is not deleted.

### pnpm install-script blocks and foreign-platform natives

If `dsh plugin` fails with `ERR_PNPM_IGNORED_BUILDS` (pnpm ≥11 blocks
dependencies that carry install scripts by default, e.g. `@google/genai` and
`protobufjs` — none of these scripts is needed at runtime, so they can safely
be ignored), add to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

`/update` and `dsh-tui update` seed this configuration automatically — no
manual step needed.

Updates also maintain `ignoredOptionalDependencies` covering foreign-platform
natives — `@img/sharp-*` and the Claude SDK's
`@anthropic-ai/claude-agent-sdk-*` bundles:

- Both ship as all-platform optional dependencies, and an untouched pnpm update
  resolves and downloads every platform's binaries (about 200MB measured for
  sharp; each SDK bundle unpacks to about 230MB, and one 0.15 → 0.16 update
  pulled seven foreign bundles, roughly 1.6GB).
- The list is recomputed for the running platform on every update. This
  platform's own natives and the platform-agnostic wasm fallbacks stay; foreign
  ones are skipped at resolution, so they no longer appear in the lockfile
  either.
- The SDK is never installed by an update: it only enters a profile when you
  pick that backend in the kernel picker, and the installer recomputes the list
  for the current machine first, so exactly one platform's bundle lands. An
  unused backend keeps taking no space.
- Move the profile to another platform or musl container and the next update or
  kernel install there refreshes it.
- An existing profile's lockfile still lists every platform, so its first
  update downloads them once more before the filter takes effect.
- Entries outside those two platform tables (a user's `fsevents`, a
  hand-written `@img/sharp-wasm32` exemption) are left as they are. This needs
  a pnpm that supports the key; one that does not fails nothing — it merely
  loses the saving.

## Profile configuration

The user override file is:

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

When overriding a row, its `config` block is replaced as a whole rather than
deep-merged. Repeat every key you want to keep. See
[Configuration](configuration.en.md) for examples.

The root `cordis.yml` is a bare-composition example. A normal npm/profile
installation uses `cordis.patch.yml`; do not copy the root configuration into
the profile.

## Develop from source

```sh
git clone --recurse-submodules https://github.com/ccch1mneyyy/dsh-TUI.git
cd dsh-TUI
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

The repository has a single submodule, and it is required to install:

- `vendor/dsh-std`: its `packages/*` are listed as workspace packages in
  `pnpm-workspace.yaml`.

The TUI Profile (plugin admission and private protocol definitions) lives in
`tui-profile/` as **plain files** (no longer a submodule); it is checked out and
revised together with this repository and is what the contract checks read.

Without `--recurse-submodules` that directory stays empty and
`pnpm install --frozen-lockfile` fails outright. For a checkout that was
already cloned:

```sh
git submodule update --init --recursive
```

`pnpm build` cleans the ignored `lib/` directory, compiles `src/` into
`lib/types/`, and runs the build gates.

- **Git URL installs are not supported** (workspace deps / submodule / pnpm
  ≥11 prepare allowlist).
- The publish workflow performs an explicit clean compilation and
  package-surface check before packing.

For an integration test of the current source, run this once after initial
setup or whenever the normal model/key configuration changes:

```sh
pnpm dev:copy-config
```

After each source change, build, pack, install in isolation, and launch with:

```sh
pnpm dev
```

`pnpm dev` keeps the full install/build/pack checks by default. For explicit local
iteration, set `DSH_TUI_DEV_FAST=1` (for example,
`DSH_TUI_DEV_FAST=1 pnpm dev -- --no-launch`). A miss runs frozen install,
`compile`, pack without repeating `prepare`, and isolated profile installation.
An unchanged hit skips all four stages only while source/config and compiler-loader contents,
Node/pnpm/npm/dsh versions, compiled and vendor output, the tarball, and the installed
package/profile match. Replacing pnpm/npm/dsh without changing its reported version
requires one normal (non-fast) development run.
Internal document links such as `CLAUDE.md -> AGENTS.md` are fingerprinted;
external, excluded, dangling or cyclic links and unreadable inputs disable reuse
with a diagnostic. Failures invalidate the success stamp before work begins.
The script prints stage durations and cache hits. Run normal `pnpm build` and
focused regressions before publishing; fast mode does not change release gates.

`pnpm dev:copy-config` copies only `~/.dsh/settings.yaml` and
`~/.dsh/.credentials.yaml`. Files are set to mode `0600` on Unix; Windows uses
the OS-managed file ACL.

`pnpm dev` uses isolated `HOME`, `DSH_HOME`, and session directories, leaving
the normal `~/.dsh/profiles/dsh-tui`, `~/.dsh-tui`, and sessions untouched. The
test root defaults to:

- `$XDG_CACHE_HOME/dsh-tui-dev` on Unix (`~/.cache/dsh-tui-dev` when unset).
- `%LOCALAPPDATA%\dsh-tui-dev` on Windows.
- Override it with `DSH_TUI_DEV_ROOT`.

To verify only the build, pack, and install path without launching the TUI,
run:

```sh
pnpm dev:test
```

CI also runs three rendering regressions:

```sh
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

The `pnpm tui` script invokes `scripts/run.ts`, which directly composes
DeepSeek Harness source patches and assumes a Harness monorepo `packages/*`
layout by default. A standalone checkout must set `DSH_TUI_DEV_WORKSPACE` to
the Harness root. To test only this repository's current source, prefer
`pnpm dev`; it uses the same profile installation path as an end-user install.

## Troubleshooting

### `dsh-tui requires an interactive terminal`

stdout is not a TTY. Start the process directly in a terminal rather than
redirecting its main output to another command or file.

dsh-tui detects two things: stdout is not a TTY, and the process was not
started by the `dsh-tui` launcher. When both hold, it silently skips the TUI
frontend (no error, the host keeps booting). That is the case when dsh-tui is
only installed in a profile and a non-terminal host (Web / Tauri / GUI, stdout
piped or null) starts the DSH composition.

The error above only appears when `dsh-tui` (or the standalone portable build)
was explicitly launched without a TTY.

### `dsh` or `pnpm` cannot be found

Make sure the global npm bin directory is on `PATH`, then open a new terminal.
`install.sh` checks both commands before installation.

### The TUI exits right back to the shell with almost no error (pnpm 9)

In a profile installed by pnpm 9, the transitive dependency
`dsh-working-activity` is not hoisted where the loader can resolve it; the
failed module resolution tears down the whole plugin tree, and the TUI prints
the resume hint and exits (issue #60). Upgrade pnpm to 10+ and reinstall:

```sh
npm install -g pnpm@latest
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
```

### The model reports missing credentials

For `deepseek-official`, confirm that `DEEPSEEK_API_KEY` is set in the same shell
that starts `dsh`. Check `DEEPSEEK_BASE_URL` too for a custom endpoint. For
`deepseek-account` or a subscription model, inspect `/auth status` and sign in again with
`/auth login <provider>` if needed.

### The browser connects but dsh-tui cannot reach a self-hosted HTTPS endpoint (self-signed cert / private CA)

Self-hosted LLM token servers on a private network are often fronted with HTTPS certificates issued by Caddy, mkcert, Step CA, or similar, whose root certificate is not in Node.js's built-in Mozilla CA bundle. The browser and system `curl` then work fine, but after switching dsh-tui to that provider the TLS handshake fails with `self-signed certificate in certificate chain` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

The reason is that dsh-tui's HTTP requests run on Node.js's TLS layer, and Node.js trusts only two things: the Mozilla CA bundle compiled into it, plus the PEM file named by the `NODE_EXTRA_CA_CERTS` environment variable (merged with the built-in list). macOS Keychain "trust" settings have no effect on a Node.js process — Node does not call the system Security.framework, so the trust chain the browser and `curl` use is irrelevant here.

Export the root certificate as PEM and set the variable before launching dsh-tui:

```sh
export NODE_EXTRA_CA_CERTS=/path/to/your-ca-root.pem
dsh-tui
```

Note that `NODE_EXTRA_CA_CERTS` is a bootstrap-protected variable for the DSH launcher: no `.env` file may set it (neither the project directory's `.env` nor `~/.dsh/.env`), and putting it there makes startup fail with an error telling you to `export` it instead — it can only come from the shell environment that launches dsh. The same protected group covers other certificate / TLS variables such as `SSL_CERT_FILE`, `SSL_CERT_DIR`, and `NODE_TLS_REJECT_UNAUTHORIZED`.

### The activity row appears twice

Check whether `dsh-working-activity` was added separately to the profile. Keep
the row inserted by the dsh-tui patch and remove the duplicate bundle entry.

### The TUI is misaligned or leaves terminal state behind

Run `/doctor`, record the terminal and mode, then consult
[Interaction and commands](interaction.en.md) and
[Architecture and limitations](architecture.en.md). `DSH_TUI_RENDER_LOG` can
capture raw frames for rendering bugs, but those frames may contain visible
conversation content and should be handled as sensitive data.

### Git fails throughout a session under Orca (`unable to parse command-line config`)

Orca injects git's indexed-config protocol into the agent terminal —
`GIT_CONFIG_COUNT` plus `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` — to turn off
credential-manager popups. The engine strips credential-shaped variables **by
name** (`/KEY|PASSWORD|SECRET|TOKEN/i`) when it spawns children, so every
`GIT_CONFIG_KEY_n` is dropped while `GIT_CONFIG_COUNT` and
`GIT_CONFIG_VALUE_n` survive; git receives a broken triple and every command
fails with `fatal: unable to parse command-line config` (exit 128).

The root cause is the engine package's `scrubbedParentEnv()`, not dsh-tui (issue
#1811). To work around it, drop `GIT_CONFIG_COUNT` before launching dsh-tui —
without it git ignores the orphaned `KEY`/`VALUE` entries:

```sh
env -u GIT_CONFIG_COUNT dsh-tui
```

The trade-off is losing Orca's credential-popup suppression; use
`GIT_TERMINAL_PROMPT=0` when you need non-interactive credentials instead.
