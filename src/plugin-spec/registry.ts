// COMPAT(dsh-tui-adapter-v2): legacy public path retained while consumers migrate to adapter/standard.
// UNTIL: adapter-v2 P6 (all src/plugin-spec and legacy dsh-adapter consumers migrated)
// OWNER: dsh-tui adapter team
// TEST: verify:plugin-spec / verify:plugin-negotiation / verify:compat-removal
// Legacy compatibility shim. Canonical implementation has moved to
// adapter/standard; keep this path until consumer migrations are complete.
export * from '../adapter/standard/registry.js'
