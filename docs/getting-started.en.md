# Getting Started

[Documentation index](README.md) · [简体中文](getting-started.md)

## Prerequisites

- Node.js `^22.19 || >=24`; CI uses Node 24.
- The official DeepSeek Harness CLI: `@deepseek-ai/dsh`.
- `pnpm`; `dsh plugin` delegates profile installation to pnpm.
- An interactive terminal TTY. `dsh-cc-tui` cannot start with stdout redirected.
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

# Add the plugin to the cc-tui profile
dsh plugin --profile cc-tui add dsh-cc-tui
```

From a checkout, the repository helper wraps the profile command:

```sh
sh install.sh
```

`install.sh` checks for `dsh` and `pnpm` and then runs the profile plugin
command. It does not copy source files and does not require a local build.

## What installation does

On the first `dsh plugin --profile cc-tui add dsh-cc-tui`, the official CLI:

1. Initializes `$DSH_HOME/profiles/cc-tui/`. When `DSH_HOME` is unset, the
   default root is normally `~/.dsh`.
2. Uses `@deepseek-ai/dsh-base` as the first profile bundle.
3. Installs `dsh-cc-tui` inside the profile with pnpm.
4. Reads the package's `dsh.bundle.patch` metadata and adds its
   `cordis.patch.yml` as a composition layer.

The important startup order is:

```text
dsh-base -> other bundles -> dsh-cc-tui patch -> user profile patch
```

The base supplies agent, model, session, filesystem, shell, policy, and
registry services. The plugin patch overrides or inserts the TUI, agent-preset
roster, SQLite session persistence, and live activity row.

`dsh-working-activity` is already a dependency of this package and is inserted
by the `dsh-cc-tui` patch. Do not separately add `dsh-working-activity` to the
same profile or duplicate rows may be mounted.

## Start the TUI

```sh
dsh --profile cc-tui
```

The process starts in the current directory, which is also the Agent's default
workspace. Change into the target project before starting it.

On Windows, the checkout also provides:

```bat
dsh-cc.cmd
dsh-cc.cmd --resume
```

`--resume` reads `%USERPROFILE%\.dsh-cc\resume.txt` and restores the session
last selected by the TUI. Set `DSH_CC_WORKSPACE` to override the working
directory used by the batch launcher.

## Profile configuration

The user override file is:

```text
$DSH_HOME/profiles/cc-tui/cordis.patch.yml
```

When overriding a row, its `config` block is replaced as a whole rather than
deep-merged. Repeat every key you want to keep. See
[Configuration](configuration.en.md) for examples.

The root `cordis.yml` is a bare-composition example. A normal npm/profile
installation uses `cordis.patch.yml`; do not copy the root configuration into
the profile.

## Develop from source

```sh
git clone https://github.com/yuxiaoLeeMarks/dsh-TUI.git
cd dsh-TUI
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`pnpm build` runs `tsc -p tsconfig.json` and emits `src/` into `lib/types/`.
Those generated files are committed and published, so source changes must be
followed by a rebuild.

CI also runs three rendering regressions:

```sh
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

The `pnpm tui` script invokes `scripts/run.ts`, which assumes the package lives
inside a DeepSeek Harness monorepo with a `packages/*` layout. It is not a
portable launcher for this standalone repository. For a real integration
check, install the package into a profile and run it in a TTY.

See [`AGENTS.md`](../AGENTS.md) for the full development workflow and the
verification matrix by change area.

## Troubleshooting

### `cc-tui requires an interactive terminal`

stdout is not a TTY. Start the process directly in a terminal rather than
redirecting its main output to another command or file.

### `dsh` or `pnpm` cannot be found

Make sure the global npm bin directory is on `PATH`, then open a new terminal.
`install.sh` checks both commands before installation.

### The model reports missing credentials

Confirm that `DEEPSEEK_API_KEY` is set in the same shell that starts `dsh`.
Check `DEEPSEEK_BASE_URL` too when using a custom endpoint.

### The activity row appears twice

Check whether `dsh-working-activity` was added separately to the profile. Keep
the row inserted by the cc-tui patch and remove the duplicate bundle entry.

### The TUI is misaligned or leaves terminal state behind

Run `/doctor`, record the terminal and mode, then consult
[Interaction and commands](interaction.en.md) and
[Architecture and limitations](architecture.en.md). `DSH_CC_RENDER_LOG` can
capture raw frames for rendering bugs, but those frames may contain visible
conversation content and should be handled as sensitive data.
