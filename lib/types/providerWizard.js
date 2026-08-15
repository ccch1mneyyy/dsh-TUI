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
import { t } from './i18n.js';
import { UserQuestionError, } from '@deepseek-ai/dsh-user-questions';
/** Route id rule shared with the dsh configuration surface (web Models page). */
export const PROVIDER_ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Wire protocols dsh-llm-pi-ai can serve on a manually declared route. */
export const PROVIDER_PROTOCOLS = [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
];
/**
 * Derive the credential ref for a route, matching the official web UI
 * convention so TUI- and web-added providers resolve the same key.
 */
export function deriveKeyRef(route) {
    return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}
/** Max attempts for validated free-text prompts before giving up. */
const MAX_RETRY = 3;
function answerText(answer, id) {
    return answer.answers.find(item => item.id === id)?.custom?.trim() ?? '';
}
function answerSelected(answer, id) {
    return answer.answers.find(item => item.id === id)?.selected ?? [];
}
function optionQuestion(id, question, options, extra) {
    const item = {
        id,
        question,
        header: '/provider',
        options: options.map(option => ({ ...option })),
        ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
        ...(extra?.multiSelect ? { multiSelect: true } : {}),
        ...(extra?.hideCustomInput ? { hideCustomInput: true } : {}),
    };
    return item;
}
function textQuestion(id, question, detail) {
    return {
        id,
        question,
        header: '/provider',
        ...(detail !== undefined ? { detail } : {}),
    };
}
/**
 * Run the add-provider wizard. Resolves 'cancelled' when the user dismisses
 * any question (Esc) — nothing has been written at that point by design:
 * all asks complete before the first side effect.
 */
