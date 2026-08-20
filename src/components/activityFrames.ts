/**
 * Working-activity indicator presets — thin re-export of the single source
 * of truth in the `dsh-working-activity` package (`src/frames.ts`). The TUI
 * keeps this shim so existing importers (`/activity` picker, status line,
 * channel, activity prefs) resolve the same names without moving; all preset
 * data (the pi-extension union, 35 presets) lives upstream.
 * @module dsh-tui/components/activityFrames
 */

export * from 'dsh-working-activity/frames'
