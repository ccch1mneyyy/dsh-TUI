/**
 * React-reconciler selects its dev/production build at require time from
 * NODE_ENV; the dev build records one performance.measure() per render into
 * an unbounded buffer — the 4 GB long-session OOM (b1e06d8). Every launcher
 * forces production, but a direct `dsh --profile dsh-tui` boot loads this
 * plugin without one and silently regressed to the dev build. This module
 * must stay the FIRST import of the package entry so its body runs before
 * any module in the plugin graph requires react. `??=` keeps an explicit
 * environment choice (a debugging session) in control.
 */
process.env.NODE_ENV ??= 'production'
