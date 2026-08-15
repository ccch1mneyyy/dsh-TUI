/**
 * `/provider` wizard — interactively adds an LLM provider route at runtime.
 *
 * The wizard is a sequence of `QuestionStore` asks (the same panel the
 * model-facing `ask_user_question` tool uses), so it needs no UI state of
 * its own. All side effects go through {@link ProviderSetupHost}, which the
 * channel implements over the dsh settings/credentials/llm seams:
 *
 *   profile → settings `llm-pi-ai.providers.<route>` (dsh-llm-pi-ai watches
 *             the section and registers the route without a restart)
 *   key     → credentials store (`~/.dsh/.credentials.yaml`, 0600), named by
 *             the derived `<ROUTE>_API_KEY` env-style ref the profile's
 *             `apiKeyEnv` points at
 *
 * The module is React-free so `scripts/verify-provider-wizard.mjs` can drive
 * it headless with a stubbed host and scripted answers.
 */
import { type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm';
/** Route id rule shared with the dsh configuration surface (web Models page). */
export declare const PROVIDER_ROUTE_ID: RegExp;
/** Wire protocols dsh-llm-pi-ai can serve on a manually declared route. */
export declare const PROVIDER_PROTOCOLS: readonly ["openai-completions", "openai-responses", "anthropic-messages"];
/**
 * Derive the credential ref for a route, matching the official web UI
 * convention so TUI- and web-added providers resolve the same key.
 */
export declare function deriveKeyRef(route: string): string;
/** One catalog route the mounted adapters offer for activation. */
export interface CatalogProviderCandidate {
    readonly provider: string;
    readonly displayName: string;
}
/**
 * Runtime capabilities the wizard needs, implemented by the channel over
 * `ctx.settings` / `ctx.credentials` / `ctx.llm`. `undefined` from
 * `channel.providerSetup()` means the bare cordis.yml start (no dsh-base
 * services) and the command refuses to run.
 */
export interface ProviderSetupHost {
    /** Catalog routes activatable via the `llm-pi-ai` settings section. */
    listCatalogProviders(): readonly CatalogProviderCandidate[];
    /** Whether a profile (any layer) already exists for the route. */
    routeExists(route: string): boolean;
    /** Interrogate a draft endpoint; the draft key is never persisted. */
    discoverModels(request: {
        provider?: string;
        baseURL?: string;
        api?: string;
        apiKey?: string;
    }): Promise<readonly LlmDiscoveredModel[]>;
    /** Whether the process environment already provides this ref (shadow). */
    envShadows(ref: string): boolean;
    /**
     * Read the currently stored value for rollback purposes; undefined when no
     * credential exists under the ref. Only called when {@link envShadows} is
     * false, so the value comes from a writable/seeded store, never the env.
     */
    readCredential(ref: string): Promise<string | undefined>;
    /** Persist the key under the ref; rejects when env-shadowed or invalid. */
    writeCredential(ref: string, value: string): void | Promise<void>;
    /** Best-effort rollback of a just-written credential. */
    removeCredential(ref: string): void | Promise<void>;
    /**
     * Persist the provider profile under `llm-pi-ai.providers.<route>`;
     * rejects when the adapter's validation deems it unserviceable.
     */
    writeProfile(route: string, profile: Record<string, unknown>): Promise<void>;
}
export interface ProviderWizardDeps {
    readonly host: ProviderSetupHost;
    readonly ask: (request: AskUserQuestionRequest, options?: {
        redact?: boolean;
    }) => Promise<AskUserQuestionAnswer>;
    readonly notify: (text: string, options?: {
        color?: 'error' | 'warning' | 'success';
        timeoutMs?: number;
    }) => void;
    readonly pushLocal: (title: string, lines: readonly string[]) => void;
    /** Live turn state; the model-switch question is skipped while working. */
    readonly working: () => boolean;
    readonly switchModel: (provider: string, model: string) => Promise<boolean>;
}
export type ProviderWizardOutcome = 'added' | 'cancelled' | 'failed';
/**
 * Run the add-provider wizard. Resolves 'cancelled' when the user dismisses
 * any question (Esc) — nothing has been written at that point by design:
 * all asks complete before the first side effect.
 */
export declare function runProviderWizard(deps: ProviderWizardDeps): Promise<ProviderWizardOutcome>;
//# sourceMappingURL=providerWizard.d.ts.map