# Accounts and models in first-run onboarding (Onboarding v2 design)

Related: #1646 (this design), the first wizard (#1255), the `/provider` wizard, `dsh-auth`
subscription sign-in, `/settings` credential writes.

This document answers one question: **how should the first-run guide get "which models can this
machine use" configured**, instead of pushing the user at an environment variable. Code landing
points are named by module and symbol; search by name.

## 1. The problem

### 1.1 Step 1 in v1

The first entry of `ONBOARDING_STEPS` used to be `apikey`, rendered by `ApiKeyStep`
(`src/screens/Onboarding.tsx`), a **read-only check page**:

- `channel.describeCredential('DEEPSEEK_API_KEY')` reports presence only;
- `channel.balanceInfo()` runs one real connectivity check;
- when the key is missing it prints two hints: `DEEPSEEK_API_KEY=sk-…` (POSIX shape with a
  PowerShell aside) and `~/.deepseek/config.json { "apiKey": … }`;
- on the keyboard, Enter only means "check again".

So the user cannot configure anything on that page. Every real configuration surface lives
elsewhere:

| Entry point | What it can do | Landing point |
| --- | --- | --- |
| `/provider` | add/edit/delete provider routes, type an API key, subscription OAuth (when `ctx.dshAuth` is mounted) | `runProviderWizard`, `runOAuthWizard` in `src/dsh-adapter/providerWizard.ts` |
| `/auth login <provider>` | subscription OAuth (including the Host's `deepseek-account`) | `src/dsh-adapter/oauth/` |
| `/login` | status plus a pointer ("Manage DSH credentials with /provider…") | Chat's `login` command |
| `/settings` | only the **web-search** secret field is writable (its default ref happens to be `DEEPSEEK_API_KEY`) | `src/dsh-adapter/channel/settings-host.ts` |

### 1.2 Concrete defects

1. **Read-only vs expectation**: the first screen of a fresh install only reports "not
   configured" and offers no action, which reads as "you cannot configure it here".
2. **One hint is wrong**: nothing in DSH reads `~/.deepseek/config.json`. The real store is
   `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`) plus environment variables;
   upstream's documentation hands key writing to the web Models page. The path is equally absent
   from `dsh-llm-deepseek`.
3. **The env-var hint is POSIX-shaped**: on Windows the durable answer is a user-level
   environment variable (exactly what the one-click bundle writes, see
   `scripts/make-installer-bundle.mjs`), and `~` is not expanded by cmd/PowerShell.
4. **Post-login content is dropped**: the `dsh-auth` catalog is **credential-gated** —
   `CredentialGatedAdapter.listModels()` returns `[]` for a provider with no stored credential
   (`src/dsh-adapter/oauth/index.ts`). "Signed in" and "these models appear in the catalog" are
   therefore one observable state change, and the guide should catch it; v1 does not.
5. **No default model comes out of it**: after signing in or adding a key the user is still on
   the read-only page and must pick a default again in step 3 or `/model`.

### 1.3 What is *not* a defect (ruled out first)

- A missing key does **not** hide the wizard: DSH resolves the key per request (`resolveAuth`),
  model discovery swallows `MISSING_CREDENTIAL` into an empty catalog, and `agents.create` never
  touches credentials, so `channel.startupFailure` does not fire for a missing key and the wizard
  opens as usual (the repo's own installed-profile probe, `scripts/verify-installed-startup.mjs`,
  dismisses it with `Esc 跳过引导` on an isolated HOME).
- No platform branch gates onboarding:
  `onboardingOnBoot = dshBoot && noResume && shouldOfferOnboarding()`
  (`src/dsh-adapter/plugin.ts`), and `shouldOfferOnboarding` only reads
  `~/.dsh-tui/onboarding.json` (`src/onboardingPrefs.ts`).
- The wizard still earns its place: it is the only place that aligns **language/theme + default
  model/effort/workspace + shortcuts** in one pass.

## 2. Goals and non-goals

**Goals**

- G1 Turn step 1 from a read-only check into an **access page**: subscription sign-in, API-key
  configuration and re-check happen inside the guide; stop pushing `DEEPSEEK_API_KEY`.
