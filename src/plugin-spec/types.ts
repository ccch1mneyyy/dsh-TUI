// COMPAT(dsh-tui-adapter-v2): legacy public path retained while consumers migrate to adapter/standard.
// UNTIL: adapter-v2 P6 (all src/plugin-spec and legacy dsh-adapter consumers migrated)
// OWNER: dsh-tui adapter team
// TEST: verify:plugin-spec / verify:plugin-negotiation / verify:compat-removal
// Legacy compatibility shim. Canonical protocol types now live in the
// adapter/standard layer; this path is retained for the existing public
// subpath and verification scripts during incremental migration.
export * from '../adapter/standard/types.js'
