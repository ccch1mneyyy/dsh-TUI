/**
 * Package-owned invariant companion for `@deepseek-harness-tui/dsh-tui`.
 *
 * The vendored Ink core under `src/ink` is third-party code written against
 * looser compiler flags; the relaxed `tsconfig` options exist only for that
 * subtree and must not spread to new code.
 * @module @deepseek-harness-tui/dsh-tui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'

/** Cordis companion plugin name. */
export const name = 'dsh-tui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this interactive TUI front door owns no independent
 * lifecycle stream; state relations are owned by the agent/session seams it
 * renders.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
