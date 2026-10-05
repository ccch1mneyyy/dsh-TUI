#!/usr/bin/env node
/**
 * dst — the fast-start entry of dsh-tui.
 *
 * Same launcher as `dsh-tui` (all subcommands and arguments are identical),
 * plus one difference: the dsh process is started with the pre-boot preload
 * (`lib/types/preboot/entry.js`), so the TUI paints its splash and prompt
 * within a few hundred milliseconds and accepts typing while dsh composes
 * and loads its plugin tree in the same process. Sending is possible once
 * the real screen takes over; the typed draft carries across.
 *
 * Opt-out: `DSH_TUI_PREBOOT=0 dst` runs the plain path. Opt-in from the
 * long command: `DSH_TUI_PREBOOT=1 dsh-tui`.
 *
 * Zero lib/ dependency, like bin/dsh-tui.js: the flag travels as an env
 * marker through the global → profile delegation, and the profile copy
 * resolves the preload from its own lib/ when it starts dsh.
 */
process.env.DSH_TUI_PREBOOT ??= '1'
await import('./dsh-tui.js')
