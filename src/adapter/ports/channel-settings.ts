/** Host-owned in-process Channel contract. No runtime or upstream imports. */
import type { LlmDiscoveredModel } from './channel-view.js'
import type { LocalizedDescriptions } from './channel-catalog.js'

/**
 * Runtime capabilities the wizard needs, implemented by the channel over
 * `ctx.settings` / `ctx.credentials` / `ctx.llm`. `undefined` from
 * `channel.providerSetup()` means the bare cordis.yml start (no dsh-base
 * services) and the command refuses to run.
 */
export interface ProviderSetupHost {
  /** Catalog routes activatable via the `llm-pi-ai` settings section. */
  listCatalogProviders(): readonly CatalogProviderCandidate[]
  /**
   * The editable/deletable set: provider profiles the user layer itself
   * carries. Profiles inherited from the composition base are deliberately
   * absent — an unset only clears the user layer, so listing an inherited
   * route would promise a delete that silently reverts to the base value.
   */
  listConfiguredProviders(): readonly ConfiguredProvider[]
  /**
   * Routes whose stored profile names `ref` as `apiKeyEnv` at ANY settings
   * layer (user + inherited base), minus `exceptRoute`. Credential-impact
   * decisions (delete cleanup, shared-key confirm) must go through this,
   * never through {@link listConfiguredProviders}: that lists the user
   * layer only (a deletable set), so a base provider or a composition-base
   * route sharing the ref would be invisible and its key destroyed.
   */
  listRefUsers(ref: string, exceptRoute?: string): readonly string[]
  /** Whether a profile (any layer) already exists for the route. */
  routeExists(route: string): boolean
  /** Interrogate a draft endpoint; the draft key is never persisted. */
  discoverModels(request: {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }): Promise<readonly LlmDiscoveredModel[]>
  /** Whether the process environment already provides this ref (shadow). */
  envShadows(ref: string): boolean
  /** The process-environment value for a shadowed ref; undefined when absent. */
  envValue(ref: string): string | undefined
  /**
   * Read the currently stored value for rollback purposes; undefined when no
   * credential exists under the ref. Only called when {@link envShadows} is
   * false, so the value comes from a writable/seeded store, never the env.
   */
  readCredential(ref: string): Promise<string | undefined>
  /** Persist the key under the ref; rejects when env-shadowed or invalid. */
  writeCredential(ref: string, value: string): void | Promise<void>
  /** Best-effort rollback of a just-written credential. */
  removeCredential(ref: string): void | Promise<void>
  /**
   * Persist the provider profile under `llm-pi-ai.providers.<route>`;
   * rejects when the adapter's validation deems it unserviceable. Used by
   * the add flow, where a whole-profile write is the intent.
   */
  writeProfile(route: string, profile: Record<string, unknown>): Promise<void>
  /**
   * Apply targeted path ops inside `llm-pi-ai.providers.<route>`. Edits go
   * through here, never through {@link writeProfile}: replacing the whole
   * object would silently drop every field the wizard does not model
   * (`headers`, `timeoutMs`, `retryPolicy`, `displayName`, …). Paths are
   * relative to the profile object, so `['baseURL']` patches exactly the
   * one item the user picked; unknown fields stay untouched by omission.
   */
  mutateProfile(route: string, ops: readonly ProfilePathOp[]): Promise<void>
  /** Unset the profile under `llm-pi-ai.providers.<route>`. */
  removeProfile(route: string): Promise<void>
  /** The OAuth sign-in surface; absent when no dsh-auth-style plugin is mounted. */
  readonly oauth?: OAuthSetupHost
}

/** One catalog route the mounted adapters offer for activation. */
export interface CatalogProviderCandidate {
  readonly provider: string
  readonly displayName: string
}

/**
 * One user-added provider route read from the settings section. The parsed
 * fields drive the edit/delete picker rows, the catalog/custom split
 * (`isCatalog`) and the key-keep question (`ref` + `shadowed`).
 */
export interface ConfiguredProvider {
  readonly route: string
  /** Credential ref (profile.apiKeyEnv) when the profile names one. */
  readonly ref: string
  /** Whether the process environment shadows the ref (env-provided key). */
  readonly shadowed: boolean
  /**
   * Whether the route belongs to the installed catalog — real membership
   * as the llm adapter reports it, never inferred from the profile shape:
   * a catalog profile may carry an explicit `api` override and still be a
   * catalog route.
   */
  readonly isCatalog: boolean
  /** baseURL when the profile sets one. */
  readonly baseURL?: string
  /** Explicit `api` override in the stored profile; catalog routes can
   *  carry one too, so this alone does not classify the route. */
  readonly api?: string
  /** Enabled model ids; undefined means the whole catalog stays served. */
  readonly models?: readonly string[]
  /**
   * Raw `profile.models` entries (plain objects, in order) as stored. A
   * targeted model-list rewrite reuses these for kept ids so fields the
   * wizard never learned about (`input`, `compat`, …) survive the edit.
   */
  readonly modelEntries?: readonly Record<string, unknown>[]
}

