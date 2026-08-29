# TUI cockpit chrome

Date: 2026-08-30
Status: approved in chat; waiting on spec review before implementation
Repo: `ccch1mneyyy/dsh-TUI` (local clone). Daily profile stays `dsh-tui`.

## Goal

Give dsh-TUI an optional pinned identity HUD plus a resource-dense footer, so a multi-model Genspark daily driver can see route and session metrics at a glance without fake spend. Off by default (PR-ready). Enabled in `~/.dsh/profiles/dsh-tui`.

## Non-goals

- Genspark or invented dollar/¥ prices. Official DeepSeek ¥ stays as it is today (provider-gated) and stays off in this profile.
- New theme. Aurora remains. No extra palette, no extra shimmer.
- Sidebar / metrics column / replacing `LogoHeader`.
- Changing default `statusBar` field switches for users who leave `cockpit` off.

## Layout

Pinned above the scrolling transcript (sibling of `StickyPromptHeader`, not inside `ScrollBox`):

```
prov genspark  model deepseek-v4-pro-0813  eff max  io text
────────────────────────────────────────────────────────────
<transcript: LogoHeader + messages, unchanged>
<prompt: same round box>
<context bar>
<footer: cache · tokens · tps · git · cwd · session · plugin chips>
<supplemental / hover row>
```

When `cockpit` is on, the footer omits `model` and `thinking` (those live in the HUD). Mode still appears in the HUD only when it is not the default cycle entry.

`io` is `vision` when the live model’s `inputModalities` includes `image`, `text` when modalities are known and image is absent, omitted when modalities are unknown.

## Setting

Top-level `dsh-tui` config boolean `cockpit` (default `false`). Same key in `/settings`. Not nested under `statusBar`.

Profile `cordis.patch.yml` on the `dsh-tui` row:

```yaml
cockpit: true
statusBar:
  compact: false
  tokens: true
  tps: true
  contextBar: true
  gitBranch: true
  sessionId: true
  activity: true
  cost: false
```

Profile `package.json` links `"@deepseek-harness-tui/dsh-tui": "link:/home/ujji/Projects/dsh-TUI"`.

## Data

- HUD reads `channel.provider`, `channel.model`, `channel.reasoningEffort`, `channel.mode` / `modeIndex`.
- Vision chip: extend channel state from `llm.resolveModelInfo` / `listModels` `inputModalities`. Do not hardcode a Genspark id list.
- If the llm seam is missing or the lookup fails: omit `io`, do not throw.
- Plugin `tuiStatus` chips stay on the footer (e.g. canvas URL).

## Polish

- HUD: one row, dim micro-labels (`prov` `model` `eff` `io`), Aurora `text` / `inactive` / `subtle`, hairline rule using existing `promptBorder`.
- Footer numbers: existing `StatusMetrics` compact token format.
- PromptInput is not rewritten. Polish is the HUD row + StatusLine field split and compact token glyphs already in StatusMetrics. No new animation.

## Files

- `src/tuiDisplayPrefs.ts` — no `cockpit` here (top-level, not a status-bar field).
- `src/dsh-adapter/index.ts` — Config + Schema `cockpit`.
- `src/dsh-adapter/channel.ts` / `plugin.ts` — plumb `cockpit` and `inputModalities`.
- `src/components/CockpitHud.tsx` — new, one row.
- `src/screens/Chat.tsx` — mount HUD when `channel.cockpit`.
- `src/screens/StatusLine.tsx` — skip model/thinking when cockpit.
- `src/i18n.ts` — en + zh strings for labels.
- Settings section for the boolean.
- `scripts/verify-display-settings.tsx` — HUD on/off, footer dedupe, unknown modalities.
- `~/.dsh/profiles/dsh-tui/package.json` + `cordis.patch.yml` — link + enable.

## Tests

Extend `verify-display-settings.tsx`:

1. `cockpit: false` → no HUD row, footer still shows model when that field is on.
2. `cockpit: true` → HUD contains provider, model, effort; footer does not repeat model.
3. Modalities include `image` → `vision`; text-only known → `text`; unknown → no `io` chip.
4. Missing llm info does not throw.

## Error handling

HUD is best-effort. A missing field is omitted. Minimal mode still drops splash art; cockpit HUD also hides in minimal mode (same contract as extra chrome).