- G2 Catch what a subscription sign-in produced: nothing new → no question; exactly one model →
  auto-default; several → pick one of the new models as the default (all of them are usable once
  signed in, see 3.5). A key route's
  enablement and switch are asked by the `/provider` wizard itself (with several models it lists
  each one for the user to pick, or keeps the current model); the guide only reports (see 3.5).
- G3 Keep step 3's default model consistent with the adoption result (no second picking pass).
- G4 Hints must be true and cross-platform (drop `~/.deepseek/config.json`, give a runnable
  Windows form).
- G5 Add no UI→adapter **value** import and no new port method (reuse `providerSetup()`,
  `oauthProviderStatuses()`, `listModels()`, `switchModel()`, `notifications`).

**Non-goals**

- N1 No rewrite of the `/provider` wizard and no change to its persistence semantics
  (route profile + credential + rollback).
- N2 The DSH account domain stays Host-owned (PKCE, callback, token store).
- N3 No low-level editing inside the guide (e.g. `cordis.patch.yml`).
- N4 The four-step skeleton and the accounting contract ("Esc skips without recording; only
  finishing records") stay as they are (`finish` in `Onboarding`, `src/onboardingPrefs.ts`).

## 3. Architecture

### 3.1 Layers and module boundaries

Following the repo rules (no UI imports of backends; `src/dsh-adapter/` is the only place that
may import `@deepseek-ai/*`; UI takes only types from `src/dsh-adapter/`):

```
src/screens/Onboarding.tsx        ← screen: state machine + rendering + keyboard/mouse (no credentials)
src/components/onboardingProviderPlan.ts   ← pure: catalog diff, 0/1/N decision, candidate order
src/onboardingDraft.ts            ← module store: memory across question-panel takeovers
src/screens/Chat.tsx              ← seam owner: questionStore.ask / provider action callbacks / refresh
src/dsh-adapter/providerWizard.ts ← existing values: runProviderWizard, runOAuthLogin
src/dsh-adapter/oauth/index.ts    ← existing values: dsh-auth service and its gated catalog (untouched)
```

**Why the action callbacks live in Chat, not in Onboarding**: Chat already owns `questionStore`,
the existing value import from `providerWizard.js` and the "refresh models/providers/completion
after `/provider`" tail. Putting them there reuses all of it with **no new boundary exception**;
the `/provider` command and the guide's "Add a model provider" share one `runProviderSetup` (one
set of deps, one catalog tail), and Onboarding receives two callback props.

**Why progress lives in a module store**: question and approval panels share one interrupt lane
with full-screen surfaces — while a panel is pending the screen is unmounted and **remounted**
afterwards (Chat's `interruptPanel && screenOpen` branch; `screenOpen` includes
`onboardingOpen`). The access flow uses the panel (API-key entry, OAuth device codes / authorize
URLs), so the wizard's React state is lost during the takeover. `src/onboardingDraft.ts` therefore
stores the current step, focus (row and action id), the pre-action catalog baseline, the action in
flight, its completion, and one notice line; it is read on mount, written on change, and cleared
on finish/skip. It is in-process only and never serialized.

### 3.2 State machine (step 1)

```
            ┌─────────────┐
  mount  ──▶│  checking   │  describeCredential + oauthProviderStatuses + listModels/listProviders
            └──────┬──────┘
                   ▼
            ┌─────────────┐   action ❯ Sign in to a subscription (providers, signed-in or not)
            │   ready     │   action   Add a model provider (API key) → the /provider wizard
            │ (action row)│   action   Check again / Skip this step (= next step)
            └──┬───┬───┬──┘
               │   │   └────── check again ──────▶ checking
   sign-in/key │   │
               ▼   │
        ┌──────────┴──┐   in flight: `pending` stays set; a mid-run remount restores progress and does **not** settle;
        │  in-flight  │   the sign-in / add-key rows refuse and show "in progress" (one action at a time)
        └──────┬──────┘
               ▼   the action ends: write `draft.completed` (added / changed / cancelled / failed,
        ┌─────────────┐   plus the newest notification the flow raised meanwhile)
        │  completed  │
        └──────┬──────┘
               ▼   settle: by the mounted instance; the subscription delivers a late completion to it
        ┌─────────────┐
        │  adopting   │  catalog diff: 0 → none (report only); 1 → auto; N → inline default pick (single choice + keep current); key route → report only
        └──────┬──────┘
               ▼
            ready (one result line: "Adopted X; default model set to Y", …)
```

