import { randomUUID } from 'node:crypto';
import React from 'react';
import { SessionId } from '@deepseek-ai/dsh-session';
import UserQuestionService from '@deepseek-ai/dsh-user-questions';
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user';
import { createChannel } from './channel.js';
import { QuestionStore } from './questions.js';
import { registerPackagedSkills } from './packaged-skills.js';
import { readActivityFrames } from './activityPrefs.js';
import { readModelPref } from './modelPrefs.js';
import { readPresetPref } from './presetPrefs.js';
import { composePreset, resolvePersistedPreset, runningPresetOf } from './presets.js';
import { writeResumeTarget } from './sessionHistory.js';
import { checkForTuiUpdate, installedTuiVersion, isVersionNewer, resolveDshProfileName, resolveTuiUpdateTarget, updateTuiAndRestart } from './update.js';
import { isLang, resolveStartupLang, setLang, t } from './i18n.js';
import { Chat } from './screens/Chat.js';
import { render, ThemeProvider, AlternateScreen } from './ui.js';
/**
 * Claude Code style interactive TUI front door for DeepSeek Harness agents.
 *
 * The plugin attaches to (or creates) one agent, renders a chat transcript
 * from the agent's session log and live `session/event` records, and submits
 * user turns through `Agent.followup`. It is a client-driver front door like
 * `dsh-jsonrpc`: the surrounding `cordis.yml` supplies the agent spine, the
 * LLM adapter, and the tool plugins.
 */
