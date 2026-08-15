import { randomUUID } from 'node:crypto';
import { assembleContextFor, installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage, isTokenDelta, MessageId, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { runSideQuestion, wrapSideQuestion } from './utils/sideQuestion.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { discoverBaselineInstructionFiles } from '@deepseek-ai/dsh-agent-instructions';
import { isAbsolute, join } from 'node:path';
import { LOCAL_COMMANDS } from './commands.js';
import { clearResumeTarget, readLastUsed, touchSession, writeResumeTarget } from './sessionHistory.js';
import { prepareSessionForResume, readSessionTitleFromLog } from './compat/index.js';
import { writeActivityFrames } from './activityPrefs.js';
import { readEffortPref, writeEffortPref } from './effortPrefs.js';
import { readModelPref, writeModelPref } from './modelPrefs.js';
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from './modelRoute.js';
import { readPresetPref, writePresetPref } from './presetPrefs.js';
import { composePreset, resolvePersistedPreset, rosterOf, runningPresetOf, serviceForAgent } from './presets.js';
import { isPresetName } from './components/activityFrames.js';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { logForDebugging } from './utils/debug.js';
import { extractMentions } from './utils/mentions.js';
import { t } from './i18n.js';
import { modeDisplayName, resolveSessionModes } from './sessionModes.js';
const ARGS_PREVIEW_LIMIT = 160;
const RESULT_PREVIEW_LIMIT = 240;
/** Local `!`-command output cap (mirrors the result preview limit). */
const LOCAL_OUTPUT_LIMIT = 240;
/**
 * In-memory transcript window cap. Older rows beyond this count are FOLDED:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log remains the
 * complete source of truth (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
const MAX_ROWS = 600;
function preview(text, limit) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
/**
 * Fold the oldest rows beyond the transcript window cap: drop each row's
 * full-text fields (assistant/reasoning text, tool args/results) and keep
 * only its preview text, kind, id, and seq. Bounds the TUI's retained text
 * without touching the session log (the source of truth for /export and
 * loadOlder). Small local/notice/interrupt rows are left intact (they hold
 * terminal-local text the log cannot restore). Restored rows are exempt so
 * a loadOlder() restore is not instantly undone. Returns the number of rows
 * folded.
 */
function foldRows(rows, cap) {
    const excess = rows.length - cap;
    if (excess <= 0)
        return 0;
    let folded = 0;
    for (const row of rows.slice(0, excess)) {
        if (row.folded || row.restored)
            continue;
        if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'reasoning' && row.kind !== 'tool')
            continue;
        row.folded = true;
        folded += 1;
        if (row.kind === 'tool' && row.tool) {
            row.tool.argsFull = undefined;
            row.tool.resultFull = undefined;
            row.tool.errorText = undefined;
            // Presentation views hold duplicated content strings (diff before/
            // after images, terminal output); the session log re-derives them.
            row.tool.callView = undefined;
            row.tool.resultView = undefined;
        }
        else if (row.text.length > 0) {
            // Keep a short preview so the transcript reads naturally; the full
            // text lives in the session log and is restored by loadOlder().
            row.text = preview(row.text, 200);
        }
    }
    return folded;
}
/**
 * Restore folded rows from the session log, newest folded batch first.
 * Rebuilds each folded row's full text from its source events and clears
 * the folded mark, keeping row ids, scroll anchors, and selection stable.
 * `views` re-derives the tool presentation views foldRows dropped (the
 * presenters live on the host plane, so the channel passes them in).
 * Returns the number of rows restored.
 */
function foldBack(rows, events, views) {
    const folded = rows.filter(row => row.folded);
    if (folded.length === 0)
        return 0;
    const firstFoldedSeq = folded[0]?.seq ?? 0;
    const restoreEvents = events.filter(event => event.seq >= firstFoldedSeq);
    // tool results are matched by callId, not seq, because the result event
    // seq differs from the call event seq that anchored the row.
    const resultsByCall = new Map();
    for (const event of restoreEvents) {
        if (event.type === 'tool/result') {
            resultsByCall.set(event.data.message.source.callId, event);
        }
    }
    let restored = 0;
    for (const row of folded) {
        const rowSeq = row.seq;
        if (rowSeq === undefined)
            continue;
        if (row.kind === 'tool' && row.tool !== undefined) {
            // The tool row is anchored on its tool/call seq; its result text comes
            // from the matching tool/result event.
            const call = restoreEvents.find(event => event.seq === rowSeq && event.type === 'tool/call');
            if (call === undefined || call.type !== 'tool/call')
                continue;
            restoreRowFromEvent(row, call);
            const result = resultsByCall.get(row.tool.callId);
            if (result !== undefined)
                restoreToolResult(row, result);
            row.tool.callView = views?.call(call.data.name, call.data.arguments);
            row.tool.resultView = result !== undefined && result.data.error === undefined
                ? views?.result(call.data.name, call.data.arguments, result.data)
                : undefined;
            row.folded = false;
            restored += 1;
            continue;
        }
        // Text rows are anchored on their first delta chunk; the settled
        // assistant/message at or after that seq carries the full text.
        const message = restoreEvents.find(event => event.seq >= rowSeq && event.type === 'assistant/message');
        if (message === undefined)
            continue;
        restoreRowFromEvent(row, message);
        row.folded = false;
        restored += 1;
    }
    return restored;
}
/** Rebuild a folded row's full text from its source session event. */
function restoreRowFromEvent(row, event) {
    switch (row.kind) {
        case 'user': {
            if (event.type !== 'user/message')
                break;
            const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('').trim();
            if (text)
                row.text = text;
            break;
        }
        case 'assistant': {
            if (event.type !== 'assistant/message')
                break;
            const text = event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('').trim();
            if (text)
                row.text = text;
            break;
        }
        case 'reasoning': {
            // Thinking text is carried by the assistant/message's reasoning
            // blocks, not the (ephemeral) delta chunks, so the settled message
            // restores it exactly.
            if (event.type !== 'assistant/message')
                break;
            const text = event.data.message.content.map(block => block.type === 'reasoning' ? block.text : '').join('').trim();
            if (text)
                row.text = text;
            break;
        }
        case 'tool': {
            if (event.type !== 'tool/call' || row.tool === undefined)
                break;
            row.tool.argsFull = event.data.arguments;
            break;
        }
        default:
            break;
    }
}
/** Restore a folded tool row's result text from its tool/result event. */
function restoreToolResult(row, event) {
    if (row.tool === undefined)
        return;
    const failure = event.data.error;
    if (failure !== undefined) {
        row.tool.status = 'error';
        row.tool.errorText = `${failure.name}: ${failure.code}`;
        return;
    }
    row.tool.status = 'ok';
    const block = event.data.message.content[0];
    const result = block.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
    row.tool.resultFull = result || undefined;
}
/**
 * Coalesce runs of same-type assistant/chunk deltas into single synthetic
 * events for REPLAY only. A streamed turn logs one event per token (~100k
 * events in long sessions); replaying them one at a time costs per-chunk
 * string growth on every row (quadratic in the turn's length). Merging is
 * outcome-identical: ensureStreaming/ensureReasoning only read chunk.type
 * and the concatenated text, and the row's seq comes from the run's FIRST
 * chunk (the fork boundary rewindTo derives from it). Parts join once —
 * no quadratic concat. Live events never go through this.
 */
function coalesceReplayEvents(events) {
    const out = [];
    let run = null;
    const flush = () => {
        if (run === null)
            return;
        const chunk = run.event.data.chunk;
        out.push({
            ...run.event,
            data: { ...run.event.data, chunk: { ...chunk, text: run.parts.join('') } },
        });
        run = null;
    };
    for (const event of events) {
        if (event.type === 'assistant/chunk' &&
            (event.data.chunk.type === 'text-delta' || event.data.chunk.type === 'reasoning-delta')) {
            if (run !== null && run.type === event.data.chunk.type) {
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack text
                run.parts.push(event.data.chunk.text ?? '');
                continue;
            }
            flush();
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack text
            run = { event, type: event.data.chunk.type, parts: [event.data.chunk.text ?? ''] };
            continue;
        }
        flush();
        out.push(event);
    }
    flush();
    return out;
}
/** Buffer below the context window at which CC warns (autoCompact.ts). */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000;
/** How many newest sessions resolve their title from the first user message
 *  (persistence.load reads the whole log — depth caps the picker latency). */
const SESSION_TITLE_DEPTH = 20;
/** Picker title cap, in characters. */
const SESSION_TITLE_LIMIT = 40;
/** One-line session title: whitespace folded, capped with an ellipsis. */
function shortenTitle(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= SESSION_TITLE_LIMIT
        ? flat
        : `${flat.slice(0, SESSION_TITLE_LIMIT - 1)}…`;
}
/** Resolve once a `turn/end` event newer than `fromSeq` lands in the session
 *  log (Agent.cancel closes the turn asynchronously), or when the timeout
 *  expires. Polling the session log is race-free here: fork reads the same
 *  append-only log. */
async function waitForTurnEnd(session, fromSeq, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const last = session.events.at(-1);
        if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
}
/**
 * Create the live channel state for one agent session: replay the durable
 * transcript, subscribe to the agent's events, and expose every TUI action.
 * @internal
 * @param ctx - The plugin context; optional services are resolved via ctx.get.
 * @param initialAgent - The agent whose session the channel renders; rewinds,
 *   resumes, and model switches replace it.
 * @param options - Boot options: model route, cwd, provider, and the
 *   reasoning-effort / working-activity / agent-handle preferences.
 * @returns The live channel state, subscribed and ready to render.
 */