Esc semantics are unchanged: at any point Esc skips the whole guide (without recording); inside
the access sub-flow, Esc is consumed by the panel/inline layer and returns to `ready`.

### 3.3 Data flow

**A. Subscription sign-in (OAuth)**

1. The first frame reads `channel.oauthProviderStatuses()`. When `dsh-auth` is not mounted
   (`undefined` or empty) the sign-in row is **not drawn** rather than pretending to work; likewise
   "Add a model provider" is not drawn without `providerSetup()`. The sign-in row's visibility
   and its execution use the same seam: Chat signs in through `providerSetup()?.oauth`, so the row
   is drawn only when that is present — a composition with dsh-auth but without the `/provider`
   host services gets no dead row that reports "not mounted" when clicked, and the fallback only
   says "subscription sign-in is not available in this composition" without guessing which plugin
   is missing. The sign-in status is re-read on "check again", when the account picker opens, and
   when the `oauth` seam appears after the first frame, so a late composition does not wait for
   the user to press "check again".
2. Enter on a row calls Chat's `onProviderSignIn(provider)` →
   `runOAuthLogin(deps, oauth, provider)` → the panel drives device codes / authorize URLs / the
   browser (`openInBrowser` in `src/dsh-adapter/oauth/opener.ts`; its win32 branch already handles
   cmd's `&` quoting). An already signed-in account offers re-login / sign out / cancel.
3. The login writes dsh-auth's own credential file; the **next `listModels()`** already shows
   that provider's models (`CredentialGatedAdapter` re-reads the credential per call).
4. Settling diffs the catalog (3.4).

**B. API key (the `/provider` wizard)**

1. The action row calls Chat's `runProviderSetup()` → `runProviderWizard(...)`, exactly like
   `/provider`.
2. The wizard asks route/endpoint/protocol/key/model multi-select itself and **writes the
   credential first, then the profile, rolling back on failure**. Its model multi-select *is* the
   "add?" question for key routes.
3. After the write the wizard asks "Switch to which model from the new provider?": every enabled
   model is listed, followed by "Keep the current model" (its description names the current
   model). With several models the user names the default explicitly instead of always getting the
   first one. Enabling a built-in catalog whole (no model ticked) asks nothing and points at
   `/model` instead.
4. Back in the guide it only reports (how many models were added, which model is the default): the
   wizard already asked what to enable and whether to switch, and wrote the answers, so the guide
   does not enter `adopting` or touch the default (see 3.5).

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
comment in `onboardingModel.ts`). The three paths persist different things, so the copy must
match:

| Path | What is persisted | Copy in the guide |
| --- | --- | --- |
| OAuth sign-in | the provider credential (the plugin's own store); models are **usable as soon as you are signed in** (gated catalog) | one: "Adopted X; default model set to Y"; several: the default picker "X brought in N models", then the same line |
| `/provider` key route | the route profile (including the selected `models`) + the credential ref; the model picked on the switch question | "Added N models from X; default model: Y" |
| Default model | `channel.switchModel(provider, id)` → `~/.dsh-tui/model.json` (`src/dsh-adapter/channel/model-switch.ts`) | "Default model: Y" |

So the "add?" question becomes:
- key routes: answered by `/provider`'s own model multi-select and switch question (real
  persistence) — the guide does not ask twice;
- OAuth: **no pretend enable list**. Once signed in, every one of those models is usable, and
  `/model` and step 3 read the whole catalog; nothing stores "which ones were adopted", so a
  multi-select would only make the user believe they had filtered something. With N>1 the guide
  therefore asks only which one becomes the default (a single choice, ending in "Keep the current
  model"); with exactly one, nothing is asked and it is defaulted directly.

Step 1's credential row and balance check cover the DeepSeek official API only (`balanceInfo`
reads `DEEPSEEK_API_KEY` and nothing else). When some other access already works — a signed-in
subscription account, or a `/provider` route whose key is actually stored — a missing DeepSeek
key is not drawn as a failure: the credential row becomes "DEEPSEEK_API_KEY is not set (only the
DeepSeek official API needs it)", the balance check becomes "Skipped the DeepSeek balance check;
connected: …", and the manual-setup fallback is folded away. Someone who just signed in or just
added a provider must not be told there is "no usable credential".

