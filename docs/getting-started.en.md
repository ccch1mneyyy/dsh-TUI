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
- `DEEPSEEK_API_KEY`. Set `DEEPSEEK_BASE_URL` as well when using a compatible
  custom endpoint.

macOS/Linux:

```sh
export DEEPSEEK_API_KEY='your-key'
```

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'your-key'
```

Never commit a real credential. A normal profile launch reads the environment
variable directly.

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
| `dsh-tui update` | Update the profile to the latest release and align the launcher (same install logic as the in-TUI `/update`, without restarting into the TUI) |
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
  - Retry normal startup.
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

## Running in VS Code / Herdr

- **VS Code**: run directly in the integrated terminal, or use the
  `dsh-tui-vscode` companion extension on the Marketplace (real terminal
  sessions, session history, specific-session resume, IDE selection channel).
  See [VS Code guide](vscode.en.md).
- **Herdr**: run `dsh-tui` directly in a [Herdr](https://herdr.dev) pane with
  no extra setup; dsh-TUI reports `idle` / `working` / `blocked` through
  Herdr's local integration API (questionnaires and tool approvals count as
  `blocked`), and stays completely inactive outside Herdr.

## Update to the latest version

The project moves fast. Updating reuses the install command with an explicit
`@latest`:

```sh
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
```

- Without `@latest`, pnpm resolves within the version range already recorded
  in the profile's `package.json` (for example `^0.1.4`), so it may stay on an
  old line. That is the usual reason "re-running the install command" appears
  to change nothing.
- To confirm: the startup banner shows the running version
  (`✦ dsh-TUI vX.Y.Z`).
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
`@img/sharp-*` natives:

- sharp ships as all-platform optional dependencies, and an untouched
  `pnpm update` downloads every platform's binaries (about 200MB measured).
- The list is recomputed for the running platform on every update. Foreign
  natives are skipped while this platform's own and the platform-agnostic wasm
  fallbacks stay.
- Move the profile to another platform or musl container and the next update
  there refreshes it.
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

The repository has three submodules, and two of them are required to install:

- `vendor/dsh-std`: its `packages/*` are listed as workspace packages in
  `pnpm-workspace.yaml`.
- `dsh-auth`: pulled in through `link:`.

Without `--recurse-submodules` those directories stay empty and
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

Confirm that `DEEPSEEK_API_KEY` is set in the same shell that starts `dsh`.
Check `DEEPSEEK_BASE_URL` too when using a custom endpoint.

### The activity row appears twice

Check whether `dsh-working-activity` was added separately to the profile. Keep
the row inserted by the dsh-tui patch and remove the duplicate bundle entry.

### The TUI is misaligned or leaves terminal state behind

Run `/doctor`, record the terminal and mode, then consult
[Interaction and commands](interaction.en.md) and
[Architecture and limitations](architecture.en.md). `DSH_TUI_RENDER_LOG` can
capture raw frames for rendering bugs, but those frames may contain visible
conversation content and should be handled as sensitive data.
