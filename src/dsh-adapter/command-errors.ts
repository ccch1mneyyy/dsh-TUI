/**
 * commands contract error-code alignment (C-041,
 * `commands.dsh/v1alpha1#Command`): the official `dsh-commands` runtime
 * reports a duplicate registration as a plain `Error` whose MESSAGE is the
 * only signal:
 *
 *   `command "<name>" is already registered (…)`
 *   `command "<name>" is already registered in this scope`
 *
 * The v0.15 contract names the code `DUPLICATE_CONTRIBUTION_ID`. This module
 * maps the message-shaped error onto an `Error` carrying that `.code`, at
 * the HOST-MEDIATED registration/invocation points (the channel's skill
 * command registration and registry-command execution).
 *
 * Known boundary (C-070, trusted-in-process): a plugin calling
 * `ctx.commands.register` / `ctx.commands.execute` DIRECTLY bypasses this
 * mapping — code-level wrapping can only cover the points the host owns.
 * That is declared platform behavior, not a bug.
 */

/** The contract's command error vocabulary. */
export const COMMAND_ERROR_CODES = [
  'COMMAND_NOT_FOUND',
  'DUPLICATE_CONTRIBUTION_ID',
  'PERMISSION_NOT_GRANTED',
  'COMMAND_FAILED',
  'INVOCATION_CANCELLED',
  'INVOCATION_DEADLINE_EXCEEDED',
] as const
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number]

/** An Error carrying a contract error code on `.code`. */
export interface CodedCommandError extends Error {
  code: CommandErrorCode
  cause?: unknown
}

const DUPLICATE_PATTERN = /^command "[^"]+" is already registered/

/**
 * Map a thrown dsh-commands error onto its contract code. A duplicate
 * registration comes back as a CodedCommandError with
 * `DUPLICATE_CONTRIBUTION_ID` (original on `.cause`); every other value
 * passes through unchanged.
 */
export function mapCommandError(error: unknown): unknown {
  if (error instanceof Error && DUPLICATE_PATTERN.test(error.message)) {
    const mapped = new Error(error.message) as CodedCommandError
    mapped.name = error.name
    mapped.code = 'DUPLICATE_CONTRIBUTION_ID'
    mapped.cause = error
    return mapped
  }
  return error
}

/** True when `error` carries the given contract code. */
export function hasCommandErrorCode(error: unknown, code: CommandErrorCode): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === code
  )
}

/**
 * Run `operation` and rethrow any duplicate-registration failure with its
 * contract code attached (see {@link mapCommandError}).
 */
export async function withCommandErrorMapping<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw mapCommandError(error)
  }
}