A sign-out, a route edit or a route delete can also come out of these two actions (picking a
signed-in account on the sign-in row, "Edit" in `/provider`). They are not adds, so settling
reports the flow's own line ("Signed out of …", "Deleted …") instead of "no new models".

### 3.6 Relationship to step 3 (model / effort / workspace)

- Settling makes step 3 re-read models and providers (`catalogNonce`), and the default model is
  persisted by `switchModel`, so the current model step 3 shows is the one step 1 settled — no
  second picking pass.
- Step 3 itself is unchanged: the same full catalog, and an empty catalog points at `/provider`.

## 4. Failure, rollback, idempotence

- **Failure causes stay visible**: both flows report causes only through `channel.notify`
  (write failed, sign-in failed, invalid route id, OAuth unmounted, …), and the full-screen guide
  covers the notification bar. The runner records the id of the last notification before
  `start()` and, when the action ends, writes the newest one after it into `completed.notice`;
  settling shows "That configuration did not complete: <cause>", and the generic copy only when no
  new notification arrived. A notification that was already there before the run does not count.
  The notice line carries a tone — success for results, warning for a cancel or "nothing new",
  error for a failure — and the tone is stored in the draft with the text, so a remount never
  repaints a failure in the success colour.
- **Sign-in fails/cancels**: `runOAuthLogin` already normalizes `UserQuestionError` to
  `'cancelled'` and everything else to `'failed'` with a notification. Cancel/failure reads no
  catalog and returns to the action layer.
- **Credential writes**: the guide never writes credentials itself; `/provider`'s rollback
  semantics (credential first, profile second, restore the old key when the profile write fails)
  are preserved untouched.
- **Repeated adoption**: the baseline lives in the draft, so a remount keeps the same baseline
  and the same batch is never asked about twice.
- **Action ownership**: `runProviderAction` registers ownership **before** reading the baseline
  (`await channel.listModels()`); `finish()`, unmounting and starting a new action all void it.
  When the catalog comes back ownership is checked first, and a voided action neither writes the
  draft nor calls `start()` — otherwise a late read would resurrect a cleared draft and finish a
  sign-in for a user who already left.
- **Action id**: `pending` carries a monotonic id. Closing the guide does not cancel the provider
  flow, so a leftover promise can finish after the user reopened `/setup` and started a NEW action;
  writing its `completed` unconditionally would overwrite that action's `pending`. The completion
  is written only when `draft.pending.id` is our own.
- **Settle ordering**: `pending` covers the WHOLE run and `completed` is written only when the
  action ends; settling requires `completed`. The question panel can close *between* two questions
  (model discovery and the profile write happen there), so the guide remounts while the catalog
  has not changed — settling then would read the old catalog and drop the result. The runner
  writes `completed` even when it has been unmounted (skipped if the guide was closed), and the
  mounted instance is notified through `subscribeOnboardingDraft`; an unmounted instance never
  settles. Mount, subscription and the promise callback together settle exactly once (`completed`
  is cleared synchronously first).
- **Refresh after settling**: settling and the default write both re-read credentials / sign-in
  state / connectivity, so a provider just signed in no longer reads "not signed in"; a late
  `switchModel` after the guide closed changes no state and leaves no notice for the next
  `/setup`.
- **Write failure**: a false `switchModel` reports the same
  `onboarding-model-switch-failed` message rather than failing silently.

## 5. Keyboard, mouse, Esc

- Step 1's action rows are `ListItem`s (existing hover/click contract): ↑/↓ move focus, Enter
  triggers. The list grows asynchronously ("check again / skip" first, "sign in / add key" once
  the status read lands), so focus is tracked and restored by **action id**, not by index.
- The inline default picker (N branch) is the guide's own modal layer and is a single choice:
  `↑`/`↓` move, `Enter` writes the focused row as the default model; the last row, "Keep the
  current model" (with the current model's name), leaves the default alone, and `Esc` means the
  same (it pops one layer, it does not close the guide). Focus starts on the preselection (the
  live route when it is among the new models, else the first new model). It has the shape of
  `/provider`'s "Switch to X / Keep the current model" question and is isomorphic to the existing
  workspace modal.
