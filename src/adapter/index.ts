/**
 * TUI Adapter v2 incremental skeleton.
 *
 * Layering:
 * - ports/     pure internal Host Ports (no @deepseek-ai, no dsh-std protocol)
 * - kernel/    runtime/lifecycle/ownership/host-facade/diagnostics
 * - upstream/  future-only home for @deepseek-ai/* drivers
 * - standard/  canonical @dsh-std/* + TUI admission/descriptor/grants
 * - spec/      thin dsh-ecosystem-spec / conformance loading layer
 *
 * Existing public subpaths and Cordis service names are unchanged during this
 * incremental migration.
 */

export * from './ports/index.js'
export * from './kernel/index.js'
export * from './upstream/index.js'
export * from './channel/index.js'
export * from './standard/index.js'
export * from './spec/index.js'