export async function apply(ctx, config) {
    if (!process.stdout.isTTY) {
        throw new Error('cc-tui requires an interactive terminal (stdout must be a TTY).');
    }
    // UI language resolution: CC_TUI_LANG env var wins, then cordis.yml
    // `lang`, then the persisted `/lang` choice, then `zh`. Must settle
    // before the first render so every module resolves strings in the same
    // language.
    const envLang = process.env.CC_TUI_LANG;
    setLang(isLang(envLang) ? envLang : isLang(config.lang) ? config.lang : resolveStartupLang());
    // /update restart verification: the pre-update process stamps the version
    // it was leaving behind; if the freshly loaded one is not newer, the
    // package manager "succeeded" without actually moving the version (mirror
    // lag, cached manifest, wrong profile). Say so instead of silently
    // pretending the update landed.
    {
        const updatedFrom = process.env.DSH_CC_UPDATED_FROM;
        if (updatedFrom !== undefined) {
            // Assigning undefined would stringify to "undefined" and leak the
            // marker into every child process; remove it for real.
            delete process.env.DSH_CC_UPDATED_FROM;
            const now = installedTuiVersion();
            if (now === undefined || !isVersionNewer(now, updatedFrom)) {
                ctx.logger.warn(`cc-tui: /update restarted but the version did not advance (still ${now ?? 'unknown'}, was ${updatedFrom})`);
                if (process.stderr.isTTY) {
                    process.stderr.write(`\ncc-tui: 更新后版本未变化（仍为 ${now ?? 'unknown'}，原为 ${updatedFrom}）；` +
                        `可能是镜像 registry 未同步，请稍后重试或检查 registry 配置。\n`);
                }
            }
        }
    }
    // DSH user-interaction seam: the model's ask_user_question tool parks on
    // the userInteraction service until a UI provider answers. Mount the
    // service when the composition doesn't (the official dsh-base
    // user-interaction config row does; a bare plugin mount creates it on
    // this context), expose the model-facing tool, and register this TUI's
    // questionnaire as the provider. All three must be in place before the
    // agent is resolved so the per-step tool assembly includes
    // ask_user_question. Optional-service access goes through `ctx.get`, not
    // the inject proxy.
    const userQuestions = ctx.get('userQuestions') ?? new UserQuestionService(ctx);
    ctx.plugin(toolAskUser);
    const questionStore = new QuestionStore();
    // Packaged skills (/audit, /bug, …): contribute them through the host's
    // skill registry so they resolve with zero manual copying.
    registerPackagedSkills(ctx);
    userQuestions.registerProvider({
        ask: request => questionStore.ask(request),
    });
    ctx.effect(() => () => questionStore.rejectAll());
    // Config-only route: resolveAgent applies the persisted `/model`
    // preference on CREATE only — a resumed session keeps the route its own
    // log records (last request/header), matching the preset rule.
    const agentOptions = {
        provider: config.provider,
        model: config.model,
    };
    const meta = { cwd: config.cwd ?? process.cwd() };
    const { agent, handle, agentPreset } = await resolveAgent(ctx, config.sessionId, agentOptions, meta, config.preset);
    // Status-line route: cordis.yml explicit keys win over the persisted
    // `/model` choice, which wins over the harness defaults.
    const modelPref = readModelPref();
    const channel = createChannel(ctx, agent, {
        model: config.model ?? modelPref?.model ?? 'deepseek-v4-flash',
        cwd: config.cwd ?? process.cwd(),
        provider: config.provider ?? modelPref?.provider ?? 'deepseek-official',
        // Raw cordis.yml route (undefined when unset): the channel's
        // new-session path re-resolves prefs against these, and resume passes
        // only explicit values so the target session's own record wins.
        configuredModel: config.model,
        configuredProvider: config.provider,
        effort: config.effort,
        activity: config.activity,
        // Explicit cordis.yml value (static deployment choice) wins over the
        // runtime `/activity` preference, which wins over the default.
        activityFrames: config.activityFrames ?? readActivityFrames() ?? 'claude',
        // Static footer preference: cordis.yml `contextBar` (schema default on).
        contextBar: config.contextBar,
        // Same precedence for the agent preset: cordis.yml `preset` over the
        // persisted `/preset` choice; undefined adopts the roster default.
        configuredPreset: config.preset,
        agentPreset,
        handle,
    });
    // Single exit funnel: `/exit`, double Ctrl+C, and external teardown all
    // land here. unmount() restores the terminal (cursor, raw mode, mouse
    // tracking); the explicit newlines afterwards keep the shell prompt from
    // overlapping the TUI's last line — the bare unmount left the cursor at
    // the end of the final frame, so the prompt printed over it.
    let instance;
    let exited = false;
    let updateRequested = false;
    // The profile this process was booted with (`dsh --profile <name>`); dsh
    // exposes it nowhere else, and /update must update the installation the
    // user is actually running, not a hard-coded one.
    const profile = resolveDshProfileName();
    const handleExit = (error) => {
        if (exited)
            return;
        exited = true;
        try {
            writeResumeTarget(channel.agentId);
        }
        catch {
            // Best effort — the resume marker is a launcher nicety; a stale
            // marker must never block a clean exit.
        }
        try {
            instance?.unmount();
        }
        catch {
            // The terminal state may already be gone (broken pipe, alt session);
            // the exit path must never throw.
        }
        if (error !== undefined) {
            // Error-driven unmount (render crash): stay loud and exit non-zero.
            // A success code + resume hint here would tell wrappers/CI the
            // session ended cleanly while the TUI actually crashed.
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error(`cc-tui: exit after error: ${message}`);
            if (process.stderr.isTTY) {
                process.stderr.write(`\ncc-tui crashed: ${message}\n`);
            }
            disposeRootAndExit(ctx, 1);
            return;
        }
        if (updateRequested) {
            if (process.stdout.isTTY) {
                process.stdout.write('\nUpdating dsh-cc-tui and restarting…\n');
            }
            disposeRootAndThen(ctx, () => {
                // updateRequested only flips when onUpdate exists, which itself
                // requires a resolved profile — narrow for the call below.
                const updateProfile = profile;
                if (updateProfile === undefined) {
                    process.stderr.write('\ncc-tui update aborted: no dsh profile resolved.\n');
                    process.exit(1);
                }
                void updateTuiAndRestart(channel.agentId, updateProfile).then(({ updateCode, restartCode }) => {
                    if (updateCode !== 0) {
                        // The session survives: its log lives in DSH persistence and
                        // resume.txt was already written. A bare non-zero exit would
                        // drop the user into a shell with no way back in.
                        process.stderr.write(`\ncc-tui update failed (exit ${updateCode}). Your session is preserved — resume with:\n` +
                            `${resumeCommand(profile, channel.agentId)}\n\n`);
                    }
                    process.exit(restartCode);
                }, updateError => {
                    const message = updateError instanceof Error ? updateError.message : String(updateError);
                    process.stderr.write(`\ncc-tui update failed: ${message}. Your session is preserved — resume with:\n` +
                        `${resumeCommand(profile, channel.agentId)}\n\n`);
                    process.exit(1);
                });
            });
            return;
        }
        if (process.stdout.isTTY) {
            process.stdout.write(`\nResume with (set the env var, then boot the profile):\n${resumeCommand(profile, channel.agentId)}\n\n`);
        }
        disposeRootAndExit(ctx, 0);
    };
    const chat = React.createElement(Chat, {
        channel,
        questionStore,
        onExit: () => handleExit(),
        // Only a `dsh --profile <name>` launch has a profile installation for
        // `/update` to act on; source checkouts and `--config` overlays get the
        // unavailable notice instead.
        onUpdate: profile === undefined ? undefined : () => {
            if (exited || updateRequested)
                return;
            // Confirm the target version before tearing the TUI down: on an
            // already-latest install, an unconditional update+restart would churn
            // the process and then trip the "version did not advance" warning.
            void resolveTuiUpdateTarget().then((target) => {
                if (exited || updateRequested)
                    return;
                if (target.kind === 'latest') {
                    channel.notify(t('update-already-latest', { current: target.current }), { color: 'warning' });
                    return;
                }
                if (target.kind === 'unknown') {
                    channel.notify(t('update-check-failed'));
                }
                channel.notify(t('update-starting'));
                updateRequested = true;
                instance?.unmount();
            });
        },
    });
    // fullscreen: wrap the tree in <AlternateScreen> (DEC 1049 + SGR mouse
    // tracking), which turns on in-app text selection (copy-on-select via
    // useCopyOnSelect), wheel scroll, and click/hover hit-testing. Inline
    // mode leaves the mouse to the terminal emulator's native selection.
    const tree = React.createElement(ThemeProvider, null, config.fullscreen ? React.createElement(AlternateScreen, null, chat) : chat);
    instance = await render(tree, { exitOnCtrlC: false });
    // Check in the background so registry latency never delays the first frame.
    // A failed/offline check is intentionally silent; the manual `/update`
    // command remains available regardless of network access.
    void checkForTuiUpdate().then((update) => {
        if (update === undefined || exited || updateRequested)
            return;
        channel.notify(t('update-available', { current: update.current, latest: update.latest }), { color: 'warning', timeoutMs: 12000 });
    });
    // If the surrounding tree goes down (reload, teardown), take the TUI with it.
    ctx.effect(() => () => {
        instance?.unmount();
    });
    // The TUI is the front door: when it unmounts (Ctrl+C), dispose the app
    // tree and exit the process. The rejection handler covers error-driven
    // unmounts — without it a rejected exitPromise became an unhandled
    // rejection instead of a clean exit.
    void instance.waitUntilExit().then(handleExit, handleExit);
}
/**
 * Attach to an existing agent, resume a persisted session (`dsh-cc --resume`
 * feeds the id through `config.sessionId`), or create a fresh one. Resume
 * goes through the DSH persistence seam (`ctx.agents.resume` reads the
 * session log written by dsh-session-persistence-jsonl); a missing artifact
 * or unmounted backend falls back to a fresh session, as does a plain boot
 * without a session id.
 *
 * Preset composition (issue #8): a create resolves the requested preset
 * (cordis.yml `preset` over the persisted `/preset` choice over the roster
 * default) and mounts it in the factory's setup hook; a resume re-mounts the
 * preset the session's own log records. Without the roster both paths behave
 * as before presets existed.
 *
 * Model route (issues #14/#30): a create resolves cordis.yml
 * `provider`/`model` over the persisted `/model` choice; a resume passes the
 * config-only route through so the session's own recorded route wins when
 * cordis.yml sets nothing.
 */
