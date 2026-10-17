/** Versioned CLI DTOs. No UI, backend or process dependencies. */
export const SCHEMA_VERSION = 1

/** Stable automation failures; backend failure details stay on stderr. */
export class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

export function envelope(type, fields = {}) {
  return { schemaVersion: SCHEMA_VERSION, type, ...fields }
}

export function failure(error) {
  return {
    code: error instanceof CliError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof CliError ? error.message : 'CLI operation failed; inspect controlled diagnostics.',
  }
}