export async function runProviderWizard(deps) {
    const { host, ask, notify, pushLocal } = deps;
    try {
        // ── 1. mode ────────────────────────────────────────────────────────
        const modeAnswer = await ask({
            questions: [optionQuestion('mode', t('provider-q-mode'), [
                    { label: t('provider-opt-catalog'), description: t('provider-opt-catalog-desc') },
                    { label: t('provider-opt-custom'), description: t('provider-opt-custom-desc') },
                ], { hideCustomInput: true })],
        });
        const isCatalog = answerSelected(modeAnswer, 'mode')[0] === t('provider-opt-catalog');
        // ── 2. route ───────────────────────────────────────────────────────
        let route = '';
        if (isCatalog) {
            const candidates = host.listCatalogProviders();
            if (candidates.length > 0) {
                const otherLabel = t('provider-opt-other-route');
                const catalogAnswer = await ask({
                    questions: [optionQuestion('catalog', t('provider-q-catalog'), [
                            ...candidates.map(candidate => ({
                                label: candidate.provider,
                                description: candidate.displayName,
                            })),
                            { label: otherLabel, description: t('provider-opt-other-route-desc') },
                        ], { hideCustomInput: true })],
                });
                const pick = answerSelected(catalogAnswer, 'catalog')[0];
                if (pick !== undefined && pick !== otherLabel)
                    route = pick;
            }
        }
        if (route === '') {
            route = await promptRouteId(ask, notify);
            if (route === '')
                return 'cancelled';
        }
        // ── 3. API key (own batch so redact covers exactly the secret) ─────
        const keyAnswer = await ask({
            questions: [textQuestion('apikey', t('provider-q-apikey'), t('provider-q-apikey-detail'))],
        }, { redact: true });
        const apiKey = answerText(keyAnswer, 'apikey');
        // ── 4. endpoint / protocol ─────────────────────────────────────────
        let baseURL;
        let api;
        if (isCatalog) {
            const choiceAnswer = await ask({
                questions: [optionQuestion('baseurl-choice', t('provider-q-baseurl-choice'), [
                        { label: t('provider-opt-baseurl-skip') },
                        { label: t('provider-opt-baseurl-input') },
                    ], { hideCustomInput: true })],
            });
            if (answerSelected(choiceAnswer, 'baseurl-choice')[0] === t('provider-opt-baseurl-input')) {
                const urlAnswer = await ask({
                    questions: [textQuestion('baseurl', t('provider-q-baseurl'))],
                });
                baseURL = answerText(urlAnswer, 'baseurl');
            }
        }
        else {
            const endpointAnswer = await ask({
                questions: [
                    textQuestion('baseurl', t('provider-q-baseurl')),
                    optionQuestion('protocol', t('provider-q-protocol'), [
                        { label: 'openai-completions', description: t('provider-protocol-completions-desc') },
                        { label: 'openai-responses', description: t('provider-protocol-responses-desc') },
                        { label: 'anthropic-messages', description: t('provider-protocol-anthropic-desc') },
                    ], { hideCustomInput: true }),
                ],
            });
            baseURL = answerText(endpointAnswer, 'baseurl');
            api = answerSelected(endpointAnswer, 'protocol')[0];
        }
        // ── 5. model discovery (draft credential, nothing persisted) ───────
        notify(t('provider-discovery-running'));
        const discovered = await host.discoverModels({
            ...(isCatalog ? { provider: route } : {}),
            ...(baseURL !== undefined && baseURL !== '' ? { baseURL } : {}),
            ...(api !== undefined ? { api } : {}),
            apiKey,
        }).catch(() => []);
        // ── 6. model selection ─────────────────────────────────────────────
        let models = [];
        let discoveredById = new Map();
        if (discovered.length > 0) {
            discoveredById = new Map(discovered.map(model => [model.id, model]));
            const modelsAnswer = await ask({
                questions: [optionQuestion('models', t('provider-q-models'), discovered.map(model => ({
                        label: model.id,
                        description: [
                            model.name ?? '',
                            model.contextWindow !== undefined ? `${model.contextWindow}` : '',
                        ].filter(part => part !== '').join(' · ') || undefined,
                    })), { multiSelect: true })],
            });
            models = mergeModelIds(answerSelected(modelsAnswer, 'models'), answerText(modelsAnswer, 'models'));
        }
        else {
            notify(t('provider-discovery-failed'), { color: 'warning' });
            for (let attempt = 0; attempt < MAX_RETRY && models.length === 0; attempt += 1) {
                const fallbackAnswer = await ask({
                    questions: [textQuestion('models-fallback', t('provider-q-models-fallback'))],
                });
                models = mergeModelIds([], answerText(fallbackAnswer, 'models-fallback'));
                if (models.length === 0)
                    notify(t('provider-models-required'), { color: 'warning' });
            }
            if (models.length === 0)
                return 'cancelled';
        }
        if (!isCatalog && models.length === 0) {
            // A manual route without models fails the adapter validation; the
            // loops above should prevent this, but guard before writing.
            notify(t('provider-models-required'), { color: 'error' });
            return 'cancelled';
        }
        // ── 7. confirm ─────────────────────────────────────────────────────
        const ref = deriveKeyRef(route);
        const shadowed = host.envShadows(ref);
        const summaryLines = buildSummaryLines({
            route, ref, shadowed, baseURL, api, models, isCatalog,
        });
        const detail = host.routeExists(route)
            ? `${summaryLines.join('\n')}\n${t('provider-route-exists-warning')}`
            : summaryLines.join('\n');
        const confirmAnswer = await ask({
            questions: [optionQuestion('confirm', t('provider-q-confirm'), [
                    { label: t('provider-opt-confirm-write') },
                    { label: t('provider-opt-confirm-cancel') },
                ], { detail, hideCustomInput: true })],
        });
        if (answerSelected(confirmAnswer, 'confirm')[0] !== t('provider-opt-confirm-write')) {
            notify(t('provider-cancelled'));
            return 'cancelled';
        }
        // ── 8. persist: credential first (rollbackable), then the profile ──
        let wroteCredential = false;
        let previousCredential;
        if (!shadowed) {
            // Capture any pre-existing value BEFORE overwriting: when the profile
            // write below fails, rollback must restore it — an unconditional unset
            // would destroy the old key of the route being overwritten.
            previousCredential = await host.readCredential(ref);
            await host.writeCredential(ref, apiKey);
            wroteCredential = true;
        }
        const profile = buildProfile({ isCatalog, ref, baseURL, api, models, discoveredById });
        try {
            await host.writeProfile(route, profile);
        }
        catch (error) {
            if (wroteCredential) {
                try {
                    if (previousCredential !== undefined) {
                        await host.writeCredential(ref, previousCredential);
                    }
                    else {
                        await host.removeCredential(ref);
                    }
                    notify(t('provider-rollback-ok'));
                }
                catch {
                    notify(t('provider-rollback-failed'), { color: 'warning' });
                }
            }
            const err = error instanceof Error ? error.message : String(error);
            notify(t('provider-write-failed', { err }), { color: 'error', timeoutMs: 8000 });
            return 'failed';
        }
        // ── 9. success: transcript summary + optional live switch ──────────
        pushLocal('/provider', [
            ...summaryLines,
            ...(deps.working() || models.length === 0
                ? [t('provider-switch-hint')]
                : []),
        ]);
        notify(t('provider-success', { route }), { color: 'success' });
        if (!deps.working() && models.length > 0) {
            const target = models[0];
            const switchAnswer = await ask({
                questions: [optionQuestion('switch', t('provider-q-switch'), [
                        { label: t('provider-opt-switch-now', { model: target }) },
                        { label: t('provider-opt-switch-keep') },
                    ], { hideCustomInput: true })],
            });
            if (answerSelected(switchAnswer, 'switch')[0] === t('provider-opt-switch-now', { model: target })) {
                await deps.switchModel(route, target);
            }
        }
        return 'added';
    }
    catch (error) {
        if (error instanceof UserQuestionError) {
            notify(t('provider-cancelled'));
            return 'cancelled';
        }
        const err = error instanceof Error ? error.message : String(error);
        notify(t('provider-write-failed', { err }), { color: 'error', timeoutMs: 8000 });
        return 'failed';
    }
}
/** Prompt for a route id until it validates or the retry budget runs out. */
async function promptRouteId(ask, notify) {
    for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
        const answer = await ask({
            questions: [textQuestion('route-id', t('provider-q-route-id'), t('provider-q-route-id-detail'))],
        });
        const route = answerText(answer, 'route-id');
        if (PROVIDER_ROUTE_ID.test(route))
            return route;
        notify(t('provider-route-id-invalid'), { color: 'warning' });
    }
    return '';
}
/** Merge multi-select picks with comma/space-separated custom input, deduped. */
function mergeModelIds(selected, custom) {
    const ids = [...selected];
    for (const piece of custom.split(/[,，\s]+/)) {
        const id = piece.trim();
        if (id !== '' && !ids.includes(id))
            ids.push(id);
    }
    return ids;
}
function buildSummaryLines(input) {
    const lines = [t('provider-line-route', { route: input.route })];
    lines.push(input.shadowed
        ? t('provider-line-keyref-env', { ref: input.ref })
        : t('provider-line-keyref', { ref: input.ref }));
    if (input.baseURL !== undefined && input.baseURL !== '') {
        lines.push(t('provider-line-baseurl', { url: input.baseURL }));
    }
    if (input.api !== undefined)
        lines.push(t('provider-line-protocol', { api: input.api }));
    lines.push(input.models.length > 0
        ? t('provider-line-models', { models: input.models.join(', ') })
        : t('provider-line-models-catalog'));
    return lines;
}
function buildProfile(input) {
    const profile = { apiKeyEnv: input.ref };
    if (input.baseURL !== undefined && input.baseURL !== '')
        profile['baseURL'] = input.baseURL;
    if (input.isCatalog) {
        // `models` replaces the catalog when present; omit it to keep the whole
        // catalog served.
        if (input.models.length > 0) {
            profile['models'] = input.models.map(id => ({ id }));
        }
        return profile;
    }
    profile['api'] = input.api;
    profile['models'] = input.models.map(id => {
        const discovered = input.discoveredById.get(id);
        return {
            id,
            ...(discovered?.contextWindow !== undefined
                ? { contextWindow: discovered.contextWindow }
                : {}),
            ...(discovered?.maxTokens !== undefined
                ? { maxTokens: discovered.maxTokens }
                : {}),
        };
    });
    return profile;
}