async function resolveAgent(ctx, requestedSessionId, agentOptions, meta, configuredPreset) {
    if (requestedSessionId !== undefined) {
        const resumeId = SessionId(requestedSessionId);
        const existing = ctx.agents.get(resumeId);
        if (existing !== undefined) {
            return { agent: existing, agentPreset: runningPresetOf(existing.session) };
        }
        try {
            // The resumed session keeps the preset its log records (last
            // `agent-preset/selected` wins over the creation header), never the
            // caller's current preference.
            const persisted = await resolvePersistedPreset(ctx, resumeId);
            const composed = await composePreset(ctx, persisted);
            const resumed = await ctx.agents.resume({
                resumeSessionId: resumeId,
                agentOptions,
                ...(composed.setup === undefined ? {} : { setup: composed.setup }),
            });
            return { agent: resumed.agent, handle: resumed, agentPreset: composed.agentPreset };
        }
        catch (error) {
            // No artifact (first run / cleared storage) or persistence not
            // mounted: fall through to a fresh session, but stay loud in the log.
            ctx.logger.warn(`cc-tui: resume of "${requestedSessionId}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const sessionId = SessionId(randomUUID());
    const composed = await composePreset(ctx, configuredPreset ?? readPresetPref());
    // Fresh-session route precedence (issues #14/#30): cordis.yml explicit
    // keys > the persisted `/model` choice > the adapter/harness default.
    const modelPref = readModelPref();
    const route = {
        provider: agentOptions.provider ?? modelPref?.provider,
        model: agentOptions.model ?? modelPref?.model,
    };
    const created = await ctx.agents.create({
        sessionId,
        meta: {
            ...meta,
            // Durable header value: a later resume re-mounts exactly this preset.
            ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
        },
        agentOptions: route,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
    }).catch((error) => {
        // Fail loud with the reason on stderr — a dead TUI with no message is
        // the worst outcome for a misconfigured leaf (unknown provider/model).
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cc-tui: failed to create agent (provider=${route.provider ?? 'deepseek-official'}, model=${route.model ?? 'deepseek-v4-flash'}): ${message}`);
    });
    return { agent: created.agent, handle: created, agentPreset: composed.agentPreset };
}
/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * Mirrors the deleted dsh-tui front-door exit semantics.
 */
