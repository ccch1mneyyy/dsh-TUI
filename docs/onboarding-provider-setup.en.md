# Accounts and models in first-run onboarding (Onboarding v2 design)

Status: design settled; implementation on `feat/onboarding-provider-setup` (base `a40c305a`).
Related: the first wizard (#1255), the `/provider` wizard, `dsh-auth` subscription sign-in,
`/settings` credential writes.

This document answers one question: **how should the first-run guide get "which models can this
machine use" configured**, instead of pushing the user at an environment variable. Every claim
below has a code landing point; line numbers are from `a40c305a` and should be re-found by symbol
after the change.

## 1. The problem

### 1.1 Today (v1)

`ONBOARDING_STEPS = ['apikey', 'look', 'model', 'keys']` (`src/components/onboardingModel.ts:14`).
The first step, `ApiKeyStep` (`src/screens/Onboarding.tsx:619`), is a **read-only check page**:

- `channel.describeCredential('DEEPSEEK_API_KEY')` reports presence only (`:127`);
- `channel.balanceInfo()` runs one real connectivity check (`:131`);
- when the key is missing it prints two hints (`:650-653`): `DEEPSEEK_API_KEY=sk-…` (POSIX
  shape with a PowerShell aside) and `~/.deepseek/config.json { "apiKey": … }`;
- on the keyboard, Enter only means "check again" (`:418-421`).

So the user cannot configure anything on that page. Every real configuration surface lives
elsewhere:

| Entry point | What it can do | Evidence |
| --- | --- | --- |
| `/provider` | add/edit/delete provider routes, type an API key, subscription OAuth (when `ctx.dshAuth` is mounted) | `src/dsh-adapter/providerWizard.ts:153`, `:205-214`, `:1010` |
| `/auth login <provider>` | subscription OAuth (including the Host's `deepseek-account`) | `src/dsh-adapter/oauth/index.ts:267`, `oauth/service.ts:96-140` |
| `/login` | status plus a pointer ("Manage DSH credentials with /provider…") | `src/screens/Chat.tsx:3842`, `src/i18n.ts:692` |
| `/settings` | only the **web-search** secret field is writable (its default ref happens to be `DEEPSEEK_API_KEY`) | `src/dsh-adapter/channel/settings-host.ts:83-92` |

### 1.2 Concrete defects

1. **Read-only vs expectation**: the first screen of a fresh install only reports "not
   configured" and offers no action, which reads as "you cannot configure it here".
2. **One hint is wrong**: nothing in DSH reads `~/.deepseek/config.json`. The real store on
   0.2.1-rc.2 is `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`) plus
   environment variables; upstream's *Configure models* guide hands key writing to the web
   Models page. The path is equally absent from the 0.1.7-rc.1 / 0.2.0-rc.2 `dsh-llm-deepseek`
   packages.
3. **The env-var hint is POSIX-shaped**: on Windows the durable answer is a user-level
   environment variable (exactly what the one-click bundle writes,
   `scripts/make-installer-bundle.mjs:151-165`), and `~` is not expanded by cmd/PowerShell.
4. **Post-login content is dropped**: the `dsh-auth` catalog is **credential-gated** —
   `CredentialGatedAdapter.listModels()` returns `[]` for a provider with no stored credential
   (`src/dsh-adapter/oauth/index.ts:139-163`). "Signed in" and "these models appear in the
   catalog" are therefore one observable state change, and the guide should catch it; v1 does not.
5. **No default model comes out of it**: after signing in or adding a key the user is still on
   the read-only page and must pick a default again in step 3 or `/model`.

### 1.3 What is *not* a defect (ruled out first)

- A missing key does **not** hide the wizard: DSH resolves the key per request (`resolveAuth`),
  model discovery swallows `MISSING_CREDENTIAL` into an empty catalog, and `agents.create` never
  touches credentials, so `channel.startupFailure`
  (`src/dsh-adapter/channel/core/compose.ts:944`) does not fire for a missing key and the wizard
  opens as usual (the repo's own installed-profile probe dismisses it with `Esc 跳过引导` on an
  isolated HOME: `scripts/verify-installed-startup.mjs:174-182`).
- No platform branch gates onboarding:
  `onboardingOnBoot = dshBoot && noResume && shouldOfferOnboarding()`
  (`src/dsh-adapter/plugin.ts:2370`), and `shouldOfferOnboarding` only reads
  `~/.dsh-tui/onboarding.json` (`src/onboardingPrefs.ts:120`).
- The wizard still earns its place: it is the only place that aligns **language/theme + default
  model/effort/workspace + shortcuts** in one pass.

## 2. Goals and non-goals

**Goals**

- G1 Turn step 1 from a read-only check into an **access page**: subscription sign-in, API-key
  configuration and re-check happen inside the guide; stop pushing `DEEPSEEK_API_KEY`.
- G2 Catch what sign-in/config produced: nothing new → no question; exactly one model →
  auto-default; several → ask which to adopt and which becomes the default.
- G3 Keep step 3's default model consistent with the adoption result (no second picking pass).
- G4 Hints must be true and cross-platform (drop `~/.deepseek/config.json`, give a runnable
  Windows form).
- G5 Add no UI→adapter **value** import and no new port method (reuse `providerSetup()`,
  `oauthProviderStatuses()`, `listModels()`, `switchModel()`).

**Non-goals**

- N1 No rewrite of the `/provider` wizard and no change to its persistence semantics
  (route profile + credential + rollback).
- N2 The DSH account domain stays Host-owned (PKCE, callback, token store).
- N3 No low-level editing inside the guide (e.g. `cordis.patch.yml`).
- N4 The four-step skeleton and the accounting contract ("Esc skips without recording; only
  finishing records") stay as they are (`src/screens/Onboarding.tsx:465-473`,
  `src/onboardingPrefs.ts:97-109`).

## 3. Architecture

### 3.1 Layers and module boundaries

Following the repo rules (no UI imports of backends; `src/dsh-adapter/` is the only place that
may import `@deepseek-ai/*`; UI takes only types from `src/dsh-adapter/`):

```
src/screens/Onboarding.tsx        ← screen: state machine + rendering + keyboard/mouse (no credentials)
src/components/onboardingProviderPlan.ts   ← pure: catalog diff, 0/1/N decision, candidate order
src/onboardingDraft.ts            ← module store: memory across question-panel takeovers
src/screens/Chat.tsx              ← seam owner: questionStore.ask / provider action callbacks / refresh
src/dsh-adapter/providerWizard.ts ← existing values: runProviderWizard, runOAuthLogin (semantics untouched)
src/dsh-adapter/oauth/index.ts    ← existing values: dsh-auth service and its gated catalog (untouched)
```

**Why the action callbacks live in Chat, not in Onboarding**: Chat already owns `questionStore`
(`Chat.tsx:3309`), the two existing value imports (`Chat.tsx:47`) and the "refresh
models/providers/completion after `/provider`" tail (`Chat.tsx:3317-3331`). Putting them there
reuses all of it with **no new boundary exception**; Onboarding receives two callback props.

**Why progress lives in a module store**: question and approval panels share one interrupt lane
with full-screen surfaces — while a panel is pending the screen is unmounted and **remounted**
afterwards (`Chat.tsx:6283-6294`; `screenOpen` includes `onboardingOpen`). If the access flow uses
the panel (API-key entry, OAuth device codes / authorize URLs), the wizard's React state is lost
during the takeover. `src/onboardingDraft.ts` therefore stores the current step, focus, the
pre-action catalog baseline, the pending provider/models, and one notice line; it is read on
mount, written on change, and cleared on finish/skip.

### 3.2 State machine (step 1)

```
            ┌─────────────┐
  mount  ──▶│  checking   │  describeCredential + oauthProviderStatuses + listModels/listProviders
            └──────┬──────┘
                   ▼
            ┌─────────────┐   action ❯ Sign in to a subscription (providers, signed-in or not)
            │   ready     │   action   Add a model provider (API key) → the /provider add flow
            │ (action row)│   action   Check again / Skip this step (= next step)
            └──┬───┬───┬──┘
               │   │   └────── check again ──────▶ checking
   sign-in/key │   │
               ▼   │
        ┌──────────┴──┐   in flight: `pending` stays set; a mid-run remount restores progress and does **not** settle
        │  in-flight  │
        └──────┬──────┘
               ▼   the action ends: write `draft.completed` (cancelled/failed carry their status too)
        ┌─────────────┐
        │  completed  │
        └──────┬──────┘
               ▼   settle: by the mounted instance; the subscription delivers a late completion to it
        ┌─────────────┐
        │  adopting   │  catalog diff: 0 → none (report only); 1 → auto; N → inline multi-select + default pick
        └──────┬──────┘
               ▼
            ready ("adopted N models, default X")
```

Esc semantics are unchanged: at any point Esc skips the whole guide (without recording); inside
the access sub-flow, Esc is consumed by the panel/inline layer and returns to `ready`.

### 3.3 Data flow

**A. Subscription sign-in (OAuth)**

1. First frame reads `channel.oauthProviderStatuses()` (`undefined` when `dsh-auth` is not
   mounted → the action row is disabled with a reason instead of pretending to work).
2. Enter on a row calls Chat's `onProviderSignIn(provider)` →
   `runOAuthLogin(deps, oauth, provider)` (`src/dsh-adapter/providerWizard.ts:995`) → the panel
   drives device codes / authorize URLs / the browser (`openInBrowser`; its win32 branch already
   handles cmd's `&` quoting, `src/dsh-adapter/oauth/opener.ts:21-38`).
3. The login writes dsh-auth's own credential file; the **next `listModels()`** already shows
   that provider's models (`CredentialGatedAdapter` re-reads the credential per call).
4. After the remount, the `adopting` phase diffs (3.4).

**B. API key (the `/provider` add flow)**

1. The action row calls Chat's `onProviderAddProvider()` → `runProviderWizard(...)`, exactly
   like `/provider`.
2. The wizard asks route/endpoint/protocol/key/model multi-select itself and **writes the
   credential first, then the profile, rolling back on failure**
   (`providerWizard.ts:380-410`). Its model multi-select *is* the "add?" question for key routes.
3. On return we enter `adopting` with only the **newly appeared** models as default candidates.

**C. Already configured (env / credential store / existing route)**

`describeCredential('DEEPSEEK_API_KEY')` and the catalog may already be non-empty on the first
frame. Then step 1 shows status plus actions and never enters `adopting` (there is nothing new).

### 3.4 The 0/1/N default decision (pure)

`src/components/onboardingProviderPlan.ts`:

```ts
export interface ProviderModelRef { readonly provider: string; readonly id: string; readonly name: string }

export interface AdoptionPlan {
  readonly provider: string | undefined           // the provider that changed (undefined when unknown)
  readonly added: readonly ProviderModelRef[]     // in current catalog order
  readonly decision: 'none' | 'auto' | 'ask'      // 0 / 1 / N
  readonly defaultPick: ProviderModelRef | undefined  // N's preselection: the live route if among them, else the first
}

export function planModelAdoption(input: {
  readonly baseline: readonly ProviderModelRef[]
  readonly current: readonly ProviderModelRef[]
  readonly provider?: string
  readonly currentRoute?: { provider: string; id: string }
}): AdoptionPlan
```

- `added` holds only models absent from the baseline and present now; a given `provider` narrows
  it. Re-checks, a second provider signing in, and mid-flow edits therefore never re-ask about
  models already adopted.
- `decision` is exactly the requested three-way rule: **none → don't ask; one → default it;
  several → ask**.
- `defaultPick` keeps the N branch stable (live route first) instead of jumping to the list head.

### 3.5 What "adopt" actually persists (honesty decision)

This is easy to turn into a fake button, which the repo explicitly rejects (see the key-card
comment in `onboardingModel.ts:34-37`). The three paths persist different things, so the copy must
match:

| Path | What is persisted | Copy in the guide |
| --- | --- | --- |
| OAuth sign-in | the provider credential (the plugin's own store); models are **usable as soon as you are signed in** (gated catalog) | "These models are available now — pick one as the default" |
| `/provider` key route | the route profile (including the selected `models`) + the credential ref | "Wrote N models — pick one as the default" |
| Default model | `channel.switchModel(provider, id)` → `~/.dsh-tui/model.json` (`src/dsh-adapter/channel/model-switch.ts`) | "Default model: X" |

So the "add?" question becomes:
- key routes: answered by `/provider`'s own model multi-select (real persistence) — the guide
  does not ask twice;
- OAuth: **no pretend enable list**; the question is "Adopt <provider>'s N models and pick a
  default?", where N>1 first multi-selects (which ones enter the default candidates) and then
  single-selects the default; with exactly one, nothing is asked and it is defaulted directly.

### 3.6 Relationship to step 3 (model / effort / workspace)

- After step 1 adopts, step 3 marks the newly adopted provider as "new" and preselects the model
  that just became the default.
- If the user skips adoption, step 3 keeps v1 behaviour (full catalog, empty-catalog hint); the
  empty hint now points at `/provider` **and** `/auth`.

## 4. Failure, rollback, idempotence

- **Sign-in fails/cancels**: `runOAuthLogin` already normalizes `UserQuestionError` to
  `'cancelled'` and everything else to `'failed'` with a notification
  (`providerWizard.ts:1056-1070`). The guide only consumes the result; `adopting` with zero new
  models degrades to `none`.
- **Credential writes**: the guide never writes credentials itself; `/provider`'s rollback
  semantics (credential first, profile second, restore the old key when the profile write fails;
  `providerWizard.ts:380-410`) are preserved untouched.
- **Repeated adoption**: the baseline lives in the draft, so a remount keeps the same baseline
  and the same batch is never asked about twice.
- **Action id (review fix)**: `pending` carries a monotonic id. Closing the guide does not cancel
  the provider flow, so a leftover promise can finish after the user reopened `/setup` and started
  a NEW action; writing its `completed` unconditionally would overwrite that action's `pending` and
  make the guide settle the abandoned run while the live one loses its result. The completion is
  written only when `draft.pending.id` is our own (see §7.2).
- **Settle ordering (review fix)**: `pending` covers the WHOLE run and `completed` is written only
  when the action ends; settling requires `completed`. The question panel can close *between* two
  questions (model discovery and the profile write happen there), so the guide remounts while the
  catalog has not changed — settling then would read the old catalog and drop the result. The
  runner writes `completed` even when it has been unmounted (skipped if the guide was closed), and
  the mounted instance is notified through `subscribeOnboardingDraft`; mount, subscription and the
  promise callback together settle exactly once (`completed` is cleared synchronously first).
- **Panel takeover**: the wizard unmounts while a panel is up, so the draft write must happen
  **before** starting the action (baseline + intent), or the context is lost.
- **Write failure**: a false `switchModel` reports the same
  `onboarding-model-switch-failed` message rather than failing silently.

## 5. Keyboard, mouse, Esc

- Step 1's action rows are `ListItem`s (existing hover/click contract): ↑/↓ move focus, Enter
  triggers.
- The inline adoption layer (N branch) is the guide's own modal layer, and the two keys do one job
  each: **`Space` selects** (in the model zone it toggles the focused row; in the default zone it
  marks the focused row as the default) and **`Enter` confirms** (the model zone confirms this
  batch and moves to the default pick; the default zone writes the marked row as the default
  model). `↑`/`↓` only move the focus and never move the mark, `Tab` switches zone, `Esc` pops one
  layer. Mark and focus are drawn separately (✓ = selected, ❯ = focused), so "Enter applies the ✓
  row" is readable — isomorphic to the existing workspace modal (`Onboarding.tsx:262-296`).
- A mouse click and `Space` share one toggle function: un-ticking the marked default hands the mark
  to the first still-selected model (an earlier revision only did this on the keyboard path, so the
  default zone could end up with no tick at all).
- Global Esc still skips the guide; `Ctrl+C` is synonymous (`Onboarding.tsx:300-305`).
- The bottom hint line follows the current sub-state instead of one hard-coded sentence.

## 6. Gate and contract impact

- **No port change**: no new `ChannelUi` method → `src/adapter/channel/ui-policy.ts`,
  `scripts/verify-adapter-ports.*` and `verify-adapter-effect-class.*` stay as they are.
- **No new boundary exception**: Onboarding imports no value from `src/dsh-adapter/`; Chat's
  existing import line (`Chat.tsx:47`) gains no symbol.
- **i18n**: new keys need both zh and en and a literal reference in `src/` or `scripts/`
  (`scripts/verify-i18n.ts` dead-key/completeness checks); no new `DYNAMIC_PREFIXES`.
- **Regressions**: `scripts/verify-onboarding-wizard.tsx` (component contract) and
  `scripts/verify-launchpad-onboarding-chat.tsx` (Chat integration: `/setup`, Esc accounting,
  model/effort/workspace) must stay green; the latter's fake channel has no
  `oauthProviderStatuses`, so every new read goes through optional chaining.

## 7. Test plan

1. New `scripts/verify-onboarding-provider-plan.ts` (pure, no React): the three branches,
   idempotent repeated diffs, `defaultPick` preferring the live route, provider filtering.
2. Extend `scripts/verify-onboarding-wizard.tsx` (fake channel + fake sign-in callback):
   - with no key, step 1 renders action rows and no longer shows `~/.deepseek/config.json`;
   - one new model → automatic `switchModel`, no question;
   - three new models → the inline multi-select appears, preselection is right, confirming
     switches to the chosen model;
   - nothing new → notice only, no `switchModel`;
   - `onProviderSignIn` receives the right provider;
   - the draft keeps step/focus across an unmount-remount.
3. `node --import tsx/esm scripts/verify-i18n.ts`: completeness, placeholders, dead keys.
4. `node --import tsx/esm scripts/verify-launchpad-onboarding-chat.tsx`: Chat integration intact.

### 7.1 Actual results (2026-10-20, after syncing `origin/main` `5e0146bc`)

Sync: the 44 upstream commits (a40c305a → 5e0146bc) **touched none of** `Onboarding.tsx` /
`onboardingModel.ts` / `providerWizard.ts` / `oauth/`; `git stash pop` applied without conflicts and
`ProviderWizardOutcome` is unchanged.


| Gate | Result |
| --- | --- |
| `scripts/verify-onboarding-wizard.tsx` | **88/88 passed** (new J1–J12: action rows, fallback copy, the 0/1/N branches, Space/Enter split, draft across a remount, panel-takeover settle, mark hand-over) |
| `scripts/verify-onboarding-provider-plan.ts` (new) | **21/21 passed** |
| `scripts/verify-i18n.ts` | passed (2077 entries, no dead keys, placeholders consistent) |
| `scripts/verify-guide.mjs` | passed (20 guide files byte-identical) |
| `scripts/verify-adapter-boundary.ts` | passed (no new UI→adapter value import) |
| `tsc -p tsconfig.json --noEmit` | zero errors in the changed files (the remaining errors come from this machine's node_modules drifting behind main's dependency line) |
| `scripts/verify-launchpad-onboarding-chat.tsx` | 5/235 this run; the **stable failure set is Z8×2 / Z9 / Z10×2** (clipboard/image — no clipboard toolchain here), identical to the clean `origin/main` baseline. A separate `N4a/N4b` pair (launchpad command-palette mouse click) is a timing flake: **the clean baseline hit it twice in a row (7/235)** too, so it is unrelated to this change. The A/B points `NPM_CONFIG_REGISTRY` at an unreachable address to suppress the "update available" condition |

### 7.2 Review fixes (found in self-review, already fixed)

| Problem | Symptom | Fix |
| --- | --- | --- |
| The action list grows asynchronously, focus tracked by index | The first frame only has "check again / skip"; once the status read lands, "sign in / add key" are prepended → focus silently moves from "check again" to "sign in" and one Enter hits the wrong action | Focus is tracked by **action id**; a fresh mount pins no row (`accessFocusId = undefined` = first row) and only a remount restores the draft's index |
| The unmounted instance settles first | The panel opens → the screen unmounts → the in-flight promise resolves and the dead instance clears `pending`, so the remounted instance finds nothing to settle → models from the sign-in are never adopted | `settlePendingAction` checks `aliveRef` first and leaves `pending` untouched when unmounted; J9 pins it with a never-resolving sign-in + unmount + remount |
| `cancelled`/`failed` also ran the settle | A failure surfaced as "no new models", hiding the real reason | Both only clear `pending` and return to the action layer; a failure gets its own local echo (the notification bar is invisible under a full-screen guide) |
| Status was not refreshed after settling | A provider just signed in still read "not signed in" | Both settle and the default write bump `checkNonce`, re-reading credentials / sign-in state / connectivity |
| Late resolution wrote a stale draft | The user left the guide, then `switchModel` resolved and left a stale notice for the next `/setup` | The landing check consults `aliveRef` first; after unmount nothing is written |
| Chat's hooks sat after an early return | When a panel was pending Chat returned early, skipping the three new `useCallback`s → the hook count changed when the panel closed (React errors) | The three callbacks moved up next to `switchModelRecorded`, above every early return |

| Settled before the action finished (review, major) | The panel closes between two questions → the guide remounts with an unchanged catalog → an early settle reads the old catalog, and the action finishes with nobody left to adopt its models (**a successful sign-in is never adopted**) | `pending` covers the whole run and `completed` is written only at the end; settling requires it; `subscribeOnboardingDraft` delivers a late completion to the mounted instance. J9 was rewritten for this order (not finished → no settle; finished → exactly one settle) and J11 covers "already completed at mount" |
| Focus restored by index (review) | `runProviderAction` stored a row number; on the remount's first frame `oauth` is not back yet, so the list is shorter and the number points at another action | the draft gained `focusId` and restores by action id; an id that is not in the list yet falls back to row 0 and snaps back once the list grows |
| Mouse toggle did not hand over the mark (review) | the keyboard `Space` path had the hand-over, `onToggle` did not | both paths share `toggleAdoptSelection` |
| The English manual missed the `←/→` exception (review) | the Chinese one listed step 1's access sub-layer, the English one only the slider and a drilled-in model list | `docs/interaction.en.md` synced and `guide/` rebuilt |

| A stale run overwrote the new pending (review, minor) | close the guide → reopen `/setup` and start a new action → the old run's late callback wrote its completion over the new pending | `OnboardingPendingAction` gained a monotonic `id`; the completion is written only for that id; J12 covers close → new run → old run late → the new run still settles |
## 8. Compatibility and migration

- **`ONBOARDING_VERSION` is not bumped**: per `src/onboardingPrefs.ts:34-39` only an **added
  step** bumps it. This is a capability upgrade inside the same steps (step 1 changes meaning,
  step 3 gains preselection), and re-running the guide on every existing install is not wanted.
  If "accounts and models" later becomes a fifth step, bump then.
- **DSH version line**: `describeCredential` / `providerSetup()` / `oauthProviderStatuses()` are
  existing optional seams (absent ⇒ degrade), so on a 0.1.x host step 1 falls back to
  "status + environment-variable hints" without crashing.
- **Hosts without `dsh-auth`**: the sign-in row is disabled with the reason; the `/provider` key
  path still works.

## 9. Windows-specific fixes (mirrors 1.2)

1. Remove the `~/.deepseek/config.json` hint.
2. The fallback hints give platform-correct forms: a PowerShell user-level persisted variable
   (`[Environment]::SetEnvironmentVariable(...,'User')`, the same stance as the one-click
   bundle), cmd's `setx`, and the real location of `$DSH_HOME\.credentials.yaml`.
3. The primary path is no longer the environment variable but sign-in / key entry inside the
   guide; environment variables become "you can also do this".

## 10. Open questions

- Q1 (**investigated; feasible, deferred to a small follow-up PR**) Should the adoption layer offer
  a "DeepSeek official API key" shortcut?
  - **Canonical path**: the browser/desktop Models page writes through the `credentials` Remote
    namespace (`credentials.set(ref, value)` → `ctx.credentials.set`, see
    `@deepseek-ai/dsh-api-settings-controller`); the TUI's `/provider` uses the same seam via
    `providerSetup().writeCredential(ref, value)`.
  - **No owner restriction**: `isReservedCredentialRef` only guards **plugin-registered settings
    sections** and the generic `/settings` secret write (`settings-host.ts:213`); `/provider`'s write
    never passes through it, so `writeCredential('DEEPSEEK_API_KEY', key)` is architecturally valid.
  - **No schema to lean on**: DSH's `apiKeyEnv` field only declares `role: 'credential-ref'` (a name);
    the web page hard-codes its key input, and settings descriptors carry no generic "secret field"
    the TUI could render — so the row would be hard-coded here too.
  - **Why not in this PR**: it writes a shared ref (every route using `DEEPSEEK_API_KEY` changes key
    at once) and needs an impact confirmation, which is its own topic; this PR lands the access spine
    and the copy fixes first.
- Q2 Should the default reasoning effort follow the adoption result? Not in this design.
- Q3 With several providers adopted at once, should we ask "default provider" before "default
  model"? Today providers are adopted in catalog order, one question set each.