/** One path op inside a provider profile, relative to the profile object. */
export type ProfilePathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/**
 * The `ctx.dshAuth` api, structural so this tree never imports the plugin:
 * mounting dsh-auth (or anything exporting this shape) lights up the wizard's
 * OAuth branch; absent it, the wizard behaves exactly as before.
 */
export interface OAuthSetupHost {
  providers(): Promise<readonly OAuthProviderStatus[]>
  login(provider?: string, signal?: AbortSignal): Promise<OAuthLoginResult>
  logout(provider: string): Promise<boolean>
}

/** One OAuth-capable provider a dsh-auth-style plugin mounts (masked state only). */
export interface OAuthProviderStatus {
  readonly provider: string
  readonly label: string
  readonly oauthLabel: string
  readonly loginLabel: string | undefined
  readonly signedIn: boolean
  readonly expiresAt: number | undefined
  readonly expired: boolean
}

/** One successful OAuth login. */
export interface OAuthLoginResult {
  readonly provider: string
  readonly oauthLabel: string
  readonly expiresAt: number
}

/**
 * Runtime capabilities the settings screen needs, implemented by the channel
 * over the dsh `settings` / `credentials` seams. `undefined` from
 * `channel.settingsHost()` means the composition lacks them (bare cordis.yml
 * start) and the screen shows namespaces read-only.
 */
export interface SettingsHost {
  /** Every registered namespace, secrets redacted, in registration order. */
  listNamespaces(): readonly SettingsNamespaceView[]
  /** Write path ops against a namespace, fenced by its current revision. */
  write(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  /** Whether any layer supplies a credential under `ref`. */
  credentialConfigured(ref: string): Promise<boolean>
  /** Persist a credential; rejects when env-shadowed or the store is read-only. */
  writeCredential(ref: string, value: string): Promise<void>
}

/** One settings namespace as the screen reads it (secrets redacted). */
export interface SettingsNamespaceView {
  readonly ns: string
  /** Monotonic revision of the raw user section; fences writes. */
  readonly revision: number
  /** 'live' applies immediately; 'restart' needs a relaunch. */
  readonly applies: 'live' | 'restart'
  /** Current resolved value (all layers composed). */
  readonly value: unknown
  /** Raw user layer; a path present here is a user override. */
  readonly user: unknown
}

export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** One plugin's section inside the TUI settings screen. */
export interface TuiSettingsSection {
  /**
   * Settings namespace this section edits. Should match a namespace the
   * plugin registers on the dsh settings service; the screen marks the
   * section unavailable when the composition serves no such namespace.
   */
  ns: string
  /** Section title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: LocalizedDescriptions
  /** Optional navigation groups, in display order. */
  groups?: readonly TuiSettingsGroup[]
  /** Editable fields, in display order. */
  fields: readonly TuiSettingsField[]
}

/** Optional navigation group inside one settings section. */
export interface TuiSettingsGroup {
  /** Stable identifier, unique inside the section. */
  id: string
  /** Group title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: LocalizedDescriptions
}

export interface TuiSettingsField {
  /**
   * Key path from the section root, in the settings service's `mutate` path
   * vocabulary (object keys; dict keys name their entry directly).
   */
  path: readonly string[]
  /** Short field label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: LocalizedDescriptions
  /** Optional one-line help rendered under the field. */
  hint?: string
  /** Provider-owned translations for the hint. */
  hintDescriptions?: LocalizedDescriptions
  /** Optional group id; grouped fields render on that group's subpage. */
  group?: string
  kind: TuiSettingsFieldKind
  /**
   * Choices for `kind: 'select'`; any options-bearing field (text hybrids
   * included — e.g. the page-margin presets) also cycles via ←/→ in the
   * settings list while Enter keeps the kind's own action (select cycles,
   * text opens the editor for a custom value).
   */
  options?: readonly TuiSettingsFieldOption[]
  /** Input placeholder for `kind: 'text' | 'number'`. */
  placeholder?: string
  /**
   * Credential control (mirrors the web cards' CardSecretSpec): the literal
   * never rides the settings document — the draft starts blank on every
   * open, a blank draft writes nothing, and a typed draft writes through the
   * credentials seam under `ref`. The screen shows only whether a value is
   * configured.
   */
  secret?: { ref: string }
  /**
   * Render a stored value as draft text. Defaults to the kind's conversion
   * (strings verbatim, numbers via `String`, booleans/selects by value).
   */
  format?(value: unknown): string
  /**
   * The write this draft text stages, or `undefined` when the text is not a
   * value this field accepts — an invalid draft blocks the save rather than
   * being discarded. Defaults to the kind's conversion (an empty text/number
   * draft stages a clear, letting the field re-inherit the composition
   * layer).
   */
  parse?(text: string): TuiSettingsFieldWrite | undefined
}

/** Control kinds the TUI settings screen knows how to render. */
export type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

export interface TuiSettingsFieldOption {
  /** Stored value. */
  value: string
  /** Display label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: LocalizedDescriptions
}

/** The write one field's draft stages when the section is saved. */
export type TuiSettingsFieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }
