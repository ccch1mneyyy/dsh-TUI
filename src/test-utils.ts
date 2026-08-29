// Public test-utils shim: ecosystem plugin authors import from
// `@deepseek-harness-tui/dsh-tui/test-utils` to drive the same headless
// manifest/admission helpers the TUI's own verification batteries use.
//
// Test-only surface, Experimental: these helpers mount REAL cordis fibers
// through the REAL admission path. The adapter implementation stays behind
// the boundary; nothing here is meant for production plugin runtime code.
export * from './dsh-adapter/plugin-test-utils.js'
