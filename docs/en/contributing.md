<p align="center">
  <a href="../zh/contributing.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Contributing Guide

Thank you for contributing to dsh-TUI. Bug fixes, terminal compatibility improvements, documentation updates, and new interaction features are all welcome.

## Prerequisites

The development environment requires:

- Node.js `^22.19` or `>=24`
- npm (the repository also keeps pnpm workspace configuration, but the development commands in `package.json` can be run directly with npm)
- A working DeepSeek Harness environment; launching the TUI also requires valid model configuration and an interactive terminal (TTY)

Clone the repository and install the dependencies:

```sh
git clone https://github.com/ybh618618/dsh-TUI.git
cd dsh-TUI
npm install
```

## Repository Layout

Most of the implementation lives under `src/`:

- `src/index.ts`: Cordis plugin entry point and configuration schema.
- `src/plugin.ts`: agent creation and resume, service assembly, TUI mounting, and terminal cleanup.
- `src/channel.ts`: bridge between agent session events and UI state.
- `src/screens/Chat.tsx`: main chat screen and top-level interaction orchestration.
- `src/components/`: messages, prompts, pickers, status components, and the design system.
- `src/ink/`: the ported and extended terminal React renderer, including layout, input events, and ANSI handling.
- `skills/`: built-in agent skills published with the package.
- `scripts/`: launchers, smoke tests, regression checks, and performance diagnostics.
- `cordis.patch.yml`: configuration patch used when the project is installed as a dsh bundle.
- `cordis.yml`: complete Cordis configuration used when running directly from the repository.

See [`AGENTS.md`](../../AGENTS.md) at the repository root for a more detailed directory map.

## Local Development

Compile the project:

```sh
npm run build
```

Launch the TUI from source:

```sh
npm run tui
```

Run the basic smoke test:

```sh
npm run smoke
```

The `scripts/verify-*.mjs` and `scripts/verify-*.tsx` files cover focused layout and interaction regressions. When changing related behavior, run the checks closest to the affected area:

```sh
node scripts/verify-themes.mjs
node --import tsx/esm scripts/verify-askpanel-layout.tsx
```

Some scripts require a real TTY, specific terminal capabilities, or an installed DeepSeek Harness environment. If a check cannot be run, explain the environment limitation and any substitute verification in the Pull Request.

## Development Conventions

- The project uses TypeScript, React 19, and ESM. Relative imports include a `.js` suffix so the compiled output loads correctly in Node.js.
- Prefer the themed components exported by `src/ui.ts` and the design primitives under `src/components/design-system/`.
- Do not manually edit files generated under `lib/types/`; change `src/` and run the build instead.
- When modifying `src/ink/`, account for Unicode display width, ANSI sequences, keyboard and mouse events, terminal state restoration, and both inline and fullscreen rendering modes.
- When changing session resume, agent presets, or tool assembly, review `src/plugin.ts`, `src/channel.ts`, and the Cordis configuration together.
- When user-visible text or behavior changes, update `docs/zh/`, `docs/en/`, and the relevant README content together.
- Keep changes focused. Avoid mixing unrelated refactors or broad formatting changes into the same Pull Request.

## Suggested Workflow

1. Search existing Issues and Pull Requests to check whether the work is already underway.
2. For a substantial feature or architecture change, open an Issue first and describe the use case, interaction design, and compatibility impact.
3. Create a dedicated branch from the latest code and make small, clearly scoped commits.
4. Add or update relevant verification scripts and bilingual documentation.
5. Run at least `npm run build`. For rendering or interaction changes, also run `npm run smoke` and the relevant regression scripts.
6. Open a Pull Request that clearly explains the problem, implementation, verification results, and known limitations.

## Pull Request Checklist

Before submitting, confirm that:

- [ ] The change contains only work required for the stated issue.
- [ ] `npm run build` passes.
- [ ] Applicable smoke tests or regression scripts have been run.
- [ ] New behavior includes a test, verification script, or reproducible validation steps.
- [ ] User-visible changes are documented in both Chinese and English.
- [ ] Terminal UI changes have been checked in applicable inline/fullscreen modes and on the intended platforms.
- [ ] The Pull Request describes the commands run and their results, including reasons for any skipped checks.

## Reporting Issues

When reporting a bug, please include as much of the following as possible:

- Operating system, terminal emulator, and their versions
- Node.js, dsh, and dsh-TUI versions
- Whether inline or fullscreen mode was used
- Minimal reproduction steps, expected behavior, and actual behavior
- Relevant logs, screenshots, or terminal output (remove API keys, access tokens, private path details, and other sensitive data first)

Terminal rendering issues are often affected by terminal capabilities, window size, Unicode character width, or ANSI support. Complete environment information makes them much faster to diagnose.
