# Repository instructions

## Scope

This package is a vendored fork of `@earendil-works/pi-tui@0.84.2`.

- Upstream repository: `https://github.com/earendil-works/pi` (package path `packages/tui`).
- Pinned upstream commit: `086c32e74530564922d011ade23ff582c9d63116`.
- The same pin is recorded under `dsh.upstream` in `package.json`.

The initial vendor is zero-diff: `src/`, `test/`, and `native/` are byte-identical to the pinned upstream commit. The only intentional differences are packaging metadata: package name (`@deepseek-harness-tui/pi-tui`), version (`0.84.2-dsh.0`), `private: true`, the `dsh.upstream` record, a self-contained `tsconfig.build.json` (upstream inherits a monorepo-level base config that does not exist here), package-local `devDependencies` for the build toolchain, `files` including `LICENSE`, and the added `LICENSE` file.

## Maintenance rules

- This package must not carry dsh business logic.
- Only minimal fixes to generic capabilities (layout, input, rendering, etc.) are allowed.
- Each change is a minimal, rebasable commit on top of the pinned upstream base, accompanied by a minimal guard test.
- Record an upstream sync plan for every local change; prefer getting the fix merged upstream over growing local delta.

## Upgrade rules

- Before adopting a new upstream version, diff the new upstream commit against the pinned commit, then rebase the local commits one by one.
- The baseline may only be updated when `pnpm --filter @deepseek-harness-tui/pi-tui test` and the repository-root `pnpm test:tui` are both green.
- Keep an upgrade record containing: the upstream base commit, the list of local commits, and the verification results.

## Guard command

- `pnpm --filter @deepseek-harness-tui/pi-tui test`
