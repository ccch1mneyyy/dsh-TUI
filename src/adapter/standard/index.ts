/**
 * Canonical dsh-std / tui-profile plane for the TUI adapter.
 *
 * This is the single import point for protocol catalogs, Host Descriptor
 * construction, admission/negotiation, permission scopes, grant evaluation
 * and the pinned tui-profile profile loader.
 *
 * Invariants:
 * - No `@deepseek-ai/*` imports are allowed in this directory.
 * - Protocol semantics stay owned by dsh-std / tui-profile; Host Ports
 *   must not invent a second protocol language.
 * - P6 removed the legacy `src/plugin-spec/*` and
 *   `src/dsh-adapter/{grants,host-descriptor}.ts` shims; production code
 *   imports this canonical surface directly.
 */

export * from './types.js'
export * from './protocols.js'
export * from './schema-check.js'
export * from './permission-scope.js'
export * from './tui-extension.js'
export * from './registry.js'
export * from './admission.js'
export * from './grants.js'
export * from './descriptor.js'
