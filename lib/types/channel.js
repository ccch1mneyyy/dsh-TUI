import { randomUUID } from 'node:crypto';
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import { LOCAL_COMMANDS } from './commands.js';
import { clearResumeTarget, readLastUsed, touchSession, writeResumeTarget } from './sessionHistory.js';
import { writeActivityFrames } from './activityPrefs.js';
import { isPresetName } from './components/activityFrames.js';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { logForDebugging } from './utils/debug.js';
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
 * Returns the number of rows restored.
 */
function foldBack(rows, events) {
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
/** @internal */
export function createChannel(ctx, initialAgent, options) {
    let agent = initialAgent;
    let currentHandle = options.handle;
    // The DSH slash-command registry (optional service): /plan, /goal and
    // friends register here; the TUI merges their descriptors into the slash
    // menu and dispatches through `execute` (which logs the paired
    // command/run + command/done records). Absent the service, only the
    // built-in local commands exist.
    const commandService = ctx.get('commands');
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
    const state = {
        version: 0,
        rows: [],
        status: 'starting',
        sessionTitle: '',
        agentId: agent.id,
        model: options.model,
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
        reasoningEffort: options.effort,
        workingActivity: undefined,
        activityFrames: options.activityFrames,
        activityEnabled: options.activity !== false,
        goal: undefined,
        todos: [],
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
            const restored = foldBack(state.rows, agent.session.events);
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
            const message = createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' } });
            agent.followup(message);
            trackPending({ id: message.id, text: trimmed }, 'followup');
        },
        /** Steer a message into the RUNNING turn (Codex/pi semantics): it is
         *  injected at the next step boundary of the current turn and the agent
         *  continues without stopping — faster than followup, never an abort. */
        steer(text) {
            const trimmed = text.trim();
            if (!trimmed)
                return;
            touchSession(state.agentId);
            const message = createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' } });
            agent.steer(message);
            trackPending({ id: message.id, text: trimmed }, 'steer');
        },
        /** Pull a pending message back out of the inbox (Alt+Up): it returns to
         *  the input for editing instead of being delivered. */
        removePending(id) {
            const index = state.pending.findIndex(item => item.id === id);
            if (index === -1)
                return false;
            // The Agent interface carries `inbox` on the dev trunk; the released
            // dsh-agent may lack it. Without the inbox API a pull-back cannot
            // actually withdraw the message — refuse instead of pretending, or
            // the message would still be delivered (ghost send).
            const inbox = agent.inbox;
            if (!inbox)
                return false;
            inbox.remove(MessageId(id));
            state.pending = state.pending.filter(item => item.id !== id);
            state.emit();
            return true;
        },
        cancel() {
            // Keep the staged queue: an interrupt aborts the running turn but the
            // queued/steered messages are delivered as the next turn (web parity).
            agent.cancel({ kind: 'user' }, { keepInbox: true });
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
            try {
                handle = await agents.create({
                    sessionId: childId,
                    seed,
                    meta: {
                        cwd: options.cwd,
                        parentSession: agent.session.id,
                        seedLength: seed.length,
                    },
                    agentOptions: { provider: options.provider, model: options.model },
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
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
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
            try {
                handle = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    agentOptions: { provider: options.provider, model: options.model },
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
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
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
            try {
                handle = await agents.create({
                    sessionId,
                    meta: { cwd: options.cwd },
                    agentOptions: { provider: options.provider, model: options.model },
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
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
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
            clearResumeTarget();
            // The brand-new session becomes the most recently used.
            touchSession(handle.agent.id);
            state.emit();
            void oldHandle?.dispose().catch(() => { });
            return true;
        },
        async switchModel(model) {
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
            try {
                handle = await agents.create({
                    sessionId: childId,
                    seed,
                    meta: {
                        cwd: options.cwd,
                        parentSession: agent.session.id,
                        seedLength: seed.length,
                    },
                    agentOptions: { provider: options.provider, model },
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
            state.tokens = { input: 0, output: 0 };
            state.responseChars = 0;
            state.activeToolCount = 0;
            state.lastUserText = '';
            state.working = false;
            state.spinnerMode = 'requesting';
            state.status = handle.agent.status;
            state.agentId = handle.agent.id;
            state.model = model;
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
            // The model-switched fork becomes the most recently used.
            touchSession(childId);
            state.emit();
            void oldHandle?.dispose().catch(() => { });
            return true;
        },
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
                state.notify(`未知预设「${name}」· /activity frames 查看全部`, { color: 'error' });
                return false;
            }
            if (name === state.activityFrames) {
                state.notify(`指示器已是：${name}`, { color: 'success' });
                return true;
            }
            // Persist first (pi behavior: a failed write refuses the switch) so a
            // preference that cannot be saved never silently disappears.
            if (!writeActivityFrames(name)) {
                state.notify('无法写入 ~/.dsh-cc/working-activity.json，切换未保存', { color: 'error' });
                return false;
            }
            state.activityFrames = name;
            state.emit();
            state.notify(`指示器已切换：${name}（已保存）`);
            return true;
        },
        listModels() {
            const llm = ctx.get('llm');
            if (!llm)
                return Promise.resolve([]);
            return llm.listModels(options.provider).catch(() => []);
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
                // MRU ordering: DSH headers carry only createdAt, so cc-tui keeps its
                // own last-used timestamps (touchSession on resume/submit/new) and
                // falls back to createdAt for sessions never touched in this install.
                const lastUsed = readLastUsed();
                const records = headers
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
                // Title = the session's FIRST user message — the picker's most
                // useful label. persistence.load reads the whole log (zstd), so
                // only the newest sessions pay for it; older rows keep the
                // basename fallback. A load failure degrades silently.
                await Promise.all(records.slice(0, SESSION_TITLE_DEPTH).map(async (record) => {
                    try {
                        const { events } = await persistence.load(SessionId(record.id));
                        const first = events.find(event => event.type === 'user/message');
                        if (first === undefined)
                            return;
                        const data = first.data;
                        const text = textOf(data.content);
                        if (text.length > 0)
                            record.title = shortenTitle(text);
                    }
                    catch {
                        // Keep the basename fallback.
                    }
                }));
                return records;
            }
            catch {
                return [];
            }
        },
        setResumeTarget(sessionId) {
            writeResumeTarget(sessionId);
        },
        compact() {
            const compactService = ctx.get('compact');
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
        async runExternalCommand(name, rawInput) {
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
        exportSession() {
            // Export from the session log — the authoritative, complete record —
            // not the bounded transcript window (folded rows keep only previews).
            const parts = [
                '# dsh-cc 会话导出',
                '',
                `- 导出时间: ${new Date().toLocaleString()}`,
                `- 模型: ${state.model}`,
                `- 会话: ${state.agentId}`,
                `- 目录: ${state.cwd}`,
                '',
            ];
            for (const event of agent.session.events) {
                switch (event.type) {
                    case 'user/message': {
                        if (event.data.source.kind !== 'user')
                            break;
                        const text = textOf(event.data.content);
                        if (text)
                            parts.push(`## 用户\n\n${text}\n`);
                        break;
                    }
                    case 'assistant/message': {
                        const blocks = event.data.message.content;
                        for (const block of blocks) {
                            if (block.type === 'reasoning' && block.text) {
                                parts.push(`## 思考\n\n${block.text}\n`);
                            }
                            else if (block.type === 'text' && block.text) {
                                parts.push(`## 助手\n\n${block.text}\n`);
                            }
                        }
                        break;
                    }
                    case 'tool/call': {
                        parts.push(`## 工具 · ${event.data.name}\n\n\`\`\`json\n${event.data.arguments}\n\`\`\`\n`);
                        break;
                    }
                    case 'tool/result': {
                        const block = event.data.message.content[0];
                        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
                        if (block.type === 'tool-result') {
                            const text = textOf(block.content);
                            if (text)
                                parts.push(`### 结果\n\n\`\`\`\n${text}\n\`\`\`\n`);
                        }
                        break;
                    }
                    default:
                        break;
                }
            }
            const fileName = `dsh-cc-export-${Date.now()}.md`;
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
                '## 项目',
                '',
                '（在此描述项目的目标、结构与约定——这份文件会注入给每个 agent 作为工作区上下文。）',
                '',
                '## 约定',
                '',
                '- 改动前先阅读相关模块',
                '- 保持与现有代码风格一致',
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
            lines.push(`API key: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置（DEEPSEEK_API_KEY）'}`);
            lines.push(`模型: ${state.model} · 提供方: ${options.provider}`);
            lines.push(`工作目录: ${state.cwd}`);
            lines.push(`上下文窗口: ${state.contextWindow ?? '未知'} tokens`);
            lines.push(`会话: ${state.agentId}${state.sessionTitle ? ' · ' + state.sessionTitle : ''}`);
            const userHome = process.env.USERPROFILE ?? homedir();
            const configCandidates = [
                join(userHome, '.dsh-cc/cordis.yml'),
                join(state.cwd, 'examples/cc-tui-agent/cordis.yml'),
            ];
            for (const candidate of configCandidates) {
                lines.push(`配置: ${candidate} ${existsSync(candidate) ? '✓' : '（不存在）'}`);
            }
            const sessionsDir = join(userHome, '.dsh-cc/sessions');
            lines.push(`会话存储: ${sessionsDir} ${existsSync(sessionsDir) ? '✓' : '（未初始化）'}`);
            return lines;
        },
        async listSubagents() {
            const subagents = ctx.get('subagents');
            if (!subagents)
                return ['子代理服务未挂载（leaf 未启用 subagent）'];
            try {
                const children = await subagents.listChildren(agent.session.id);
                if (children.length === 0)
                    return ['当前会话暂无子代理'];
                return children.map((child) => {
                    const id = typeof child.id === 'string' ? child.id : (child.id.value ?? '');
                    const label = child.label ? `「${child.label}」` : '';
                    const mode = child.mode === 'continuable' ? '可续' : '一次性';
                    return `${mode} ${label}${child.activity === 'running' ? ' 运行中' : ' 已归档'} · ${id.slice(0, 8)}`;
                });
            }
            catch (error) {
                return [`查询失败 · ${error instanceof Error ? error.message : String(error)}`];
            }
        },
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
    let nextRowId = 0;
    /** The leaf's bash executor (dsh-bash-local in the example leaf) — the DSH
   *  execution seam for local `!` commands and the git status breadcrumb. */
    const bash = ctx.get('bash');
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
    /** First-output wall-clock + estimated output tokens of the current turn
     *  (live tps readout; refined by exact usage at assistant/message). */
    let turnOutputStart = 0;
    let turnOutputTokens = 0;
    /** Tool cards by callId, so tool/result can settle the running card. */
    const toolCards = new Map();
    // ContentBlockMap is merge-extensible: plugin-added block types are
    // silently skipped (v1 renders text blocks only) — never crashes.
    const textOf = (content) => (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim();
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
                // dim block instead of skipping it like other injected context.
                if (event.data.source.kind === 'plugin' &&
                    event.data.source.plugin === 'compact') {
                    const summary = textOf(event.data.content);
                    state.rows.push({ id: nextRowId, kind: 'notice', text: 'Conversation compacted' });
                    nextRowId += 1;
                    if (summary) {
                        state.rows.push({ id: nextRowId, kind: 'local-output', text: summary });
                        nextRowId += 1;
                    }
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
                const text = textOf(event.data.content);
                if (text) {
                    state.rows.push({ id: nextRowId, kind: 'user', text, seq: event.seq });
                    state.lastUserText = text;
                    state.contextSegments.prompt += estimateTokens(text);
                    nextRowId += 1;
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = event.data.chunk;
                if (chunk.type === 'text-delta') {
                    if (chunk.text) {
                        ensureStreaming(event.seq).text += chunk.text;
                        state.responseChars += chunk.text.length;
                        // Live output-speed estimate (chars/4 ≈ tokens) from the first
                        // output token of the turn.
                        if (turnOutputStart === 0)
                            turnOutputStart = Date.now();
                        turnOutputTokens += chunk.text.length / 4;
                        const elapsedSec = (Date.now() - turnOutputStart) / 1000;
                        if (elapsedSec > 0.5)
                            state.tps = turnOutputTokens / elapsedSec;
                    }
                }
                else if (chunk.type === 'reasoning-delta') {
                    if (chunk.text)
                        ensureReasoning(event.seq).text += chunk.text;
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
                    // Refine the live estimate with the exact output total, and record
                    // the message-level sample for the sparkline / μ / p95 readout.
                    if (turnOutputStart !== 0) {
                        const elapsedSec = (Date.now() - turnOutputStart) / 1000;
                        if (elapsedSec > 0.5) {
                            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
                            const exactTps = (usage.outputTokens ?? 0) / elapsedSec;
                            state.tps = exactTps;
                            state.tpsSamples.push({ tps: exactTps, at: Date.now() });
                            if (state.tpsSamples.length > 500)
                                state.tpsSamples.shift();
                        }
                    }
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
            case 'turn/start': {
                state.working = true;
                state.turnStart = Date.now();
                state.responseChars = 0;
                state.spinnerMode = 'requesting';
                // New turn: fresh output-speed window; the previous turn's tps stays
                // visible until this turn produces output (it describes the last
                // completed response).
                turnOutputStart = 0;
                turnOutputTokens = 0;
                break;
            }
            case 'turn/end': {
                settleStreaming();
                state.working = false;
                state.activeToolCount = 0;
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
        agentSubscriptions = [
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
            // a discarded one was dropped by a cancel. Retire from the preview.
            // The dev-trunk dsh-agent emits `inserted/claimed/discarded`; the
            // released package uses `enqueue/dequeue` — listen to both so the
            // preview stays correct on either dependency (the unknown-event
            // registrations are inert on the other side).
            (() => {
                const retirePending = ({ agent: subject, message }) => {
                    if (subject !== agent)
                        return;
                    state.pending = state.pending.filter(item => item.id !== message.id);
                    state.emit();
                };
                const disposers = [];
                const onAgentEvent = (event) => {
                    disposers.push(ctx.on(event, retirePending));
                };
                onAgentEvent('agent/inbox/claimed');
                onAgentEvent('agent/inbox/discarded');
                onAgentEvent('agent/inbox/dequeue');
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
    if (bash) {
        void bash
            .run(bash.resolve({
            command: 'git branch --show-current',
            workdir: options.cwd,
            timeoutMs: 3000,
        }))
            .then((result) => {
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
    }
    return state;
}
/** Path basename for the resume-list title (`C:/a/b` → `b`). */
function basename(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? path;
}
/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
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
//# sourceMappingURL=channel.js.map