function disposeRootAndExit(ctx, code) {
    disposeRootAndThen(ctx, () => process.exit(code), code);
}
/**
 * The real way back into a session after the TUI process is gone. The
 * package ships no `dsh-cc` bin — resuming means feeding the session id
 * through `DSH_CC_RESUME_SESSION` (what cordis.patch.yml's `sessionId` reads)
 * and booting the same profile; on Windows the repo's dsh-cc.cmd wrapper
 * does this via --resume + ~/.dsh-cc/resume.txt.
 */
function resumeCommand(profile, sessionId) {
    const boot = profile === undefined ? 'dsh --config cordis.yml' : `dsh --profile ${profile}`;
    return process.platform === 'win32'
        ? `dsh-cc --resume ${sessionId}`
        : `DSH_CC_RESUME_SESSION=${sessionId} ${boot}`;
}
/**
 * Dispose the Cordis tree, then run a process-level handoff action. The
 * fallback exit keeps the caller's intended code when disposal stalls — the
 * handoff (update/restart) may legitimately take longer than the bound, and
 * reporting failure on a clean exit would mislead wrapper scripts.
 */
function disposeRootAndThen(ctx, done, fallbackCode = 1) {
    const timer = setTimeout(() => process.exit(fallbackCode), 5000);
    timer.unref();
    void ctx.root.fiber.dispose().then(() => {
        clearTimeout(timer);
        done();
    }, () => {
        clearTimeout(timer);
        done();
    });
}