- The list is windowed with `listWindow`: there can be dozens of models, and the focused row must
  stay inside the viewport, or Enter becomes a blind action; "Keep the current model" sits outside
  the window.
- A mouse click and Enter share one landing (`applyAdoption`): clicking a model row makes it the
  default, clicking "Keep the current model" leaves the default alone.
- Global Esc still skips the guide; `Ctrl+C` is synonymous.
- The bottom hint line follows the current sub-state instead of one hard-coded sentence.

## 6. Gate and contract impact

- **No port change**: no new `ChannelUi` method → `src/adapter/channel/ui-policy.ts`,
  `scripts/verify-adapter-ports.*` and `verify-adapter-effect-class.*` stay as they are.
- **No new boundary exception**: Onboarding has only `import type` from `src/dsh-adapter/`;
  Chat's `providerWizard.js` import line only gains `type ProviderWizardOutcome`.
  `ProviderWizardDeps` gains an optional `currentModel` (the switch question's "Keep the current
  model" row names it).
- **i18n**: new keys need both zh and en and a literal reference in `src/` or `scripts/`
  (`scripts/verify-i18n.ts` dead-key/completeness checks); no new `DYNAMIC_PREFIXES`.
- **Regressions**: see section 7; the fake channel in
  `scripts/verify-launchpad-onboarding-chat.tsx` has no `oauthProviderStatuses`, so new reads of
  optional seams go through optional chaining.

## 7. Tests

1. `scripts/verify-onboarding-provider-plan.ts` (pure, no React): the three branches, idempotent
   repeated diffs, `defaultPick` preferring the live route, provider filtering.
2. `scripts/verify-onboarding-wizard.tsx` (real Ink + headless xterm, fake channel + fake action
   callbacks):
   - action rows follow the seams, and the fallback no longer mentions `~/.deepseek/config.json`;
   - the 0/1/N branches; the N branch is a single choice that never reports "adopted N models",
     "Keep the current model" calls no `switchModel`, and mouse and keyboard land the same way
     (J4/J8/J10);
   - the draft: step and focus survive an unmount-remount, no early settle during a panel
     takeover, a late completion settles exactly once, and an old run never overwrites a new one;
   - adding a key only reports and never overrides the wizard's choice (J13);
   - failure causes and sign-out/delete results are visible inside the guide (J14/J15);
   - after closing, a late catalog read starts no sign-in and writes no draft, and with two
     blocked catalog reads the old run is voided (J16/J17);
   - at 80×24 with 30 new models, the default picker's focused row and "Keep the current model"
     stay in the viewport (J18);
   - with a signed-in subscription or a keyed route, a missing DeepSeek key is not reported as
     "no usable credential" (J19/J20);
   - the sign-in row uses the execution seam, and a late dsh-auth needs no "check again" (J21);
   - failure, cancel and success notices carry three tones, in the draft as well (J22);
   - while one action runs, sign-in / add-key cannot start a second one, also after a remount, and
     the first action's result still settles (J23).
3. `scripts/verify-provider-wizard.mjs`: the switch question lists every enabled model and ends
   with "Keep the current model", and picking the second switches to the second (3b).
4. `scripts/verify-i18n.ts` and `scripts/verify-launchpad-onboarding-chat.tsx` (Chat
   integration: `/setup`, Esc accounting, model/effort/workspace).

`verify-i18n` runs in the `verify:build` gate chain; the other scripts are registered in
`scripts/run-ci-group.mjs`.

## 8. Compatibility and migration

- **`ONBOARDING_VERSION` is not bumped**: per `src/onboardingPrefs.ts` only an **added step**
  bumps it. This is a capability upgrade inside the same steps (step 1 changes meaning), and
  re-running the guide on every existing install is not wanted. If "accounts and models" later
  becomes a fifth step, bump then.
- **DSH version line**: `describeCredential` / `providerSetup()` / `oauthProviderStatuses()` are
  existing optional seams (absent ⇒ degrade), so on a 0.1.x host step 1 falls back to
  "status + environment-variable hints" without crashing.
- **Hosts without `dsh-auth`**: the sign-in row is not drawn; the `/provider` key path still
  works.

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
    sections** and the generic `/settings` secret write (`settings-host.ts`); `/provider`'s write
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
