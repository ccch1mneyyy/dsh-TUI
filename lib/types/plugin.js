import { randomUUID } from 'node:crypto';
import React from 'react';
import { SessionId } from '@deepseek-ai/dsh-session';
import UserQuestionService from '@deepseek-ai/dsh-user-questions';
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user';
import { createChannel } from './channel.js';
import { QuestionStore } from './questions.js';
import { readActivityFrames } from './activityPrefs.js';
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
    userQuestions.registerProvider({
        ask: request => questionStore.ask(request),
    });
    ctx.effect(() => () => questionStore.rejectAll());
    const agentOptions = {
        provider: config.provider,
        model: config.model,
    };
    const meta = { cwd: config.cwd ?? process.cwd() };
    const { agent, handle } = await resolveAgent(ctx, config.sessionId, agentOptions, meta);
    const channel = createChannel(ctx, agent, {
        model: config.model ?? 'deepseek-v4-flash',
        cwd: config.cwd ?? process.cwd(),
        provider: config.provider ?? 'deepseek-official',
        effort: config.effort,
        activity: config.activity,
        // Explicit cordis.yml value (static deployment choice) wins over the
        // runtime `/activity` preference, which wins over the default.
        activityFrames: config.activityFrames ?? readActivityFrames() ?? 'claude',
        handle,
    });
    const chat = React.createElement(Chat, {
        channel,
        questionStore,
        onExit: () => { disposeRootAndExit(ctx, 0); },
    });
    // fullscreen: wrap the tree in <AlternateScreen> (DEC 1049 + SGR mouse
    // tracking), which turns on in-app text selection (copy-on-select via
    // useCopyOnSelect), wheel scroll, and click/hover hit-testing. Inline
    // mode leaves the mouse to the terminal emulator's native selection.
    const tree = React.createElement(ThemeProvider, null, config.fullscreen ? React.createElement(AlternateScreen, null, chat) : chat);
    const instance = await render(tree, { exitOnCtrlC: false });
    // If the surrounding tree goes down (reload, teardown), take the TUI with it.
    ctx.effect(() => () => {
        instance.unmount();
    });
    // The TUI is the front door: when it unmounts (Ctrl+C), dispose the app
    // tree and exit the process.
    void instance.waitUntilExit().then(() => {
        disposeRootAndExit(ctx, 0);
    });
}
/**
 * Attach to an existing agent, resume a persisted session (`dsh-cc --resume`
 * feeds the id through `config.sessionId`), or create a fresh one. Resume
 * goes through the DSH persistence seam (`ctx.agents.resume` reads the
 * session log written by dsh-session-persistence-jsonl); a missing artifact
 * or unmounted backend falls back to a fresh session, as does a plain boot
 * without a session id.
 */
async function resolveAgent(ctx, requestedSessionId, agentOptions, meta) {
    if (requestedSessionId !== undefined) {
        const resumeId = SessionId(requestedSessionId);
        const existing = ctx.agents.get(resumeId);
        if (existing !== undefined)
            return { agent: existing };
        try {
            const resumed = await ctx.agents.resume({
                resumeSessionId: resumeId,
                agentOptions,
            });
            return { agent: resumed.agent, handle: resumed };
        }
        catch (error) {
            // No artifact (first run / cleared storage) or persistence not
            // mounted: fall through to a fresh session, but stay loud in the log.
            ctx.logger.warn(`cc-tui: resume of "${requestedSessionId}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const sessionId = SessionId(randomUUID());
    const created = await ctx.agents.create({ sessionId, meta, agentOptions }).catch((error) => {
        // Fail loud with the reason on stderr — a dead TUI with no message is
        // the worst outcome for a misconfigured leaf (unknown provider/model).
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cc-tui: failed to create agent (provider=${agentOptions.provider ?? 'deepseek-official'}, model=${agentOptions.model ?? 'deepseek-v4-flash'}): ${message}`);
    });
    return { agent: created.agent, handle: created };
}
/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * Mirrors the deleted dsh-tui front-door exit semantics.
 */
function disposeRootAndExit(ctx, code) {
    const timer = setTimeout(() => process.exit(code), 5000);
    timer.unref();
    void ctx.root.fiber.dispose().then(() => {
        clearTimeout(timer);
        process.exit(code);
    }, () => {
        clearTimeout(timer);
        process.exit(code);
    });
}