export function createChannel(ctx, initialAgent, options) {
    let agent = initialAgent;
    let currentHandle = options.handle;
    // The DSH slash-command registry (optional service): /plan, /goal and
    // friends register here; the TUI merges their descriptors into the slash
    // menu and dispatches through `execute` (which logs the paired
    // command/run + command/done records). Absent the service, only the
    // built-in local commands exist.
    const commandService = ctx.get('commands');
    // Shift+Tab session-mode cycle: cordis.yml `modes` wins; absent/empty/
    // atom-less → the built-in default/plan/full cycle (sessionModes.ts).
    const { modes: sessionModes, dropped: droppedModeIds } = resolveSessionModes(options.modes);
    if (droppedModeIds.length > 0) {
        ctx.logger.warn(`cc-tui: session modes ${droppedModeIds.map(id => `"${id}"`).join(', ')} declare no plan/sandbox/approval atom; dropped from the Shift+Tab cycle`);
    }
    const listeners = new Set();
    /** True while a frame-aligned stream notification is pending (emitStream). */
    let streamNotifyScheduled = false;
    let nextNotificationId = 1;
    /** One-shot context-low warning per session (CC's TokenWarning). */
    let contextWarned = false;
    const checkContextWarning = () => {
        if (contextWarned || state.contextWindow === undefined)
            return;
        const remaining = state.contextWindow - state.tokens.input;
        if (remaining >= CONTEXT_WARNING_BUFFER_TOKENS)
            return;
        contextWarned = true;
        const percentLeft = Math.max(0, Math.round((remaining / state.contextWindow) * 100));
        state.notify(`Context low (${percentLeft}% remaining) · Run /clear or start a new session`, { color: 'warning', timeoutMs: 8000 });
    };
    /**
     * Register a submitted message as pending and notify the UI. The inbox
     * events (claimed/discarded) retire it; nothing here guesses timing.
     */
    const trackPending = (message, placement) => {
        state.pending = [...state.pending, { id: message.id, text: message.text, placement }];
        state.emit();
    };
    /** Remove one pending entry (rollback on a refused send, steering
     *  rejection, or delivery races) and notify only when it existed. */
    const untrackPending = (messageId) => {
        const before = state.pending.length;
        state.pending = state.pending.filter(item => item.id !== messageId);
        if (state.pending.length !== before)
            state.emit();
    };
    /**
     * `@` file mentions (issue #15): expansion reads files asynchronously, so
     * every user-text delivery (submit / steer / interrupt-requeue) funnels
     * through this chain to keep the send order FIFO.
     */
    let sendChain = Promise.resolve();
    /**
     * Expand the text's `@` mentions and deliver ONE user message: the typed
     * text stays the first content block (the transcript bubble renders it —
     * never the file dump) and each resolved reference appends a model-facing
     * attachment block. The pending preview tracks the typed text.
     */
    const deliverUserText = (text, placement) => {
        sendChain = sendChain.then(async () => {
            const expansion = await expandMentions(mentionFs(ctx), state.cwd, text);
            const message = createUserMessage({
                content: expansion.blocks,
                source: { kind: 'user' },
            });
            // Track BEFORE the agent call: a synchronous throw inside
            // followup/steer rolls the preview back; otherwise the inbox events
            // retire it once the message is claimed or discarded.
            trackPending({ id: message.id, text }, placement);
            try {
                if (placement === 'steer')
                    agent.steer(message);
                else
                    agent.followup(message);
            }
            catch (error) {
                untrackPending(message.id);
                throw error;
            }
            if (expansion.attached.length > 0) {
                state.notify(t('mentions-attached', { count: expansion.attached.length }), { timeoutMs: 2500 });
            }
            if (expansion.missing.length > 0) {
                state.notify(t('mentions-missing', { paths: expansion.missing.map(path => `@${path}`).join(' ') }), {
                    color: 'warning',
                    timeoutMs: 4000,
                });
            }
        }).catch((error) => {
            // The chain must survive a failed send: log and notify, then continue
            // with the next queued delivery.
            const message = error instanceof Error ? error.message : String(error);
            logForDebugging(`submit: delivery failed (${message})`);
            state.notify(t('send-failed', { err: message }), { color: 'error' });
        });
    };
    /** Monotonic token: only the latest `interruptAndDeliver` re-queues, so a
     *  second interrupt while the abort settles cannot double-deliver. */
    let interruptSeq = 0;
    /** The llm runtime seam (dsh-llm LlmRuntime): route metadata resolution. */
    const llmRuntime = ctx.get('llm');
    /** Mutable per-agent model selection (dsh-agent's routing override seam).
     *  `current` stays undefined until the user explicitly cycles effort, so
     *  default routing (agentOptions on create/fork) is untouched; bindAgent
     *  re-couples it to each new agent's prompt assembly + request config. */
    const selection = { current: undefined, assembled: undefined };
    /** The effort chosen this run (or persisted from a previous one); applied
     *  to every newly bound agent once validated against its adapter's list. */
    let preferredEffort = options.effort ?? readEffortPref();
    /** Pin `preferredEffort` on the live agent when its route offers it;
     *  silent no-op otherwise (the next request/header corrects the display). */
    const applyPreferredEffort = async () => {
        if (preferredEffort === undefined || llmRuntime === undefined)
            return;
        try {
            const info = await llmRuntime.resolveModelInfo(state.provider, state.model);
            if (!info.reasoning?.efforts.some(effort => effort.id === preferredEffort))
                return;
            selection.current = {
                provider: state.provider,
                model: state.model,
                reasoningEffort: ReasoningEffortId(preferredEffort),
            };
        }
        catch {
            // Route metadata resolution is best-effort; a failure just leaves the
            // provider default in effect.
        }
    };
    /** Resolve the live route's effort levels + adapter default through the
     *  llm runtime; 'unavailable' when the service is unmounted, 'error' when
     *  resolution throws (notified here). */
    const resolveEfforts = async () => {
        if (llmRuntime === undefined)
            return 'unavailable';
        try {
            const info = await llmRuntime.resolveModelInfo(state.provider, state.model);
            return {
                efforts: info.reasoning?.efforts ?? [],
                defaultEffort: info.reasoning?.defaultEffort,
            };
        }
        catch (error) {
            state.notify(t('effort-read-failed', { error: error instanceof Error ? error.message : String(error) }), {
                color: 'error',
                timeoutMs: 8000,
            });
            return 'error';
        }
    };
    /** Pin one validated effort level on the live route: reroutes the next
     *  request, persists the choice, and refreshes the StatusLine segment. */
    const applyEffort = (effort) => {
        selection.current = {
            provider: state.provider,
            model: state.model,
            reasoningEffort: ReasoningEffortId(effort.id),
        };
        preferredEffort = effort.id;
        state.reasoningEffort = effort.id;
        writeEffortPref(effort.id);
        state.notify(t('effort-switched', { name: effort.name }));
        state.emit();
    };
    /** The live route's effort levels for the `/effort` slider; empty after
     *  notifying when the route is unsupported/unavailable/single-tier. */
    const listEfforts = async () => {
        const resolved = await resolveEfforts();
        if (resolved === 'unavailable') {
            state.notify(t('effort-unavailable'), { color: 'error' });
            return { efforts: [], defaultEffort: undefined };
        }
        if (resolved === 'error')
            return { efforts: [], defaultEffort: undefined };
        if (resolved.efforts.length === 0) {
            state.notify(t('effort-unsupported'), { color: 'warning' });
        }
        else if (resolved.efforts.length === 1) {
            state.notify(t('effort-single-tier', { name: resolved.efforts[0].name }), { color: 'warning' });
        }
        return resolved;
    };
    /** Set one effort level by id (`/effort <id>` and the slider's live
     *  apply); false + a notify when the id is not offered by the route. */
    const setEffort = async (id) => {
        const resolved = await resolveEfforts();
        if (resolved === 'unavailable') {
            state.notify(t('effort-unavailable'), { color: 'error' });
            return false;
        }
        if (resolved === 'error')
            return false;
        if (resolved.efforts.length === 0) {
            state.notify(t('effort-unsupported'), { color: 'warning' });
            return false;
        }
        const found = resolved.efforts.find(effort => effort.id === id);
        if (!found) {
            state.notify(t('effort-invalid', { id, ids: resolved.efforts.map(effort => effort.id).join(', ') }), { color: 'warning' });
            return false;
        }
        applyEffort(found);
        return true;
    };
    /** Run one DSH registry command (`/plan`, …) on the live agent; the text
     *  of its result, '' when the result is textless, undefined when the
     *  command is not registered, and the error message when it throws. */
    const executeRegistryCommand = async (name, rawInput) => {
        if (!commandService)
            return undefined;
        try {
            const execution = await commandService.execute(agent, `/${name}${rawInput}`, new AbortController().signal);
            // `undefined` = not registered; a handler error surfaces as its
            // message so the user sees why the command failed.
            return execution?.result.text ?? '';
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };
    // Session-mode folds: last-wins projections over the session log. The
    // event types are registered by dsh-plan-mode / dsh-sandbox-policy /
    // dsh-user-approval and are NOT in this package's typed SessionEvent
    // union, so they are matched by name through casts — the same pattern as
    // `agent-preset/selected` in renderEvent and the goal projection above.
    const foldPlanActive = (events) => {
        let active = false;
        for (const event of events) {
            if (event.type === 'plan/mode') {
                active = event.data.active === true;
            }
        }
        return active;
    };
    const foldSandboxMode = (events) => {
        let mode;
        for (const event of events) {
            if (event.type === 'sandbox/mode') {
                const value = event.data.mode;
                if (typeof value === 'string')
                    mode = value;
            }
        }
        return mode;
    };
    const foldApprovalPolicy = (events) => {
        let policy;
        for (const event of events) {
            if (event.type === 'approval/policy') {
                const value = event.data.policy;
                if (typeof value === 'string')
                    policy = value;
            }
        }
        return policy;
    };
    /** First configured mode whose declared atoms all match the folds;
     *  undeclared atoms are wildcards; no match → index 0 (the base mode).
     *  Matching is exact: a fresh session has no `approval/policy` event, so
     *  a mode declaring `approval: 'ask'` never falsely matches it. */
    const deriveModeIndex = (events) => {
        const index = sessionModes.findIndex(spec => (spec.plan === undefined || foldPlanActive(events) === spec.plan) &&
            (spec.sandbox === undefined || foldSandboxMode(events) === spec.sandbox) &&
            (spec.approval === undefined || foldApprovalPolicy(events) === spec.approval));
        return index >= 0 ? index : 0;
    };
    /** Re-derive the current mode from the live session log (boot, every
     *  agent re-bind, and after mode-affecting session events). */
    const refreshMode = () => {
        state.modeIndex = deriveModeIndex(agent.session.events);
        state.mode = sessionModes[state.modeIndex];
    };
    /** Apply one configured mode: each declared atom switches independently
     *  (plan via the registry `/plan` command; sandbox/approval via their
     *  durable session-log override events). A failing plan toggle aborts the
     *  whole switch so the session never lands in a half-applied mode. */
    const applyMode = async (spec) => {
        if (spec.plan !== undefined && foldPlanActive(agent.session.events) !== spec.plan) {
            const text = await executeRegistryCommand('plan', spec.plan ? '' : ' off');
            if (text === undefined) {
                // The active preset registers no /plan.
                state.notify(t('mode-plan-unavailable'), { color: 'warning' });
                return;
            }
        }
        // The durable sandbox override is one session event (dsh-sandbox-policy's
        // own write path); the session/event arm picks it up immediately.
        if (spec.sandbox !== undefined && foldSandboxMode(agent.session.events) !== spec.sandbox) {
            ;
            agent.session.append('sandbox/mode', { mode: spec.sandbox });
        }
        // Prefer the approval service (it narrates the switch to the model);
        // the raw durable event is the fallback when it is unmounted.
        if (spec.approval !== undefined && foldApprovalPolicy(agent.session.events) !== spec.approval) {
            const approval = ctx.get('approval');
            if (approval) {
                approval.setPolicy(agent, spec.approval);
            }
            else {
                ;
                agent.session.append('approval/policy', { policy: spec.approval });
            }
        }
        refreshMode();
        state.notify(t('mode-switched', { name: modeDisplayName(state.mode) }));
        state.emit();
    };
    /** Shift+Tab: advance to the next configured session mode. Cycling starts
     *  from the mode DERIVED from the session log (never a stored index), so
     *  manual `/plan` use can never desync the cycle. */
    const cycleMode = async () => {
        const index = deriveModeIndex(agent.session.events);
        await applyMode(sessionModes[(index + 1) % sessionModes.length]);
    };
    const state = {
        version: 0,
        rows: [],
        status: 'starting',
        sessionTitle: '',
        agentId: agent.id,
        model: options.model,
        provider: options.provider,
        tokens: { input: 0, output: 0 },
        cwd: options.cwd,
        gitBranch: undefined,
        working: false,
        spinnerMode: 'requesting',
        responseChars: 0,
        activeToolCount: 0,
        turnStart: 0,
        lastUserText: '',
        notifications: [],
        contextWindow: undefined,
        // Explicit cordis.yml `effort` wins; otherwise the persisted /effort
        // choice; the first request/header event re-asserts the adapter's truth.
        reasoningEffort: options.effort ?? readEffortPref(),
        // Session-mode seed; the first refreshMode() (bindAgent) re-derives it
        // from the session log, so a resumed session lands on its recorded mode.
        mode: sessionModes[0],
        modeIndex: 0,
        workingActivity: undefined,
        activityFrames: options.activityFrames,
        activityEnabled: options.activity !== false,
        contextBarEnabled: options.contextBar !== false,
        agentPreset: options.agentPreset,
        goal: undefined,
        todos: [],
        loadedContext: undefined,
        pending: [],
        commandList: LOCAL_COMMANDS,
        lastUsage: undefined,
        tps: undefined,
        tpsSamples: [],
        contextSegments: {
            system: 0,
            prompt: 0,
            assistant: 0,
            thinking: 0,
            tools: 0,
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        emit() {
            foldRows(state.rows, MAX_ROWS);
            state.version += 1;
            for (const listener of listeners)
                listener();
        },
        // Frame-aligned notification for streaming deltas. LLM chunks arrive at
        // 100-300 events/s (one per token); waking React synchronously per event
        // commits the whole tree per token — the render throttle only gates
        // paint, not commits, so the event loop saturates and output stutters.
        // Data + version stay synchronous (getSnapshot always reads fresh
        // state); only the listener wakeup coalesces to paint cadence.
        emitStream() {
            state.version += 1;
            if (streamNotifyScheduled)
                return;
            streamNotifyScheduled = true;
            const timer = setTimeout(() => {
                streamNotifyScheduled = false;
                foldRows(state.rows, MAX_ROWS);
                for (const listener of listeners)
                    listener();
            }, 16);
            // Never hold the process open for a pending UI wakeup.
            timer.unref();
        },
        loadOlder() {
            // Restore folded-away full text from the session log, newest folded
            // batch first, clearing the folded marks. The log is the authoritative
            // source, so restored rows match a fresh replay; live streaming rows
            // are never folded, so nothing here races a running turn.
            const restored = foldBack(state.rows, agent.session.events, { call: presentCallView, result: presentResultView });
            if (restored > 0)
                state.emit();
            return restored;
        },
        submit(text) {
            const trimmed = text.trim();
            if (!trimmed)
                return;
            // Claude Code's `!` mode: `!cmd` runs locally and only shows the
            // output; `!!cmd` additionally sends the output to the model as a
            // user message (CC's <bash-stdout> convention).
            if (trimmed.startsWith('!!')) {
                void runLocalCommand(trimmed.slice(2).trim(), true);
                return;
            }
            if (trimmed.startsWith('!')) {
                void runLocalCommand(trimmed.slice(1).trim(), false);
                return;
            }
            // The current session is being used — move it to the MRU front
            // (/resume sorts by last-used).
            touchSession(state.agentId);
            deliverUserText(trimmed, 'followup');
        },
        /** Steer a message into the RUNNING turn (Codex/pi semantics): it is
         *  injected at the next step boundary of the current turn and the agent
         *  continues without stopping — faster than followup, never an abort. */
        steer(text) {
            const trimmed = text.trim();
            if (!trimmed)
                return;
            touchSession(state.agentId);
            // Official dsh-agent rc.6: steer() is synchronous void — the message
            // enters the next-step inbox. A rejected step leaves it parked for the
            // next wake; the inbox events below retire the preview (claimed →
            // turn boundary, discarded → cancel).
            deliverUserText(trimmed, 'steer');
        },
        /** Pull a pending message back out of the inbox (Alt+Up): it returns to
         *  the input for editing instead of being delivered. */
        removePending(id) {
            const index = state.pending.findIndex(item => item.id === id);
            if (index === -1)
                return false;
            // Official dsh-agent rc.6: withdrawal goes through the agent's inbox
            // projection — `Inbox.remove(messageId)` durably records the
            // cancellation (an `agent/inbox/spliced` session event) and publishes
            // `agent/inbox/discarded`, which retires the preview. Refuse when the
            // message was already claimed (remove returns false) so the UI never
            // pretends a ghost send was pulled back.
            if (!agent.inbox.remove(MessageId(id)))
                return false;
            state.pending = state.pending.filter(item => item.id !== id);
            state.emit();
            return true;
        },
        cancel() {
            // Keep the staged queue: an interrupt aborts the running turn but the
            // queued/steered messages are delivered as the next turn (web parity).
            agent.cancel({ kind: 'user' }, { keepInbox: true });
        },
        interruptAndDeliver(texts) {
            const queued = texts.map(text => text.trim()).filter(text => text !== '');
            if (queued.length === 0)
                return 0;
            // No keepInbox: the parked copies are dropped (their discard events
            // retire the preview), then each text is re-queued as a fresh
            // followup. The harness parks kept inbox work until an unrelated wake
            // (official cancel.spec: "keepInbox parks queued work after an active
            // turn aborts"), and a wake issued while the driver is still aborting
            // is ignored — so the re-queue happens on `whenIdle`, whose own wake
            // starts the new turn.
            agent.cancel({ kind: 'user' });
            const token = ++interruptSeq;
            const whenIdle = agent.whenIdle;
            const deliver = () => {
                // A second interrupt while the abort is still settling must not
                // double-deliver: only the latest request's re-queue runs.
                if (interruptSeq !== token)
                    return;
                for (const text of queued) {
                    touchSession(state.agentId);
                    deliverUserText(text, 'followup');
                }
            };
            if (typeof whenIdle === 'function') {
                void whenIdle.call(agent).then(deliver);
            }
            else {
                // Defensive: a wake while the driver still runs is ignored, so wait
                // for the abort to settle before re-queueing.
                setTimeout(deliver, 200);
            }
            return queued.length;
        },
        async rewindTo(row) {
            if (row.seq === undefined)
                return null;
            const sessions = ctx.get('sessions');
            const agents = ctx.get('agents');
            if (!sessions || !agents) {
                state.notify('Rewind unavailable — session services not loaded', { color: 'error' });
                return null;
            }
            // Stop a running turn first and WAIT for its turn/end to land — fork
            // rejects boundaries inside open turns, and Agent.cancel() closes the
            // turn asynchronously (a long thinking turn can take seconds to settle).
            const wasWorking = state.working;
            const cancelSeq = agent.session.seq;
            if (wasWorking)
                agent.cancel({ kind: 'user' });
            if (wasWorking) {
                const turnSettled = await waitForTurnEnd(agent.session, cancelSeq, 30000);
                if (!turnSettled) {
                    state.notify('Cannot rewind — the turn is still settling, try again in a moment', { color: 'error' });
                    return null;
                }
            }
            const childId = SessionId(randomUUID());
            // DSH event order is `turn/start → user/message → … → turn/end`, so a
            // message's own seq always sits inside its turn — forking there would
            // hit OPEN_TURN. Rewind to just BEFORE the message's turn/start: the
            // conversation restarts at that point and the message itself comes
            // back into the input for re-editing (CC's rewind semantics).
            const events = agent.session.events;
            let boundary = row.seq;
            for (let i = row.seq; i >= 0; i--) {
                const event = events[i];
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: seq may exceed events
                if (event === undefined)
                    break;
                if (event.type === 'turn/start') {
                    boundary = event.seq - 1;
                    break;
                }
                if (event.type === 'turn/end')
                    break;
            }
            // Slice the seed ourselves instead of storing a fork: agents.create
            // must own the session (a pre-created fork session would collide on
            // the same id). The create boundary validates the seed (contiguous
            // from seq 0, no open turns), which our boundary already guarantees.
            let seed;
            try {
                if (boundary < 0) {
                    throw new Error('cannot rewind to the very first message');
                }
                seed = sessions.fork(agent.session, boundary).events;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                state.notify(`Cannot rewind to this point · ${message}`, { color: 'error' });
                return null;
            }
            let handle;
            // The fork continues under the source session's own preset: switches
            // are blank-only, so every `agent-preset/selected` event predates any
            // rewind boundary and the source log resolves the exact composition.
            // The route likewise stays the live one — a rewind continues the same
            // conversation, so a `/model` switch must survive it (issue #30).
            const rewindComposed = await composePreset(ctx, runningPresetOf(agent.session));
            try {
                handle = await agents.create({
                    sessionId: childId,
                    seed,
                    meta: {
                        cwd: state.cwd,
                        parentSession: agent.session.id,
                        seedLength: seed.length,
                        ...(rewindComposed.agentPreset === undefined
                            ? {}
                            : { agentPreset: rewindComposed.agentPreset }),
                    },
                    agentOptions: { provider: state.provider, model: state.model },
                    ...(rewindComposed.setup === undefined ? {} : { setup: rewindComposed.setup }),
                });
            }
            catch {
                state.notify('Rewind failed — could not create the replacement session', { color: 'error' });
                return null;
            }
            // Replay the forked history into a fresh transcript (tokens/spinner
            // counters land back at the rewind point, matching the fork).
            streaming = undefined;
            reasoning = undefined;
            toolCards.clear();
            nextRowId = 0;
            state.rows.length = 0;
            // Goal/todo/title are session-scoped; the replay re-derives them for
            // the session being entered (or leaves them empty).
            state.todos = [];
            state.goal = undefined;
            state.sessionTitle = '';
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
            state.agentPreset = rewindComposed.agentPreset;
            state.tps = undefined;
            state.tpsSamples = [];
            state.lastUsage = undefined;
            state.workingActivity = undefined;
            state.contextSegments = {
                system: 0,
                prompt: 0,
                assistant: 0,
                thinking: 0,
                tools: 0,
            };
            for (const event of coalesceReplayEvents(seed))
                renderEvent(event);
            // Rebind subscriptions to the new agent, then free the old one.
            const oldHandle = currentHandle;
            agent = handle.agent;
            currentHandle = handle;
            bindAgent();
            refreshCommandList();
            void refreshLoadedContext();
            // The forked session (rewind) becomes the most recently used.
            touchSession(childId);
            state.emit();
            void oldHandle?.dispose().catch(() => { });
            return row.text;
        },
        async resumeTo(sessionId) {
            // Switch the live agent to a persisted session: /resume picker Enter
            // loads the history immediately (the `--resume` launcher path keeps
            // resolving through DSH_CC_RESUME_SESSION at boot).
            if (state.working) {
                state.notify('Cannot resume while a turn is running', { color: 'warning' });
                return false;
            }
            const agents = ctx.get('agents');
            if (!agents) {
                state.notify('Resume unavailable — agents service not loaded', { color: 'error' });
                return false;
            }
            let handle;
            // The target session's own preset (from its persisted log) — never the
            // current preference: a resume re-enters the composition its history
            // was produced under. Same rule for the route: only an explicit
            // cordis.yml provider/model overrides the route the target's own
            // request/header records (issue #30) — and only as a COMPLETE pair
            // (issue #67): a provider-only pin must not merge with the recorded
            // model half into a route no adapter recognizes.
            const resumeComposed = await composePreset(ctx, await resolvePersistedPreset(ctx, SessionId(sessionId)));
            const resumeRoute = explicitModelRoute({
                provider: options.configuredProvider,
                model: options.configuredModel,
            });
            try {
                // Compat boundary: mark third-party event types in the target log
                // ignorable before the harness seed-validates it (src/compat/).
                await prepareSessionForResume(sessionId);
                handle = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    agentOptions: { provider: resumeRoute?.provider, model: resumeRoute?.model },
                    ...(resumeComposed.setup === undefined ? {} : { setup: resumeComposed.setup }),
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                state.notify(`Resume failed · ${message}`, { color: 'error', timeoutMs: 8000 });
                return false;
            }
            // Replay the persisted history into a fresh transcript (same reset as
            // rewindTo, plus the context window which the replay re-derives).
            streaming = undefined;
            reasoning = undefined;
            toolCards.clear();
            nextRowId = 0;
            state.rows.length = 0;
            // Goal/todo/title are session-scoped; the replay re-derives them for
            // the session being entered (or leaves them empty).
            state.todos = [];
            state.goal = undefined;
            state.sessionTitle = '';
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
            // Adopt the resumed session's persisted cwd (issue #96): pre-upgrade
            // sessions recorded the LAUNCH directory (often a repo subdirectory),
            // so keeping the freshly resolved root would split @ expansion / file
            // completion (state.cwd) from the agent's own workspace record — and
            // drop the session back out of the /resume filter. The branch
            // breadcrumb follows the adopted cwd.
            state.cwd = handle.agent.session.header.cwd ?? state.cwd;
            refreshGitBranch();
            state.agentPreset = resumeComposed.agentPreset;
            // Status-line route follows the resumed session (review feedback): the
            // route it actually continues on — a complete cordis.yml pin, else the
            // route its own request/header records carry. A bare log (no turn ever
            // started) records none; keep the current display as best effort.
            const resumedRoute = resumeRoute ?? recordedModelRoute(handle.agent.session.events);
            if (resumedRoute !== undefined) {
                state.provider = resumedRoute.provider;
                state.model = resumedRoute.model;
            }
            state.tps = undefined;
            state.tpsSamples = [];
            state.lastUsage = undefined;
            state.workingActivity = undefined;
            state.contextWindow = undefined;
            state.contextSegments = {
                system: 0,
                prompt: 0,
                assistant: 0,
                thinking: 0,
                tools: 0,
            };
            for (const event of coalesceReplayEvents(handle.agent.session.events))
                renderEvent(event);
            settleStreaming();
            // Rebind subscriptions to the resumed agent, then free the old one.
            const oldHandle = currentHandle;
            agent = handle.agent;
            currentHandle = handle;
            bindAgent();
            refreshCommandList();
            void refreshLoadedContext();
            // Keep the `--resume` launcher contract pointing at the same session.
            writeResumeTarget(sessionId);
            // The resumed session is now the most recently used.
            touchSession(sessionId);
            state.emit();
            void oldHandle?.dispose().catch(() => { });
            return true;
        },
        async newSession() {
            // `/new` — start a fresh conversation: brand-new agent + session, the
            // transcript reset, the `--resume` marker forgotten (the old session
            // stays persisted for /resume). Same reset shape as rewindTo/resumeTo.
            if (state.working) {
                state.notify('Cannot start a new session while a turn is running', {
                    color: 'warning',
                });
                return false;
            }
            const agents = ctx.get('agents');
            if (!agents) {
                state.notify('New session unavailable — agents service not loaded', {
                    color: 'error',
                });
                return false;
            }
            const sessionId = SessionId(randomUUID());
            let handle;
            // A fresh session composes the caller's DEFAULT preset: the cordis.yml
            // `preset` key wins over the persisted `/preset` choice, which wins
            // over the roster default (same precedence as activityFrames).
            const newComposed = await composePreset(ctx, options.configuredPreset ?? readPresetPref());
            // Same precedence for the route (issues #14/#30/#67): the pair resolves
            // atomically — a complete cordis.yml route wins whole, else the
            // persisted `/model` choice (a switch earlier in this run just wrote
            // it, so `/new` follows the live model) wins whole, else the startup
            // route. A stale persisted choice that the adapter catalog rejects
            // falls back to the startup route wholesale, with a warning.
            const newResolved = resolveModelRoute({ provider: options.configuredProvider, model: options.configuredModel }, readModelPref(), { provider: options.provider, model: options.model });
            const newLlm = ctx.get('llm');
            const { route, rejected } = await validateModelRoute(newLlm, newResolved, {
                provider: options.provider,
                model: options.model,
            });
            if (rejected !== undefined) {
                state.notify(t('model-route-invalid', {
                    provider: rejected.provider,
                    model: rejected.model,
                    fallback: `${route.provider}/${route.model}`,
                }), { color: 'warning', timeoutMs: 8000 });
            }
            try {
                handle = await agents.create({
                    sessionId,
                    meta: {
                        cwd: state.cwd,
                        ...(newComposed.agentPreset === undefined
                            ? {}
                            : { agentPreset: newComposed.agentPreset }),
                    },
                    agentOptions: route,
                    ...(newComposed.setup === undefined ? {} : { setup: newComposed.setup }),
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                state.notify(`New session failed · ${message}`, {
                    color: 'error',
                    timeoutMs: 8000,
                });
                return false;
            }
            streaming = undefined;
            reasoning = undefined;
            toolCards.clear();
            nextRowId = 0;
            state.rows.length = 0;
            // Goal/todo/title are session-scoped; the replay re-derives them for
            // the session being entered (or leaves them empty).
            state.todos = [];
            state.goal = undefined;
            state.sessionTitle = '';
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
            state.agentPreset = newComposed.agentPreset;
            state.model = route.model;
            state.provider = route.provider;
            state.tps = undefined;
            state.tpsSamples = [];
            state.lastUsage = undefined;
            state.workingActivity = undefined;
            state.contextWindow = undefined;
            state.contextSegments = {
                system: 0,
                prompt: 0,
                assistant: 0,
                thinking: 0,
                tools: 0,
            };
            const oldHandle = currentHandle;
            agent = handle.agent;
            currentHandle = handle;
            bindAgent();
            refreshCommandList();
            void refreshLoadedContext();
            clearResumeTarget();
            // The brand-new session becomes the most recently used.
            touchSession(handle.agent.id);
            void oldHandle?.dispose().catch(() => { });
            return true;
        },
        async switchModel(provider, model) {
            // `/model` picker Enter — switch the live model by forking the
            // conversation at its current end and continuing with a new agent
            // routed to the chosen model. Same reset shape as rewindTo/resumeTo;
            // the history replays unchanged, only the request model changes.
            if (state.working) {
                state.notify('Cannot switch models while a turn is running', {
                    color: 'warning',
                });
                return false;
            }
            const sessions = ctx.get('sessions');
            const agents = ctx.get('agents');
            if (!sessions || !agents) {
                state.notify('Model switch unavailable — session services not loaded', {
                    color: 'error',
                });
                return false;
            }
            let seed;
            try {
                // No boundary = fork the whole log (continue the conversation).
                seed = sessions.fork(agent.session).events;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                state.notify(`Cannot switch models · ${message}`, { color: 'error' });
                return false;
            }
            const childId = SessionId(randomUUID());
            let handle;
            // The forked conversation keeps the session's own preset — only the
            // request route changes (same rule as rewindTo).
            const modelComposed = await composePreset(ctx, runningPresetOf(agent.session));
            try {
                handle = await agents.create({
                    sessionId: childId,
                    seed,
                    meta: {
                        cwd: state.cwd,
                        parentSession: agent.session.id,
                        seedLength: seed.length,
                        ...(modelComposed.agentPreset === undefined
                            ? {}
                            : { agentPreset: modelComposed.agentPreset }),
                    },
                    agentOptions: { provider, model },
                    ...(modelComposed.setup === undefined ? {} : { setup: modelComposed.setup }),
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                state.notify(`Model switch failed · ${message}`, { color: 'error', timeoutMs: 8000 });
                return false;
            }
            streaming = undefined;
            reasoning = undefined;
            toolCards.clear();
            nextRowId = 0;
            state.rows.length = 0;
            // Goal/todo/title are session-scoped; the replay re-derives them for
            // the session being entered (or leaves them empty).
            state.todos = [];
            state.goal = undefined;
            state.sessionTitle = '';
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
            state.agentPreset = modelComposed.agentPreset;
            state.model = model;
            state.provider = provider;
            state.tps = undefined;
            state.tpsSamples = [];
            state.lastUsage = undefined;
            state.workingActivity = undefined;
            state.contextWindow = undefined;
            state.contextSegments = {
                system: 0,
                prompt: 0,
                assistant: 0,
                thinking: 0,
                tools: 0,
            };
            for (const event of coalesceReplayEvents(seed))
                renderEvent(event);
            settleStreaming();
            const oldHandle = currentHandle;
            agent = handle.agent;
            currentHandle = handle;
            bindAgent();
            refreshCommandList();
            void refreshLoadedContext();
            // The model-switched fork becomes the most recently used.
            touchSession(childId);
            state.emit();
            void oldHandle?.dispose().catch(() => { });
            // Persist the choice so the next boot and `/new` start on it (same
            // contract as /preset and /effort; issues #14/#30). A failed
            // write keeps the live switch but warns it will not survive a restart.
            if (!writeModelPref(provider, model)) {
                state.notify(t('model-pref-write-failed'), {
                    color: 'warning',
                });
            }
            return true;
        },
        listEfforts,
        setEffort,
        cycleMode,
        clear() {
            state.rows.length = 0;
            nextRowId = 0;
            streaming = undefined;
            reasoning = undefined;
            toolCards.clear();
            state.activeToolCount = 0;
            state.responseChars = 0;
            state.rows.push({
                id: nextRowId,
                kind: 'notice',
                text: 'Session cleared',
            });
            nextRowId += 1;
            state.emit();
        },
        notify(text, options = {}) {
            const item = {
                id: nextNotificationId++,
                text,
                color: options.color,
                timeoutMs: options.timeoutMs ?? 4000,
            };
            state.notifications.push(item);
            state.emit();
            setTimeout(() => {
                const index = state.notifications.indexOf(item);
                if (index >= 0) {
                    state.notifications.splice(index, 1);
                    state.emit();
                }
            }, item.timeoutMs);
        },
        setActivityFrames(name) {
            if (!isPresetName(name)) {
                state.notify(t('unknown-activity-preset', { name }), { color: 'error' });
                return false;
            }
            if (name === state.activityFrames) {
                state.notify(t('activity-indicator-already', { name }), { color: 'success' });
                return true;
            }
            // Persist first (pi behavior: a failed write refuses the switch) so a
            // preference that cannot be saved never silently disappears.
            if (!writeActivityFrames(name)) {
                state.notify(t('activity-pref-write-failed'), { color: 'error' });
                return false;
            }
            state.activityFrames = name;
            state.emit();
            state.notify(t('activity-indicator-switched', { name }));
            return true;
        },
        async listPresets() {
            const presets = rosterOf(ctx);
            if (presets === undefined)
                return [];
            try {
                const list = await presets.list();
                return list.map(preset => ({
                    id: preset.id,
                    ...(preset.name === undefined ? {} : { name: preset.name }),
                    ...(preset.description === undefined ? {} : { description: preset.description }),
                    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
                    isDefault: preset.id === presets.defaultId,
                }));
            }
            catch {
                return [];
            }
        },
        async switchPreset(presetId) {
            const presets = rosterOf(ctx);
            if (presets === undefined) {
                state.notify(t('preset-unavailable'), { color: 'error' });
                return false;
            }
            if (state.working) {
                state.notify(t('preset-agent-running'), { color: 'warning' });
                return false;
            }
            let target;
            try {
                target = await presets.resolve(presetId);
            }
            catch (error) {
                state.notify(t('preset-not-found', { id: presetId, err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 });
                return false;
            }
            if (target.broken !== undefined) {
                state.notify(t('preset-load-failed', { id: presetId, broken: target.broken }), { color: 'error', timeoutMs: 8000 });
                return false;
            }
            if (target.id === state.agentPreset) {
                state.notify(t('preset-already-current', { id: target.id }), { color: 'success' });
                return true;
            }
            // Official rule (dsh-agent-presets): only a session that has produced
            // nothing may swap compositions — a started session's logged tool calls
            // would strand under a different tool set. Blank = no turn ever ran.
            const blank = !agent.session.events.some(event => event.type === 'turn/start');
            if (!blank) {
                // Persist as the default for future sessions instead of failing.
                if (!writePresetPref(target.id)) {
                    state.notify(t('preset-pref-write-failed'), { color: 'error' });
                    return false;
                }
                state.notify(t('preset-locked-saved-default', { current: state.agentPreset ?? 'host', id: target.id }), { color: 'warning', timeoutMs: 8000 });
                return true;
            }
            try {
                const preset = await presets.recompose(agent.ctx, target.id);
                // The switch is a logged session fact (model-visible ⟺ logged):
                // resumes/forks of this session resolve the NEW composition. The
                // type is runtime-registered in dsh-session's known-event set but
                // not yet in its typed SessionEventMap — cast the SESSION (never
                // extract the method: `append` reads the private `this.log`, so an
                // unbound call throws "Cannot read properties of undefined").
                const session = agent.session;
                session.append('agent-preset/selected', { agentPreset: preset.id });
                state.agentPreset = preset.id;
            }
            catch (error) {
                state.notify(t('preset-switch-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 });
                return false;
            }
            state.emit();
            if (!writePresetPref(target.id)) {
                state.notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' });
                return true;
            }
            state.notify(t('preset-switched-saved', { id: target.id }), { color: 'success' });
            return true;
        },
        listModels() {
            const llm = ctx.get('llm');
            if (!llm)
                return Promise.resolve([]);
            const providers = llm.listProviders();
            return Promise.all(providers.map(provider => llm.listModels(provider.id).catch(() => [])))
                .then(lists => lists.flat());
        },
        async sideQuestion(question, options) {
            // CC /btw：无工具单轮辅助调用，重放 deriveMessages() 前缀 + 一条
            // 包装问题。tools 永不传（侧问无工具是核心语义）；usage 不回收
            // （skipCacheWrite 同义——答案不进主上下文也不进 token 计数）。
            const llm = ctx.get('llm');
            if (!llm)
                return { answer: null, error: t('btw-llm-unavailable') };
            const header = agent.session.requestHeader();
            const config = header?.config;
            const messages = [
                ...agent.session.deriveMessages(),
                createUserMessage({
                    content: [{ type: 'text', text: wrapSideQuestion(question) }],
                    source: { kind: 'plugin', plugin: 'dsh-cc-tui/btw' },
                }),
            ];
            const request = {
                provider: config?.provider ?? state.provider,
                model: config?.model ?? state.model,
                messages,
                ...(header?.system !== undefined && { system: header.system }),
                ...(config?.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
                ...(config?.temperature !== undefined && { temperature: config.temperature }),
                ...(config?.maxTokens !== undefined && { maxTokens: config.maxTokens }),
                ...(config?.stop !== undefined && { stop: [...config.stop] }),
                sessionId: agent.session.id,
                ...(options?.signal && { signal: options.signal }),
            };
            return runSideQuestion({
                stream: llm.stream.bind(llm),
                options: request,
                onText: options?.onText,
                signal: options?.signal,
            });
        },
        listFiles() {
            const fs = ctx.get('fs');
            return listFilesDeep(fs, state.cwd);
        },
        async listSessions() {
            // DSH's own session index: the persistence backend materializes one
            // entry per durable session log (headers carry cwd + createdAt).
            const persistence = ctx.get('sessionPersistence');
            if (!persistence)
                return [];
            try {
                const headers = await persistence.list();
                // 按工作目录隔离（Claude Code 的项目维度）：/resume 只列出本会话
                // 目录启动的会话，别的项目的会话不出现在选择器里。
                const local = headers.filter(header => sessionCwdMatches(state.cwd, header.cwd ?? ''));
                // MRU ordering: DSH headers carry only createdAt, so dsh-tui keeps its
                // own last-used timestamps (touchSession on resume/submit/new) and
                // falls back to createdAt for sessions never touched in this install.
                const lastUsed = readLastUsed();
                const records = local
                    .map(header => ({
                    id: header.id,
                    // Titles load lazily below (first user message); until then the
                    // cwd basename stands in (matching the status line), with a
                    // short id when absent.
                    title: basename(header.cwd ?? '') || `session ${String(header.id).slice(0, 8)}`,
                    cwd: header.cwd ?? '',
                    createdAt: header.createdAt,
                    updatedAt: lastUsed[header.id] ?? header.createdAt,
                }))
                    .sort((a, b) => b.updatedAt - a.updatedAt);
                // Title = the session's session/title event (auto: first prompt;
                // manual: /rename), else its FIRST user message — the picker's most
                // useful label. Read via the tolerant compat log reader instead of
                // persistence.load: the backend validates every event against
                // KNOWN_SESSION_EVENT_TYPES and throws the whole load on an unmarked
                // third-party type (activity/status before resume-repair), which used
                // to leave every working-activity session titled with the cwd
                // basename. An unreadable log keeps the basename fallback.
                const empty = new Set();
                for (const record of records.slice(0, SESSION_TITLE_DEPTH)) {
                    const info = readSessionTitleFromLog(String(record.id));
                    if (info === undefined)
                        continue; // keep the basename fallback
                    if (!info.hasUserMessage) {
                        // Launch artifact — a session with no user message holds no
                        // conversation to resume, so drop it from the picker (its
                        // createdAt-only updatedAt would otherwise pin it near the
                        // top forever, one per dsh-tui launch).
                        empty.add(record.id);
                        continue;
                    }
                    if (info.title !== undefined)
                        record.title = shortenTitle(info.title);
                }
                return records.filter(record => !empty.has(record.id));
            }
            catch {
                return [];
            }
        },
        setResumeTarget(sessionId) {
            writeResumeTarget(sessionId);
        },
        renameSession(title) {
            // `session/title` is a known envelope type (dsh-session-title writes
            // it for the first prompt). The append publishes through the session
            // firehose, so the event case above updates state.sessionTitle and
            // the persistence flush makes it durable for the next picker open.
            agent.session.append('session/title', { title });
            state.sessionTitle = title;
            state.emit();
        },
        compact() {
            // DSH compaction service key: `ctx.compaction` (dsh-compaction's
            // CompactionEngine; dsh-compaction-basic provides it in the example
            // leaf). Under agent presets the engine lives in the preset's isolate
            // realm, invisible from the root context — resolve through the agent's
            // scope chain first (minimal composes NO compaction: stays unavailable).
            const compactService = serviceForAgent(ctx, agent, 'compaction');
            if (!compactService) {
                state.notify('Compaction unavailable · no compaction service in this leaf', {
                    color: 'warning',
                });
                return;
            }
            if (state.working) {
                state.notify('Cannot compact while a turn is running', { color: 'warning' });
                return;
            }
            const signal = new AbortController().signal;
            state.notify('Compacting conversation…');
            void compactService
                .compactNow(agent, signal)
                .then((result) => {
                state.notify(result ? 'Conversation compacted' : 'Nothing to compact');
            })
                .catch((error) => {
                state.notify(`Compaction failed · ${error instanceof Error ? error.message : String(error)}`, { color: 'error', timeoutMs: 8000 });
            });
        },
        runExternalCommand(name, rawInput) {
            return executeRegistryCommand(name, rawInput);
        },
        pushLocal(title, lines) {
            state.rows.push({ id: nextRowId++, kind: 'local', text: title });
            for (const line of lines) {
                state.rows.push({
                    id: nextRowId++,
                    kind: 'local-output',
                    text: preview(line, LOCAL_OUTPUT_LIMIT),
                });
            }
            state.emit();
        },
        mcpStatus() {
            // MCP tools land on the tool runtime under mcp__<server>__<tool>
            // public names (dsh-mcp-client's naming contract); group by server.
            const runtime = ctx.get('tools');
            const schemas = runtime?.schemas() ?? [];
            const byServer = new Map();
            for (const schema of schemas) {
                const match = schema.name.match(/^mcp__([a-z0-9-]+)__(.+)$/);
                if (!match)
                    continue;
                const list = byServer.get(match[1]) ?? [];
                list.push(match[2]);
                byServer.set(match[1], list);
            }
            if (byServer.size === 0) {
                return [
                    t('mcp-none-configured'),
                    t('mcp-insert-hint'),
                    '  - insert:',
                    '      - id: mcp-context7',
                    "        name: '@deepseek-ai/dsh-mcp-client'",
                    '        config: { transport: stdio, serverName: context7, command: npx, args: ["-y", "@upstash/context7-mcp"] }',
                    t('mcp-readme-hint'),
                ];
            }
            const lines = [];
            for (const [server, tools] of byServer) {
                lines.push(t('mcp-server-tools', { server, count: tools.length, tools: tools.join(', ') }));
            }
            return lines;
        },
        exportSession() {
            // Export from the session log — the authoritative, complete record —
            // not the bounded transcript window (folded rows keep only previews).
            const parts = [
                t('export-title'),
                '',
                t('export-time', { time: new Date().toLocaleString() }),
                t('export-model', { model: state.model }),
                t('export-session', { id: state.agentId }),
                t('export-dir', { cwd: state.cwd }),
                '',
            ];
            for (const event of agent.session.events) {
                switch (event.type) {
                    case 'user/message': {
                        if (event.data.source.kind !== 'user')
                            break;
                        // Export what the user SAW: the typed prompt, not the expanded
                        // `@`-mention attachment blocks.
                        const text = firstTextOf(event.data.content);
                        if (text)
                            parts.push(`${t('export-user-section')}\n\n${text}\n`);
                        break;
                    }
                    case 'assistant/message': {
                        const blocks = event.data.message.content;
                        for (const block of blocks) {
                            if (block.type === 'reasoning' && block.text) {
                                parts.push(`${t('export-thinking-section')}\n\n${block.text}\n`);
                            }
                            else if (block.type === 'text' && block.text) {
                                parts.push(`${t('export-assistant-section')}\n\n${block.text}\n`);
                            }
                        }
                        break;
                    }
                    case 'tool/call': {
                        parts.push(`${t('export-tool-section', { name: event.data.name })}\n\n\`\`\`json\n${event.data.arguments}\n\`\`\`\n`);
                        break;
                    }
                    case 'tool/result': {
                        const block = event.data.message.content[0];
                        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
                        if (block.type === 'tool-result') {
                            const text = textOf(block.content);
                            if (text)
                                parts.push(`${t('export-result-section')}\n\n\`\`\`\n${text}\n\`\`\`\n`);
                        }
                        break;
                    }
                    default:
                        break;
                }
            }
            const fileName = `dsh-tui-export-${Date.now()}.md`;
            try {
                const target = join(state.cwd, fileName);
                writeFileSync(target, parts.join('\n'), 'utf8');
                return target;
            }
            catch {
                return null;
            }
        },
        initWorkspace() {
            const target = join(state.cwd, 'AGENTS.md');
            if (existsSync(target))
                return 'exists';
            const template = [
                '# AGENTS.md',
                '',
                t('agentsmd-project'),
                '',
                t('agentsmd-project-body'),
                '',
                t('agentsmd-conventions'),
                '',
                t('agentsmd-convention-read'),
                t('agentsmd-convention-style'),
                '',
            ].join('\n');
            try {
                writeFileSync(target, template, 'utf8');
                return target;
            }
            catch {
                return null;
            }
        },
        doctorInfo() {
            const lines = [];
            lines.push(`Node ${process.version} · ${process.platform} ${process.arch}`);
            lines.push(`${t('doctor-api-key', { state: process.env.DEEPSEEK_API_KEY ? t('doctor-key-configured') : t('doctor-key-missing') })}`);
            lines.push(t('doctor-model', { model: state.model, provider: options.provider }));
            lines.push(t('doctor-cwd', { cwd: state.cwd }));
            lines.push(t('doctor-context-window', { window: state.contextWindow ?? t('doctor-unknown') }));
            lines.push(`${t('doctor-session', { id: state.agentId })}${state.sessionTitle ? ' · ' + state.sessionTitle : ''}`);
            const userHome = process.env.USERPROFILE ?? homedir();
            const configCandidates = [
                join(userHome, '.dsh-cc/cordis.yml'),
                join(userHome, '.dsh/profiles/dsh-tui/cordis.patch.yml'),
            ];
            for (const candidate of configCandidates) {
                lines.push(`${t('doctor-config', { candidate, state: existsSync(candidate) ? '✓' : t('doctor-config-missing') })}`);
            }
            const sessionsDir = join(userHome, '.dsh-cc/sessions');
            lines.push(`${t('doctor-storage', { dir: sessionsDir, state: existsSync(sessionsDir) ? '✓' : t('doctor-storage-uninit') })}`);
            return lines;
        },
        async listSubagents() {
            const subagents = ctx.get('subagents');
            if (!subagents)
                return [t('subagent-not-mounted')];
            try {
                const children = await subagents.listChildren(agent.session.id);
                if (children.length === 0)
                    return [t('subagent-none')];
                return children.map((child) => {
                    const id = typeof child.id === 'string' ? child.id : (child.id.value ?? '');
                    const label = child.label ? `「${child.label}」` : '';
                    const mode = child.mode === 'continuable' ? t('subagent-resumable') : t('subagent-oneshot');
                    return `${t('subagent-row', { mode, label, activity: child.activity === 'running' ? t('subagent-running') : t('subagent-archived'), id: id.slice(0, 8) })}`;
                });
            }
            catch (error) {
                return [t('subagent-query-failed', { err: error instanceof Error ? error.message : String(error) })];
            }
        },
        traceEvents() {
            // Immutable per-append snapshot (dsh-session caches the frozen array);
            // reads follow agent swaps (/resume /rewind /new) automatically.
            return agent.session.events;
        },
    };
    /**
     * Assemble the context a fresh conversation for the live agent will load,
     * for the startup panel: the system prompt (sections + dynamic context +
     * tools), the workspace instruction files baseline discovery would
     * inject, and the skill catalog. Runs at boot and on every agent swap;
     * every source degrades independently, and a total failure leaves the
     * panel hidden instead of showing a broken snapshot. A snapshot computed
     * for a previous agent is discarded (swaps rebind `agent` mid-flight).
     */
    const refreshLoadedContext = async () => {
        const target = agent;
        const sections = [];
        const contexts = [];
        const files = [];
        const skills = [];
        const tools = [];
        try {
            const systemPrompt = ctx.get('systemPrompt');
            if (systemPrompt !== undefined) {
                const assembly = await systemPrompt.assemble(assembleContextFor(target));
                if (target !== agent)
                    return;
                // Render each section through the shared strict interpolator with
                // this assembly's variables (renderPrompt joins; a single-section
                // assembly renders exactly one section), keeping non-empty results.
                for (const section of assembly.sections) {
                    const text = renderPrompt({
                        sections: [section],
                        contexts: [],
                        tools: [],
                        variables: assembly.variables,
                    });
                    if (text.length > 0)
                        sections.push({ name: section.name, text });
                }
                contexts.push(...renderContextSections(assembly));
                for (const tool of assembly.tools) {
                    tools.push({ name: tool.name, description: tool.description ?? '' });
                }
            }
            const discovered = await discoverBaselineInstructionFiles({ cwd: state.cwd });
            if (target !== agent)
                return;
            files.push(...discovered.map(file => ({ displayPath: file.displayPath })));
            // The skills registry is host-plane but scope-layered: preset rows
            // (skill-filesystem) register into the preset's layer, so the catalog
            // must be read through the agent's scope chain (serviceForAgent falls
            // back to the host context when no roster is mounted).
            const skillsService = serviceForAgent(ctx, target, 'skills');
            if (skillsService !== undefined) {
                const catalog = await skillsService.list({});
                if (target !== agent)
                    return;
                skills.push(...catalog.map(skill => ({
                    name: skill.name,
                    description: skill.description,
                })));
            }
        }
        catch (error) {
            ctx.logger.warn('loaded-context snapshot failed: %o', error);
            return;
        }
        state.loadedContext = { sections, contexts, files, skills, tools };
        state.emit();
    };
    /**
     * Rebuild the merged slash-command list from the registry. Registry
     * registrations are global or agent-scoped, so this runs on
     * `commands/change` and again whenever the live agent is swapped
     * (rewind/resume).
     */
    const refreshCommandList = () => {
        const merged = [...LOCAL_COMMANDS];
        if (commandService) {
            for (const descriptor of commandService.list(agent)) {
                if (merged.some(command => command.name === descriptor.name))
                    continue;
                merged.push({
                    name: descriptor.name,
                    description: descriptor.description,
                    tag: descriptor.input?.hint,
                    external: true,
                });
            }
        }
        state.commandList = merged;
        state.emit();
    };
    ctx.on('commands/change', refreshCommandList);
    refreshCommandList();
    void refreshLoadedContext();
    let nextRowId = 0;
    /** The leaf's bash executor (dsh-bash-local in the example leaf) — the DSH
   *  execution seam for local `!` commands and the git status breadcrumb. The
   *  service registers under `ctx.shell` (ShellExecutor; dsh-bash-local and
   *  dsh-pwsh-local are the providers). */
    const bash = ctx.get('shell');
    /** Claude Code's `!` mode: run a command on the user's machine and render its
   *  output in the transcript as local rows (never sent to the model). */
    const runLocalCommand = async (command, includeInContext) => {
        state.rows.push({ id: nextRowId++, kind: 'local', text: command });
        state.emit();
        let output = '(no output)';
        if (bash) {
            try {
                const spec = bash.resolve({
                    command,
                    workdir: state.cwd,
                    timeoutMs: 30000,
                });
                const result = await bash.run(spec);
                output =
                    result.stdout.text.trim() ||
                        result.stderr.text.trim() ||
                        (result.timedOut ? '(timed out)' : '(no output)');
            }
            catch (error) {
                output = error instanceof Error ? error.message : String(error);
            }
        }
        state.rows.push({
            id: nextRowId++,
            kind: 'local-output',
            text: preview(output, LOCAL_OUTPUT_LIMIT),
        });
        state.emit();
        if (includeInContext) {
            // CC's <bash-stdout> envelope: the model treats the output as the
            // result of a local command the user just ran.
            agent.followup(createUserMessage({
                content: [{
                        type: 'text',
                        text: `<bash-stdout>
${output}
</bash-stdout>`,
                    }],
                source: { kind: 'user' },
            }));
        }
    };
    /** The in-progress assistant text row; `undefined` when no step is streaming. */
    let streaming;
    /** The in-progress reasoning row; `undefined` when no reasoning is streaming. */
    let reasoning;
    /** Reasoning rows sealed by an assistant/message this turn. They stay
     *  `streaming: true` — expanded in the transcript — until turn/end folds
     *  them (WebUI AssistantMarkdown keepOpen parity: thinking holds open
     *  through the whole in-flight turn, tool-call steps included). */
    const sealedReasoning = [];
    /** Wall-clock start of the current reasoning row (durationMs on settle). */
    let reasoningStart = 0;
    /** Decode-throughput fold for the current turn. DSH defines one step as
     *  one model call plus its tools; summing only first-token → message spans
     *  excludes tool execution and per-request TTFT from generation speed. */
    let tpsTurn;
    let tpsBeforeTurn;
    let tpsTurnDecodeMs = 0;
    let tpsTurnDecodeTokens = 0;
    let tpsTurnSampled = false;
    let tpsStep;
    /** Tool cards by callId, so tool/result can settle the running card. */
    const toolCards = new Map();
    /** The host-plane tools registry (dsh-tools). Resolved once; absent in
     *  bare embedders — every presenter call soft-fails to undefined and the
     *  card falls back to raw text. */
    const toolsRegistry = ctx.get('tools');
    /** Ask the producing tool how its call should render (diff/terminal/…).
     *  Scoped to the live agent so preset-owned tool definitions resolve —
     *  the dsh-host-apiproxy presenter pattern. Unknown tool, unparseable
     *  args, or a throwing presenter all degrade to the plain text card. */
    const presentCallView = (name, rawArgs) => {
        try {
            const tool = toolsRegistry?.get(name, agent);
            if (tool?.presentCall === undefined)
                return undefined;
            return tool.presentCall(JSON.parse(rawArgs));
        }
        catch {
            return undefined;
        }
    };
    /** Same for the settled result; `meta` is the tool-private presentation
     *  payload the tool attached to its tool/result event (dsh-tool-fs reads
     *  its result-time contextual diff back from here). */
    const presentResultView = (name, rawArgs, data) => {
        try {
            const tool = toolsRegistry?.get(name, agent);
            if (tool?.presentResult === undefined)
                return undefined;
            const block = data.message.content[0];
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
            const content = block !== undefined && block.type === 'tool-result' ? block.content : [];
            return tool.presentResult(JSON.parse(rawArgs), {
                content,
                isError: block?.isError === true,
                ...(data.meta !== undefined ? { meta: data.meta } : {}),
            });
        }
        catch {
            return undefined;
        }
    };
    // ContentBlockMap is merge-extensible: plugin-added block types are
    // silently skipped (v1 renders text blocks only) — never crashes.
    const textOf = (content) => (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim();
    /**
     * Transcript-facing text of a user message: the FIRST text block only.
     * `@`-mention attachments (issue #15) ride as later blocks — model-facing
     * only — so joining every block would dump file contents into the bubble,
     * the sticky header, and session titles.
     */
    const firstTextOf = (content) => (content ?? []).find(block => block.type === 'text')?.text.trim() ?? '';
    const ensureStreaming = (seq) => {
        if (streaming === undefined) {
            streaming = { id: nextRowId, kind: 'assistant', text: '', streaming: true, ...seq !== undefined ? { seq } : {} };
            nextRowId += 1;
            state.rows.push(streaming);
        }
        return streaming;
    };
    const ensureReasoning = (seq) => {
        if (reasoning === undefined) {
            reasoningStart = Date.now();
            reasoning = { id: nextRowId, kind: 'reasoning', text: '', streaming: true, ...seq !== undefined ? { seq } : {} };
            nextRowId += 1;
            state.rows.push(reasoning);
            logForDebugging('thinking: reasoning row open (expanded)');
        }
        return reasoning;
    };
    const settleStreaming = () => {
        if (streaming !== undefined)
            streaming.streaming = false;
        streaming = undefined;
        const folded = sealedReasoning.length + (reasoning !== undefined ? 1 : 0);
        for (const row of sealedReasoning)
            row.streaming = false;
        sealedReasoning.length = 0;
        if (reasoning !== undefined) {
            reasoning.streaming = false;
            reasoning.durationMs = Math.max(0, Date.now() - reasoningStart);
        }
        reasoning = undefined;
        if (folded > 0)
            logForDebugging(`thinking: folded ${folded} reasoning row(s) at turn settle`);
    };
    /** Recompute the spinner phase from live row/tool state. */
    const updateSpinnerMode = () => {
        if (state.activeToolCount > 0) {
            state.spinnerMode = 'tool-use';
        }
        else if (reasoning !== undefined) {
            // Only LIVE reasoning counts — sealed rows stay streaming=true for
            // transcript expansion until turn/end but the model is past thinking.
            state.spinnerMode = 'thinking';
        }
        else if (streaming !== undefined) {
            state.spinnerMode = 'responding';
        }
        else {
            state.spinnerMode = 'requesting';
        }
    };
    /**
     * Fold one goal-sourced message into the channel's goal projection.
     * Round-zero goal messages carry the full durable snapshot (or a clear
     * tombstone) in their source; positive-round messages are admitted
     * continuation prompts that only advance the rounds counter.
     */
    const applyGoalEvent = (event) => {
        const source = event.data.source;
        if (source.round > 0) {
            // Admitted continuation round — the snapshot itself is unchanged.
            if (state.goal !== undefined) {
                state.goal = {
                    ...state.goal,
                    roundsStarted: Math.max(state.goal.roundsStarted, source.round),
                };
            }
            return;
        }
        const change = source.change;
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may not match the static type
        if (change === undefined || change.kind !== 'goal/change')
            return;
        if (change.operation === 'clear') {
            state.goal = undefined;
        }
        else if (change.goal !== undefined) {
            state.goal = {
                ...change.goal,
                roundsStarted: change.roundsStarted ?? state.goal?.roundsStarted ?? 0,
            };
        }
    };
    const renderEvent = (event) => {
        switch (event.type) {
            case 'user/message': {
                // Compaction checkpoint: `source = { kind: 'plugin', plugin:
                // 'compact' }` (dsh-compact's COMPACT_CHECKPOINT_SOURCE). CC shows
                // the framed summary after /compact; render it as a Divider title +
                // a summary row that defaults folded (`compact` kind) instead of
                // skipping it like other injected context.
                if (event.data.source.kind === 'plugin' &&
                    event.data.source.plugin === 'compact') {
                    const summary = textOf(event.data.content);
                    state.rows.push({ id: nextRowId, kind: 'notice', text: 'Conversation compacted' });
                    nextRowId += 1;
                    if (summary) {
                        state.rows.push({ id: nextRowId, kind: 'compact', text: summary });
                        nextRowId += 1;
                    }
                    // The surface replace drops the whole pre-compact history: reset
                    // the context accounting NOW so the status bar (ctx bar, tokens,
                    // context-low warning) drops immediately instead of waiting for
                    // the next request's usage event.
                    const removed = state.contextSegments.prompt +
                        state.contextSegments.assistant +
                        state.contextSegments.thinking +
                        state.contextSegments.tools;
                    const summaryTokens = estimateTokens(summary);
                    state.tokens.input = Math.max(0, state.tokens.input - removed) + summaryTokens;
                    state.contextSegments = {
                        system: state.contextSegments.system,
                        prompt: summaryTokens,
                        assistant: 0,
                        thinking: 0,
                        tools: 0,
                    };
                    state.lastUsage = {
                        input: state.contextSegments.system + summaryTokens,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                    };
                    contextWarned = false;
                    break;
                }
                // Same-session goal domain: round-zero goal-sourced messages carry
                // the durable goal snapshot (or clear tombstone) in their source.
                // They are not transcript bubbles — they drive the goal panel's
                // live projection (replayed on resume/rewind like every other event).
                if (event.data.source.kind === 'goal') {
                    applyGoalEvent(event);
                    break;
                }
                // Injected context (plugin/skill source) is not a human bubble; v1
                // renders direct human prompts only.
                if (event.data.source.kind !== 'user')
                    break;
                const text = firstTextOf(event.data.content);
                if (text) {
                    state.rows.push({ id: nextRowId, kind: 'user', text, seq: event.seq });
                    state.lastUserText = text;
                    // The context estimate counts everything sent to the model —
                    // typed text AND the `@`-mention attachment blocks.
                    state.contextSegments.prompt += estimateTokens(textOf(event.data.content));
                    nextRowId += 1;
                }
                break;
            }
            case 'step/start': {
                if (tpsTurn === event.data.turn) {
                    tpsStep = {
                        turn: event.data.turn,
                        step: event.data.step,
                        firstTokenTime: undefined,
                        outputChars: 0,
                    };
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = event.data.chunk;
                if (chunk.type === 'text-delta') {
                    if (chunk.text) {
                        ensureStreaming(event.seq).text += chunk.text;
                        state.responseChars += chunk.text.length;
                    }
                }
                else if (chunk.type === 'reasoning-delta') {
                    if (chunk.text)
                        ensureReasoning(event.seq).text += chunk.text;
                }
                const step = tpsStep;
                if (step !== undefined &&
                    step.turn === event.data.turn &&
                    step.step === event.data.step &&
                    isTokenDelta(chunk)) {
                    step.firstTokenTime ??= event.time;
                    step.outputChars += tokenDeltaChars(chunk);
                    const elapsedMs = Math.max(0, event.time - step.firstTokenTime);
                    if (elapsedMs > 500) {
                        const decodeMs = tpsTurnDecodeMs + elapsedMs;
                        const outputTokens = tpsTurnDecodeTokens + Math.ceil(step.outputChars / 4);
                        state.tps = outputTokens / (decodeMs / 1000);
                    }
                }
                updateSpinnerMode();
                break;
            }
            case 'assistant/message': {
                const row = ensureStreaming(event.seq);
                row.time = event.time;
                const text = textOf(event.data.message.content);
                if (text)
                    row.text = text;
                row.streaming = false;
                streaming = undefined;
                if (reasoning !== undefined) {
                    // Seal, don't fold: the per-step duration settles here, but the
                    // row keeps streaming=true (expanded) until turn/end — WebUI
                    // keepOpen parity. The next step's reasoning opens a fresh row.
                    reasoning.durationMs = Math.max(0, Date.now() - reasoningStart);
                    sealedReasoning.push(reasoning);
                    logForDebugging(`thinking: step sealed (${reasoning.durationMs}ms), expanded until turn/end`);
                }
                reasoning = undefined;
                updateSpinnerMode();
                const usage = event.data.usage;
                if (usage !== undefined) {
                    // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
                    state.tokens.input += usage.inputTokens ?? 0;
                    // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
                    state.tokens.output += usage.outputTokens ?? 0;
                    // The most recent request's usage describes the CURRENT context:
                    // input (uncached) + cache hits all occupy the window. Cache hits
                    // also drive the status-line `cache N` readout.
                    state.lastUsage = {
                        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
                        input: usage.inputTokens ?? 0,
                        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
                        output: usage.outputTokens ?? 0,
                        cacheRead: usage.cacheReadTokens ?? 0,
                        cacheWrite: usage.cacheWriteTokens ?? 0,
                    };
                }
                const tpsMessageStep = tpsStep;
                if (tpsTurn === event.data.turn &&
                    tpsMessageStep !== undefined &&
                    tpsMessageStep.turn === event.data.turn &&
                    tpsMessageStep.step === event.data.step &&
                    tpsMessageStep.firstTokenTime !== undefined) {
                    const outputTokens = usageOutputTokens(usage)
                        ?? (tpsMessageStep.outputChars > 0
                            ? Math.ceil(tpsMessageStep.outputChars / 4)
                            : undefined);
                    if (outputTokens !== undefined) {
                        tpsTurnDecodeMs += Math.max(0, event.time - tpsMessageStep.firstTokenTime);
                        tpsTurnDecodeTokens += outputTokens;
                        tpsTurnSampled = true;
                        if (tpsTurnDecodeMs > 0) {
                            state.tps = tpsTurnDecodeTokens / (tpsTurnDecodeMs / 1000);
                        }
                    }
                }
                if (tpsMessageStep !== undefined &&
                    tpsMessageStep.turn === event.data.turn &&
                    tpsMessageStep.step === event.data.step) {
                    tpsStep = undefined;
                }
                // Context-bar segmentation (pi-nano-context style): assistant text
                // and tool calls in the assistant segment, thinking separately.
                for (const block of event.data.message.content) {
                    if (block.type === 'text' && block.text) {
                        state.contextSegments.assistant += estimateTokens(block.text);
                    }
                    else if (block.type === 'reasoning' && block.text) {
                        state.contextSegments.thinking += estimateTokens(block.text);
                    }
                }
                break;
            }
            case 'tool/call': {
                // The ask-user-question tool renders as the interactive questionnaire
                // panel (DSH user-interaction seam), not as a tool card: the model is
                // parked waiting for the human, so no running card, no active-tool
                // spinner, no args noise in the transcript. The Q&A summary is pushed
                // by the TUI once the batch is answered; tool/result for a call with
                // no card is a no-op below.
                if (event.data.name === 'ask_user_question')
                    break;
                const card = {
                    id: nextRowId,
                    kind: 'tool',
                    text: '',
                    seq: event.seq,
                    tool: {
                        callId: event.data.callId,
                        name: event.data.name,
                        argsText: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
                        argsFull: event.data.arguments,
                        status: 'running',
                        callView: presentCallView(event.data.name, event.data.arguments),
                        startedAt: Date.now(),
                    },
                };
                nextRowId += 1;
                toolCards.set(event.data.callId, card);
                state.rows.push(card);
                state.activeToolCount += 1;
                state.contextSegments.assistant += estimateTokens(`${event.data.name}${event.data.arguments}`);
                updateSpinnerMode();
                break;
            }
            case 'tool/result': {
                const card = toolCards.get(event.data.message.source.callId);
                if (card !== undefined && card.tool !== undefined) {
                    card.tool.durationMs = Math.max(0, Date.now() - card.tool.startedAt);
                    const failure = event.data.error;
                    if (failure !== undefined) {
                        card.tool.status = 'error';
                        const errorText = `${failure.name}: ${failure.code}`;
                        card.tool.errorText = errorText;
                        state.contextSegments.tools += estimateTokens(errorText);
                    }
                    else {
                        card.tool.status = 'ok';
                        const block = event.data.message.content[0];
                        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
                        const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : '';
                        card.tool.resultFull = result || undefined;
                        card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined;
                        // The tool's own settled-state view (applied diff, terminal
                        // output, read content…) wins over the raw text body. argsFull
                        // pairs the args: live cards are never folded, so it is intact.
                        card.tool.resultView = presentResultView(card.tool.name, card.tool.argsFull ?? '', event.data);
                        state.contextSegments.tools += estimateTokens(result);
                    }
                    state.activeToolCount = Math.max(0, state.activeToolCount - 1);
                    // The card is settled: no later event looks it up by callId, so
                    // drop the index entry. The card itself stays in state.rows
                    // (bounded by MAX_ROWS + foldRows, which also drops the full
                    // args/result payloads of folded cards).
                    toolCards.delete(event.data.message.source.callId);
                    updateSpinnerMode();
                }
                break;
            }
            case 'step/end': {
                if (tpsStep !== undefined &&
                    tpsStep.turn === event.data.turn &&
                    tpsStep.step === event.data.step) {
                    tpsStep = undefined;
                }
                break;
            }
            case 'turn/start': {
                state.working = true;
                state.turnStart = Date.now();
                state.responseChars = 0;
                state.spinnerMode = 'requesting';
                // Keep the prior turn visible until this turn produces a measurable
                // decode span, while starting a fresh weighted step fold.
                tpsBeforeTurn = state.tps;
                tpsTurn = event.data.turn;
                tpsTurnDecodeMs = 0;
                tpsTurnDecodeTokens = 0;
                tpsTurnSampled = false;
                tpsStep = undefined;
                break;
            }
            case 'turn/end': {
                settleStreaming();
                state.working = false;
                state.activeToolCount = 0;
                if (tpsTurn !== undefined && tpsTurn === event.data.turn) {
                    if (tpsTurnSampled && tpsTurnDecodeMs > 0) {
                        const turnTps = tpsTurnDecodeTokens / (tpsTurnDecodeMs / 1000);
                        state.tps = turnTps;
                        state.tpsSamples.push({ tps: turnTps, at: event.time });
                        if (state.tpsSamples.length > 500)
                            state.tpsSamples.shift();
                    }
                    else {
                        // Do not leave a chars/4 live estimate behind when no completed
                        // decode sample exists for this turn.
                        state.tps = tpsBeforeTurn;
                    }
                    tpsTurn = undefined;
                    tpsStep = undefined;
                    tpsTurnDecodeMs = 0;
                    tpsTurnDecodeTokens = 0;
                    tpsTurnSampled = false;
                }
                const reason = event.data.reason;
                if (reason.kind === 'completed') {
                    checkContextWarning();
                    break;
                }
                if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
                    // `Agent.cancel()` closes the turn as `aborted`; `interrupted`
                    // only appears for crash-orphaned turns. Claude Code renders both
                    // user-interruption paths as a distinct dim row.
                    state.rows.push({
                        id: nextRowId,
                        kind: 'interrupt',
                        text: 'Interrupted · What should Claude do instead?',
                    });
                    nextRowId += 1;
                    break;
                }
                const detail = reason.kind === 'error' ? reason.error.message : '';
                state.rows.push({ id: nextRowId, kind: 'notice', text: `turn ${reason.kind}${detail ? ` · ${detail}` : ''}` });
                nextRowId += 1;
                state.notify(`Turn ${reason.kind}${detail ? ` · ${detail}` : ''}`, { color: 'error', timeoutMs: 8000 });
                break;
            }
            case 'request/context':
                // Adapter-advertised context capacity; drives the context-low
                // warning (CC's TokenWarning) when the route reports one.
                if (event.data.contextWindow !== undefined) {
                    state.contextWindow = event.data.contextWindow;
                }
                break;
            case 'request/header': {
                // Reasoning effort readout (status line): the header carries the
                // conversation's call config (provider/model/effort/sampling). The
                // system prompt text seeds the context bar's system segment.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may lack header config
                const effort = event.data.header.config?.reasoningEffort;
                if (typeof effort === 'string') {
                    state.reasoningEffort = effort;
                }
                if (typeof event.data.header.system === 'string') {
                    state.contextSegments.system = estimateTokens(event.data.header.system);
                }
                break;
            }
            case 'session/title':
                state.sessionTitle = event.data.title;
                break;
            case 'todo/write':
                // Whole-list snapshot — latest write wins; log-only UI state.
                state.todos = event.data.todos;
                break;
            default:
                // Logged preset switch (blank sessions only, issue #8): a transcript
                // marker so a replayed log shows which composition produced the
                // turns after it. Not in dsh-session's typed union — matched here by
                // name, the way `activity/status` is consumed in bindAgent.
                if (event.type === 'agent-preset/selected') {
                    const data = event.data;
                    state.rows.push({
                        id: nextRowId,
                        kind: 'notice',
                        text: t('agent-preset-switched', { preset: data.agentPreset ?? 'unknown' }),
                    });
                    nextRowId += 1;
                }
                break;
        }
    };
    // Replay the durable transcript first, then follow live events.
    for (const event of coalesceReplayEvents(agent.session.events))
        renderEvent(event);
    settleStreaming();
    // Attached to an idle agent: any replayed turn/start belongs to a previous
    // session run, so the spinner must not come up on boot.
    state.working = false;
    state.status = agent.status;
    state.emit();
    // Live subscription list, rebound to a fresh agent by rewindTo.
    let agentSubscriptions = [];
    const bindAgent = () => {
        for (const dispose of agentSubscriptions)
            dispose();
        // Re-couple the channel-owned model selection to the new agent's
        // assembly/request waterfalls, then re-apply the persisted effort when
        // this agent's route offers it (dsh-agent installModelSelection).
        selection.current = undefined;
        selection.assembled = undefined;
        void applyPreferredEffort();
        refreshMode();
        agentSubscriptions = [
            installModelSelection(agent.ctx, selection),
            ctx.on('agent/status', ({ agent: subject, status }) => {
                if (subject !== agent)
                    return;
                state.status = status;
                state.emit();
            }),
            ctx.on('agent/disposed', ({ agent: subject }) => {
                if (subject !== agent)
                    return;
                state.status = 'disposed';
                state.emit();
            }),
            // Pending delivery is driven by the agent inbox: a claimed message
            // has landed in a turn (steer → step boundary, followup → next turn);
            // a discarded one was dropped by a cancel or withdrawn via Alt+Up.
            // Retire it from the preview. Official dsh-agent rc.6 emits these as
            // single-payload notifications `{ agent, message }`; `inserted` is not
            // handled here because trackPending already registered the preview
            // synchronously at submit time.
            (() => {
                const retirePending = (payload) => {
                    if (payload.agent !== agent)
                        return;
                    const messageId = payload.message?.id;
                    if (typeof messageId !== 'string')
                        return;
                    const before = state.pending.length;
                    state.pending = state.pending.filter(item => item.id !== messageId);
                    if (state.pending.length !== before)
                        state.emit();
                };
                const disposers = [];
                for (const event of ['agent/inbox/claimed', 'agent/inbox/discarded']) {
                    disposers.push(ctx.on(event, retirePending));
                }
                return () => {
                    for (const dispose of disposers)
                        dispose();
                };
            })(),
            ctx.on('session/event', (session, event) => {
                if (session !== agent.session)
                    return;
                // Live working-activity snapshot (log-only event, appended by
                // dsh-working-activity for UI consumers). Consumed here — NOT in
                // renderEvent — so replayed history never resurrects a stale line
                // (the renderEvent switch's default arm ignores it on replay).
                if (options.activity !== false &&
                    event.type === 'activity/status') {
                    const data = event.data;
                    state.workingActivity = {
                        phase: data.phase,
                        line: data.line,
                        toolCount: data.toolCount ?? 0,
                        turnElapsedMs: data.turnElapsedMs ?? 0,
                        ...(data.label === undefined ? {} : { label: data.label }),
                        ...(data.detail === undefined ? {} : { detail: data.detail }),
                        ...(data.phrase === undefined ? {} : { phrase: data.phrase }),
                    };
                    state.emit();
                    return;
                }
                // Mode-affecting atoms fold into the Shift+Tab mode indicator the
                // moment they land (whether appended by cycleMode or by hand).
                const eventType = event.type;
                if (eventType === 'plan/mode' || eventType === 'sandbox/mode' || eventType === 'approval/policy') {
                    refreshMode();
                }
                renderEvent(event);
                // Streaming deltas (one event per token) take the frame-aligned
                // path; every other event keeps synchronous notification.
                if (event.type === 'assistant/chunk')
                    state.emitStream();
                else
                    state.emit();
            }),
        ];
    };
    bindAgent();
    // Statusline breadcrumb: current git branch of the session cwd (best-effort).
    // Re-run when an agent swap adopts a different persisted cwd (/resume,
    // issue #96) so the breadcrumb never shows the previous workspace's branch.
    const refreshGitBranch = () => {
        state.gitBranch = undefined;
        if (!bash)
            return;
        // Capture the requested cwd: a /resume landing while this query is in
        // flight refreshes the branch for the NEW cwd, so a late reply from the
        // old workspace must be dropped (statusline staleness, issue #96 review).
        const requestedCwd = state.cwd;
        void bash
            .run(bash.resolve({
            command: 'git branch --show-current',
            workdir: requestedCwd,
            timeoutMs: 3000,
        }))
            .then((result) => {
            if (state.cwd !== requestedCwd)
                return;
            const branch = result.stdout.text.trim();
            if (branch !== '') {
                state.gitBranch = branch;
                state.emit();
            }
        })
            .catch(() => {
            // Git branch detection is best-effort; on Windows the sandbox
            // backend may be unavailable (no confinement yet) or the cwd may
            // not be a git repo. Either way the statusline simply stays blank.
        });
    };
    refreshGitBranch();
    return state;
}
/** Path basename for the resume-list title (`C:/a/b` → `b`). */
function basename(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? path;
}
/** Normalize a cwd for comparison: forward slashes, no trailing slash; case
 *  folded when the platform's filesystem semantics are case-insensitive. */
function normalizeCwd(path, caseInsensitive) {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? normalized.toLowerCase() : normalized;
}
/**
 * `/resume` project filter (issue #96): exact cwd match, PLUS sessions
 * recorded in a subdirectory — pre-upgrade launches recorded the launch
 * subdirectory as the header cwd, and with the cwd default now resolving to
 * the git worktree root an exact match would hide those sessions forever.
 * They belong to the same workspace, so they stay listed. Comparison follows
 * the platform's filesystem semantics (case-insensitive on Windows — a
 * pre-upgrade header may record `C:\Repo` where the current launch resolves
 * `c:\repo`). `caseInsensitive` is a parameter (not a platform read) so the
 * verifier can exercise both modes on any host. Exported for
 * scripts/verify-session-cwd.mjs.
 */
export function sessionCwdMatches(stateCwd, headerCwd, caseInsensitive = process.platform === 'win32') {
    const cwd = normalizeCwd(stateCwd, caseInsensitive);
    const recorded = normalizeCwd(headerCwd, caseInsensitive);
    return recorded === cwd || (cwd !== '' && recorded.startsWith(`${cwd}/`));
}
/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/** Character payload of one token-bearing stream delta for the live fallback. */
function tokenDeltaChars(chunk) {
    switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
            return chunk.text.length;
        case 'tool-call-delta':
            return (chunk.name?.length ?? 0) + chunk.argumentsDelta.length;
        default:
            return 0;
    }
}
/** Provider output count when usable; durable imports may predate strict validation. */
function usageOutputTokens(usage) {
    if (typeof usage !== 'object' || usage === null)
        return undefined;
    const value = usage.outputTokens;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}
/**
 * Recursive `@` file listing through the leaf's fs service (dsh-fs-local):
 * walks up to MAX_DEPTH levels below `root`, skipping VCS/dependency dirs,
 * returning relative paths (directories with a trailing `/`, matching the
 * FileSuggestions tag logic) capped at MAX_FILES entries. Best-effort —
 * unreadable subtrees are skipped, not fatal.
 */
async function listFilesDeep(fs, root) {
    if (!fs)
        return [];
    const out = [];
    const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist', 'build']);
    const MAX_DEPTH = 3;
    const MAX_FILES = 100;
    const walk = async (dir, prefix, depth) => {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES)
            return;
        let entries = [];
        try {
            const target = await fs.resolve(dir);
            entries = await fs.listDir(target);
        }
        catch {
            return; // unreadable subtree — skip
        }
        for (const entry of entries) {
            if (out.length >= MAX_FILES)
                return;
            if (SKIP.has(entry.name))
                continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.type === 'directory') {
                out.push(`${rel}/`);
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: symlink targets optional
                await walk(entry.target?.displayPath ?? join(dir, entry.name), rel, depth + 1);
            }
            else if (entry.type === 'file') {
                out.push(rel);
            }
        }
    };
    await walk(root, '', 1);
    return out;
}
/** One attached file's contribution is capped so an absent-minded `@` of a
 *  huge file cannot blow the context window (CC caps @-attachments too). */
const MENTION_MAX_FILE_CHARS = 50_000;
/** Total budget across all attachments in one message. */
const MENTION_MAX_TOTAL_CHARS = 200_000;
/** A directory mention contributes a shallow listing, capped at this many
 *  entries. */
const MENTION_MAX_DIR_ENTRIES = 200;
/** The leaf's fs service in the shape mention expansion needs; undefined
 *  when the plugin is not mounted (mentions then stay literal text). */
function mentionFs(ctx) {
    return ctx.get('fs');
}
/**
 * Expand a submitted text's `@` mentions (issue #15) into model-facing
 * attachment blocks: each referenced file contributes its (capped) content,
 * each directory a shallow listing. The typed text stays the first block
 * verbatim — mentions that resolve keep their `@path` spelling in it, and
 * unresolved ones stay literal everywhere. Best-effort: an unreadable or
 * binary file degrades to `missing`, never a failed send.
 */
export async function expandMentions(fs, cwd, text) {
    const blocks = [{ type: 'text', text }];
    const attached = [];
    const missing = [];
    const mentions = extractMentions(text);
    if (!fs || mentions.length === 0)
        return { blocks, attached, missing };
    let budget = MENTION_MAX_TOTAL_CHARS;
    for (const mention of mentions) {
        if (budget <= 0)
            break;
        // Mentions resolve against the session cwd, same as the model-facing fs
        // tools; absolute paths pass through untouched.
        const absolute = isAbsolute(mention.path) ? mention.path : join(cwd, mention.path);
        let target;
        let info;
        try {
            target = await fs.resolve(absolute);
            info = await fs.stat(target);
        }
        catch {
            missing.push(mention.path);
            continue;
        }
        if (info?.type === 'file') {
            try {
                const cap = Math.min(MENTION_MAX_FILE_CHARS, budget);
                let content = await fs.readText(target);
                let truncated = false;
                if (content.length > cap) {
                    content = content.slice(0, cap);
                    truncated = true;
                }
                budget -= content.length;
                blocks.push({
                    type: 'text',
                    text: `<attached-file path="${mention.path}">\n${content}${truncated ? '\n[… truncated]' : ''}\n</attached-file>`,
                });
                attached.push(mention.path);
            }
            catch {
                // Binary/undecodable or unreadable — report it like a miss.
                missing.push(mention.path);
            }
            continue;
        }
        if (info?.type === 'directory') {
            try {
                const entries = await fs.listDir(target);
                const listing = entries
                    .slice(0, MENTION_MAX_DIR_ENTRIES)
                    .map(entry => (entry.type === 'directory' ? `${entry.name}/` : entry.name));
                if (entries.length > MENTION_MAX_DIR_ENTRIES) {
                    listing.push(`… (${entries.length - MENTION_MAX_DIR_ENTRIES} more)`);
                }
                const body = listing.join('\n');
                budget -= body.length;
                blocks.push({
                    type: 'text',
                    text: `<attached-directory path="${mention.path}">\n${body}\n</attached-directory>`,
                });
                attached.push(mention.path);
            }
            catch {
                missing.push(mention.path);
            }
            continue;
        }
        // Absent (stat → undefined) or a special file.
        missing.push(mention.path);
    }
    return { blocks, attached, missing };
}
