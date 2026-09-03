/**
 * dsh-ecosystem-spec / conformance thin layer.
 *
 * This directory is the intended single loading boundary for the vendored TUI
 * private protocol definitions. It must remain thin: protocol definitions are
 * authored in dsh-ecosystem-spec, not redefined here.
 */

export * from './profile.js'
export * from './tui-contributions.js'
export * from './protocol-constants.js'
