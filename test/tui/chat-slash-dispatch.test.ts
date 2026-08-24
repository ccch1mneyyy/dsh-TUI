import './redirect-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatScreen } from '../../src/tui/screens/chat-screen.js';
import type { TuiCommands } from '../../src/tui/commands.js';
import type { TuiController } from '../../src/tui/controller.js';
import type { ChatViewModel } from '../../src/tui/view-model.js';
import type { Component, TUI } from '../../src/tui/public.js';
import { LOCAL_COMMANDS, HIDDEN_COMMANDS } from '../../src/commands.js';
import { t } from '../../src/i18n.js';

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const;
const mode = { id: 'default', plan: false } as never;

function makeViewModel(overrides: Partial<ChatViewModel> = {}): ChatViewModel {
  return {
    meta,
    transcript: { meta, rows: [] },
    statusLine: {
      meta,
      minimal: false,
      statusBar: {} as never,
      lastUsage: undefined,
      reasoningEffort: undefined,
      mode,
      modeIndex: 0,
      contextWindow: undefined,
      tps: undefined,
      tpsSamples: [],
      model: 'test-model',
      tokens: { input: 0, output: 0 },
      gitBranch: 'main',
      displayCwd: '/repo',
      sessionTitle: '',
      agentId: 'test-agent-id',
      working: false,
      workingActivity: undefined,
      activityFrames: undefined,
      contextBarEnabled: false,
      contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    },
    spinner: {
      meta,
      working: false,
      spinnerMode: 'requesting',
      responseChars: 0,
      turnStart: 0,
      activeToolCount: 0,
      workingActivity: undefined,
      activityFrames: undefined,
      activityEnabled: false,
      minimal: false,
      lastUsage: undefined,
    },
    header: {
      meta,
      whale: false,
      model: 'test-model',
      reasoningEffort: undefined,
      displayCwd: '/repo',
      loadedContext: undefined,
    },
    prompt: {
      meta,
      pending: [],
      notifications: [],
      commandList: [],
      reasoningEffort: undefined,
      effortLevels: undefined,
      working: false,
      mode,
    },
    overlays: {
      meta,
      question: null,
      approval: null,
      dialog: null,
      statusEntries: [],
    },
    pluginScene: {
      meta,
      active: undefined,
    },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test-provider',
    scrollGutter: 'timeline',
    ...overrides,
  } as ChatViewModel;
}

class FakeController {
  private listener: (() => void) | undefined;
  constructor(private readonly vm: ChatViewModel) {}

  subscribe(_slice: 'chat', listener: () => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  getChat(): ChatViewModel {
    return this.vm;
  }

  getSubagents(): never {
    return { meta, items: [] } as never;
  }

  getSessions(): never {
    return {
      meta,
      sessions: [
        {
          agentId: 'agent-1',
          cwd: '/repo',
          gitBranch: 'main',
          id: 'session-1',
          mtime: 0,
          title: 'Session 1',
        },
      ],
      cwd: '/repo',
      gitBranch: 'main',
      currentAgentId: 'agent-1',
    } as never;
  }

  getTrajectory(): never {
    return { meta, events: [] } as never;
  }
}

interface CallLog {
  askQuestion: number;
  clear: number;
  compact: number;
  cycleMode: number;
  describeCredential: string[];
  doctorInfo: number;
  exit: number;
  exportSession: number;
  external: Array<{ name: string; rawInput: string }>;
  forkSession: number;
  getSessionTree: number;
  initWorkspace: number;
  listEfforts: number;
  listModels: number;
  listPresets: number;
  listSkills: number;
  listWorkspaces: number;
  mcpStatus: number;
  newSession: number;
  notify: Array<{ text: string; color?: string }>;
  pluginsInfo: string[];
  pushLocal: Array<{ title: string; lines: readonly string[] }>;
  reload: number;
  renameSession: string[];
  rewindTo: string[];
  runWorkspaceCommand: Array<{ name: string; input: string }>;
  setActivityFrames: string[];
  setEffort: string[];
  setLang: string[];
  setMode: string[];
  setTheme: string[];
  sideQuestion: string[];
  submit: string[];
  switchModel: Array<{ provider: string; model: string }>;
  switchPreset: string[];
  switchWorkspace: number;
  update: number;
}

interface HarnessOptions {
  commandList?: ChatViewModel['prompt']['commandList'];
  externalResult?: string | undefined | Error;
  listEfforts?: { efforts: Array<{ id: string; name: string; description?: string }>; defaultEffort: string | undefined } | undefined;
  listModels?: Array<{ provider: string; id: string; name?: string; description?: string }> | undefined;
  listPresets?: Array<{ id: string; name?: string; description?: string; isDefault?: boolean; broken?: string }> | undefined;
  listSkills?: Array<{ name: string; description?: string; source: string; userInvocable: boolean }> | undefined;
  listWorkspaces?: Array<{ uri: string; label: string; description?: string; badge?: string; cwd?: string }> | undefined;
  loadedContext?: unknown;
  /** The live session mode id (drives the /permission picker's active row). */
  modeId?: string;
  providerSetup?: object | undefined;
  /** false omits the onReload hook to cover the host-unavailable warning. */
  reloadHook?: boolean;
  /** Transcript rows for the immediate /rewind path (last user turn). */
  rows?: Array<Record<string, unknown>>;
  setModeResult?: boolean;
  workspaceCommands?: Array<{ name: string; aliases?: string[]; description?: string }>;
  workspaceResult?: unknown;
}

interface Harness {
  calls: CallLog;
  chat: ChatScreen;
  rendered: () => string;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: CallLog = {
    askQuestion: 0,
    clear: 0,
    compact: 0,
    cycleMode: 0,
    describeCredential: [],
    doctorInfo: 0,
    exit: 0,
    exportSession: 0,
    external: [],
    forkSession: 0,
    getSessionTree: 0,
    initWorkspace: 0,
    listEfforts: 0,
    listModels: 0,
    listPresets: 0,
    listSkills: 0,
    listWorkspaces: 0,
    mcpStatus: 0,
    newSession: 0,
    notify: [],
    pluginsInfo: [],
    pushLocal: [],
    reload: 0,
    renameSession: [],
    rewindTo: [],
    runWorkspaceCommand: [],
    setActivityFrames: [],
    setEffort: [],
    setLang: [],
    setMode: [],
    setTheme: [],
    sideQuestion: [],
    submit: [],
    switchModel: [],
    switchPreset: [],
    switchWorkspace: 0,
    update: 0,
  };
  const commands: TuiCommands = {
    input: {
      cancel: () => {},
      interruptAndDeliver: () => 0,
      removePending: () => false,
      runExternalCommand: async (name: string, rawInput: string) => {
        calls.external.push({ name, rawInput });
        if (options.externalResult instanceof Error) throw options.externalResult;
        return options.externalResult;
      },
      steer: () => {},
      submit: (text: string) => {
        calls.submit.push(text);
      },
    },
    session: {
      clear: () => {
        calls.clear += 1;
      },
      compact: () => {
        calls.compact += 1;
      },
      cycleMode: () => {
        calls.cycleMode += 1;
      },
      deleteSession: async () => true,
      newSession: async () => {
        calls.newSession += 1;
        return true;
      },
      promptRewind: async () => 'cancel',
      renameSession: (title: string) => {
        calls.renameSession.push(title);
      },
      renameSessionTo: async () => true,
      resumeTo: async () => ({ ok: false, reason: 'cancelled' }),
      rewindTo: async (row: { text: string }) => {
        calls.rewindTo.push(row.text);
        // Mirror the channel: the dropped turn's prompt comes back.
        return row.text;
      },
      rewindToNode: async () => null,
      forkSession: async () => {
        calls.forkSession += 1;
        return true;
      },
      listModes: () => [
        { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
        { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
        { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
      ],
      setMode: async (id: string) => {
        calls.setMode.push(id);
        return options.setModeResult ?? true;
      },
    },
    model: {
      currentPreset: () => 'default',
      listEfforts: async () => {
        calls.listEfforts += 1;
        return options.listEfforts;
      },
      listModels: async () => {
        calls.listModels += 1;
        return options.listModels;
      },
      listPresets: async () => {
        calls.listPresets += 1;
        return options.listPresets;
      },
      setActivityFrames: (name: string) => {
        calls.setActivityFrames.push(name);
        return true;
      },
      setEffort: async (id: string) => {
        calls.setEffort.push(id);
        return true;
      },
      switchModel: async (provider: string, model: string) => {
        calls.switchModel.push({ provider, model });
        return true;
      },
      switchPreset: async (id: string) => {
        calls.switchPreset.push(id);
        return true;
      },
    },
    query: {
      commandCompletions: () => [],
      listFiles: async () => [],
      listFileCandidates: async () => [],
      listSessions: async () => [],
      getSessionTree: async () => {
        calls.getSessionTree += 1;
        return null;
      },
      listSkills: async () => {
        calls.listSkills += 1;
        return options.listSkills;
      },
      listSubagents: async () => [],
      previewSession: async () => [],
      stageImage: async () => undefined,
      subagentInterrupt: () => false,
    },
    settings: {
      settingsHost: () => undefined,
      settingsSections: () => [],
      subscribeSettingsSections: () => () => {},
    },
    workspace: {
      listWorkspaces: async () => {
        calls.listWorkspaces += 1;
        return options.listWorkspaces;
      },
      renameWorkspace: async () => true,
      resolveWorkspace: async () => undefined,
      runWorkspaceCommand: async (name: string, input: string) => {
        calls.runWorkspaceCommand.push({ name, input });
        return options.workspaceResult as never;
      },
      switchWorkspace: async () => {
        calls.switchWorkspace += 1;
        return true;
      },
      workspaceCommands: () => options.workspaceCommands ?? [],
    },
    info: {
      describeCredential: async (name: string) => {
        calls.describeCredential.push(name);
        return undefined;
      },
      doctorInfo: () => {
        calls.doctorInfo += 1;
        return ['doctor-line'];
      },
      exportSession: () => {
        calls.exportSession += 1;
        return '/tmp/export.md';
      },
      initWorkspace: () => {
        calls.initWorkspace += 1;
        return '/repo/AGENTS.md';
      },
      mcpStatus: () => {
        calls.mcpStatus += 1;
        return ['mcp-line'];
      },
      // Mirror the channel: the notification lands in the projected array and
      // the chat root re-renders off the updated projection.
      notify: (text: string, notifyOptions?: { color?: string; timeoutMs?: number }) => {
        calls.notify.push({ text, color: notifyOptions?.color });
        notifications.push({
          id: notifications.length,
          text,
          ...(notifyOptions?.color === undefined ? {} : { color: notifyOptions.color as never }),
          timeoutMs: notifyOptions?.timeoutMs ?? 4000,
        });
        chat.update(controller.getChat());
        return () => {};
      },
      pluginsInfo: (rawInput: string) => {
        calls.pluginsInfo.push(rawInput);
        return ['plugins-line'];
      },
      providerSetup: () => options.providerSetup as never,
      pushLocal: (title: string, lines: readonly string[]) => {
        calls.pushLocal.push({ title, lines });
      },
      sideQuestion: async (question: string) => {
        calls.sideQuestion.push(question);
        return { answer: 'answer', error: undefined };
      },
      traceEvents: () => [],
    },
    scene: {
      closePluginScene: () => {},
      openPluginScene: () => false,
    },
    overlays: {
      answerQuestion: () => {},
      askQuestion: async () => {
        calls.askQuestion += 1;
        return { answers: {} } as never;
      },
      cancelDialog: () => {},
      cancelQuestion: () => {},
      decideApproval: () => {},
      decideDialog: () => {},
    },
    display: {
      currentTheme: () => 'dark',
      listThemes: () => [
        { name: 'auto', displayName: 'auto', description: 'auto theme', colors: ['#000'] },
        { name: 'dark', displayName: 'dark', description: 'dark theme', colors: ['#111'] },
      ],
      setLang: (lang) => {
        calls.setLang.push(lang);
        return true;
      },
      setTheme: (name: string) => {
        calls.setTheme.push(name);
        return true;
      },
    },
  };
  const notifications: Array<ChatViewModel['prompt']['notifications'][number]> = [];
  const activeMode = { id: options.modeId ?? 'default', plan: false } as never;
  const vm = makeViewModel({
    transcript: { meta, rows: (options.rows ?? []) as never },
    header: { ...makeViewModel().header, loadedContext: options.loadedContext as never },
    prompt: {
      ...makeViewModel().prompt,
      commandList: options.commandList ?? [],
      mode: activeMode,
      notifications,
    },
    statusLine: { ...makeViewModel().statusLine, mode: activeMode },
  });
  const controller = new FakeController(vm);
  const ui = {
    requestRender: () => {},
    terminal: { columns: 80, rows: 24 },
  } as unknown as TUI;
  // Assigned right below; the notify fake only runs after construction.
  let chat!: ChatScreen;
  chat = new ChatScreen({
    commands,
    controller: controller as unknown as TuiController,
    onExit: () => {
      calls.exit += 1;
    },
    onUpdate: () => {
      calls.update += 1;
    },
    ...(options.reloadHook === false
      ? {}
      : {
          onReload: () => {
            calls.reload += 1;
          },
        }),
    ui,
  });
  const rendered = () => chat.render(80).join('\n');
  return { calls, chat, rendered };
}

async function dispatch(chat: ChatScreen, input: string): Promise<void> {
  chat.handleInput(input);
  chat.handleInput('\r');
  // Flush the async payloads (listModels/listSkills/… then mountPicker).
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A transient screen owns the keyboard when it swallows plain text without
 *  routing it to the prompt editor; several of them (session browser,
 *  trajectory, subagent dashboard) don't echo injected text, so the visible
 *  signal is the rendered output changing vs the plain chat root. */
function transientOwnsScreen(harness: Harness, before: string[]): boolean {
  harness.chat.handleInput('zz');
  const after = harness.chat.render(80);
  return after.join('\n') !== before.join('\n') && !after.join('\n').includes('zz');
}

// ---- A. LOCAL_COMMANDS dispatch matrix --------------------------------------

test('slash dispatch: /model mounts the model picker', async () => {
  const harness = makeHarness({ listModels: [{ provider: 'p', id: 'm', name: 'Model M' }] });
  await dispatch(harness.chat, '/model');
  assert.equal(harness.calls.listModels, 1);
  assert.ok(harness.rendered().includes(t('picker-title-model')));
  harness.chat.dispose();
});

test('slash dispatch: /model select switches the live route', async () => {
  const harness = makeHarness({ listModels: [{ provider: 'p', id: 'm', name: 'Model M' }] });
  await dispatch(harness.chat, '/model');
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.switchModel, [{ provider: 'p', model: 'm' }]);
  assert.ok(harness.calls.notify.some(entry => entry.text.includes('Model M')));
  harness.chat.dispose();
});

test('slash dispatch: /model renders provider tabs and the Thinking footer', async () => {
  const harness = makeHarness({
    listEfforts: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    listModels: [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
    ],
  });
  await dispatch(harness.chat, '/model');
  const rendered = harness.rendered();
  assert.equal(harness.calls.listModels, 1);
  assert.equal(harness.calls.listEfforts, 1);
  // Tab strip (All + one tab per provider) and the Thinking segmented footer.
  assert.ok(rendered.includes(t('picker-tab-all')));
  assert.ok(rendered.includes('deepseek') && rendered.includes('openai'));
  assert.ok(rendered.includes(t('thinking-label')));
  assert.ok(rendered.includes('[ Low ]'));
  // Editor-slot mount: the status chrome stays visible alongside the picker.
  assert.ok(rendered.includes('test-model'));
  // ←/→ moves the focused model's draft segment without applying it; Enter
  // commits the model and the draft effort together.
  harness.chat.handleInput('\x1b[C');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.setEffort, []);
  assert.ok(harness.rendered().includes('[ High ]'));
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.switchModel, [{ provider: 'deepseek', model: 'deepseek-chat' }]);
  assert.deepEqual(harness.calls.setEffort, ['high']);
  harness.chat.dispose();
});

test('slash dispatch: /model without effort levels hides the Thinking footer', async () => {
  const harness = makeHarness({
    listEfforts: { defaultEffort: undefined, efforts: [{ id: 'low', name: 'Low' }] },
    listModels: [{ provider: 'p', id: 'm', name: 'Model M' }],
  });
  await dispatch(harness.chat, '/model');
  const rendered = harness.rendered();
  assert.ok(rendered.includes(t('picker-tab-all')));
  assert.ok(!rendered.includes(t('thinking-label')));
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.switchModel, [{ provider: 'p', model: 'm' }]);
  assert.deepEqual(harness.calls.setEffort, []);
  harness.chat.dispose();
});

test('slash dispatch: /model stays silent when the payload is dropped', async () => {
  const harness = makeHarness({ listModels: undefined });
  await dispatch(harness.chat, '/model');
  assert.equal(harness.calls.notify.length, 0);
  assert.equal(transientOwnsScreen(harness, harness.chat.render(80)), false);
  harness.chat.dispose();
});

test('slash dispatch: /effort mounts the segmented picker', async () => {
  const harness = makeHarness({
    listEfforts: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
  });
  await dispatch(harness.chat, '/effort');
  assert.ok(harness.rendered().includes(t('picker-title-effort')));
  // ←/→ move the focus without applying; Enter commits the focused level.
  harness.chat.handleInput('\x1b[C');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.setEffort, []);
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.setEffort, ['high']);
  harness.chat.dispose();
});

test('slash dispatch: /effort <id> sets directly, status reports', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/effort high');
  assert.deepEqual(harness.calls.setEffort, ['high']);
  harness.chat.dispose();

  const status = makeHarness();
  await dispatch(status.chat, '/effort status');
  assert.equal(status.calls.pushLocal[0]?.title, '/effort');
  status.chat.dispose();
});

test('slash dispatch: /preset mounts the picker / status / direct switch', async () => {
  const harness = makeHarness({ listPresets: [{ id: 'liangshen', name: 'Liangshen' }] });
  await dispatch(harness.chat, '/preset');
  assert.ok(harness.rendered().includes('Agent preset'));
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.switchPreset, ['liangshen']);
  harness.chat.dispose();

  const direct = makeHarness();
  await dispatch(direct.chat, '/preset liangshen');
  assert.deepEqual(direct.calls.switchPreset, ['liangshen']);
  direct.chat.dispose();

  const status = makeHarness();
  await dispatch(status.chat, '/preset status');
  assert.equal(status.calls.pushLocal[0]?.title, '/preset');
  status.chat.dispose();
});

test('slash dispatch: /theme mounts the picker / direct apply / status', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/theme');
  assert.ok(harness.rendered().includes(t('picker-title-theme')));
  // The active theme (dark) opens focused; Enter re-applies it.
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.setTheme, ['dark']);
  assert.ok(harness.calls.notify.some(entry => entry.color === 'success'));
  harness.chat.dispose();

  const moved = makeHarness();
  await dispatch(moved.chat, '/theme');
  // ↑ moves the focus off the active row (dark → auto); Enter applies that.
  moved.chat.handleInput('\x1b[A');
  moved.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(moved.calls.setTheme, ['auto']);
  moved.chat.dispose();

  const direct = makeHarness();
  await dispatch(direct.chat, '/theme dark');
  assert.deepEqual(direct.calls.setTheme, ['dark']);
  direct.chat.dispose();

  const status = makeHarness();
  await dispatch(status.chat, '/theme status');
  assert.equal(status.calls.pushLocal[0]?.title, '/theme');
  status.chat.dispose();
});

test('slash dispatch: /lang reports, switches and rejects unknown languages', async () => {
  const bare = makeHarness();
  await dispatch(bare.chat, '/lang');
  assert.equal(bare.calls.pushLocal[0]?.title, '/lang');
  bare.chat.dispose();

  const switched = makeHarness();
  await dispatch(switched.chat, '/lang zh');
  assert.deepEqual(switched.calls.setLang, ['zh']);
  assert.ok(switched.calls.notify.some(entry => entry.color === 'success'));
  switched.chat.dispose();

  const unknown = makeHarness();
  await dispatch(unknown.chat, '/lang xx');
  assert.equal(unknown.calls.setLang.length, 0);
  assert.ok(unknown.calls.notify.some(entry => entry.color === 'error'));
  unknown.chat.dispose();
});

test('slash dispatch: /activity picker, frames switch and usage', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/activity');
  assert.ok(harness.rendered().includes(t('picker-title-activity')));
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.setActivityFrames.length, 1);
  harness.chat.dispose();

  const direct = makeHarness();
  await dispatch(direct.chat, '/activity frames dots');
  assert.deepEqual(direct.calls.setActivityFrames, ['dots']);
  direct.chat.dispose();

  const list = makeHarness();
  await dispatch(list.chat, '/activity frames');
  assert.equal(list.calls.pushLocal[0]?.title, '/activity');
  list.chat.dispose();

  const bad = makeHarness();
  await dispatch(bad.chat, '/activity nope');
  assert.ok(bad.calls.notify.some(entry => entry.color === 'warning'));
  bad.chat.dispose();
});

test('slash dispatch: /thinking mounts the visibility toggle', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/thinking');
  assert.ok(harness.rendered().includes(t('thinking-title')));
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.calls.notify.some(entry => entry.text.length > 0));
  harness.chat.dispose();
});

test('slash dispatch: /skills mounts the catalog picker', async () => {
  const harness = makeHarness({
    listSkills: [{ name: 'review', description: 'review code', source: 'bundled', userInvocable: true }],
  });
  await dispatch(harness.chat, '/skills');
  assert.equal(harness.calls.listSkills, 1);
  assert.ok(harness.rendered().includes(t('picker-title-skills')));
  harness.chat.dispose();
});

test('slash dispatch: /skills failure notifies', async () => {
  const harness = makeHarness({ listSkills: undefined });
  await dispatch(harness.chat, '/skills');
  assert.ok(harness.calls.notify.some(entry => entry.color === 'error'));
  harness.chat.dispose();
});

test('slash dispatch: /resume opens the session browser', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/resume');
  assert.ok(harness.rendered().includes(t('resume-title')));
  harness.chat.dispose();
});

test('slash dispatch: /settings mounts the settings panel in the editor slot', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/settings');
  const open = harness.rendered();
  assert.ok(open.includes(t('settings-title')));
  // Pi-style editor replacement: the rest of the chat root (status chrome
  // here) stays mounted — the panel only takes the prompt editor's slot.
  assert.ok(open.includes('test-model'));
  // Esc closes the panel and the editor owns plain text again.
  harness.chat.handleInput('\x1b');
  assert.ok(!harness.rendered().includes(t('settings-title')));
  harness.chat.handleInput('zz');
  assert.ok(harness.rendered().includes('zz'));
  harness.chat.dispose();
});

test('slash dispatch: /trace and /trajectory open the trajectory view', async () => {
  for (const input of ['/trace', '/trajectory']) {
    const harness = makeHarness();
    const before = harness.chat.render(80);
    await dispatch(harness.chat, input);
    assert.ok(transientOwnsScreen(harness, before), input);
    harness.chat.dispose();
  }
});

test('slash dispatch: /agents and /subagents open the dashboard', async () => {
  for (const input of ['/agents', '/subagents']) {
    const harness = makeHarness();
    const before = harness.chat.render(80);
    await dispatch(harness.chat, input);
    assert.ok(transientOwnsScreen(harness, before), input);
    harness.chat.dispose();
  }
});

test('slash dispatch: /clear, /compact, /new hit the session sink', async () => {
  const cleared = makeHarness();
  await dispatch(cleared.chat, '/clear');
  assert.equal(cleared.calls.clear, 1);
  cleared.chat.dispose();

  const compacted = makeHarness();
  await dispatch(compacted.chat, '/compact');
  assert.equal(compacted.calls.compact, 1);
  compacted.chat.dispose();

  const fresh = makeHarness();
  await dispatch(fresh.chat, '/new');
  assert.equal(fresh.calls.newSession, 1);
  fresh.chat.dispose();
});

test('slash dispatch: /tree opens the session tree', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/tree');
  assert.equal(harness.calls.getSessionTree, 1, '/tree loads the session family tree');
  harness.chat.dispose();
});

test('slash dispatch: /rewind immediately rewinds the last user turn (kimi /undo 1)', async () => {
  const harness = makeHarness({
    rows: [
      { id: 0, kind: 'user', text: 'first prompt', seq: 1 },
      { id: 1, kind: 'assistant', text: 'first reply', seq: 2 },
      { id: 2, kind: 'user', text: 'second prompt', seq: 6 },
    ],
  });
  await dispatch(harness.chat, '/rewind');
  assert.deepEqual(harness.calls.rewindTo, ['second prompt'], 'the LAST user row with a seq is the target');
  assert.equal(harness.calls.getSessionTree, 0, '/rewind no longer opens the tree');
  // The dropped turn's prompt is refilled into the editor for re-editing.
  const editor = (harness.chat as unknown as { promptEditor: { getText(): string } }).promptEditor;
  assert.equal(editor.getText(), 'second prompt');
  assert.ok(harness.calls.notify.some(entry => entry.text === t('rewind-done')));
  harness.chat.dispose();
});

test('slash dispatch: /rewind with nothing to rewind toasts instead of calling the channel', async () => {
  const harness = makeHarness({ rows: [{ id: 0, kind: 'assistant', text: 'only a reply', seq: 2 }] });
  await dispatch(harness.chat, '/rewind');
  assert.deepEqual(harness.calls.rewindTo, []);
  assert.ok(harness.calls.notify.some(entry => entry.text === t('rewind-none')));
  harness.chat.dispose();
});

test('slash dispatch: /fork forks the current session in place (no tree, no swap)', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/fork');
  assert.equal(harness.calls.forkSession, 1);
  assert.equal(harness.calls.getSessionTree, 0, '/fork no longer opens the tree');
  harness.chat.dispose();
});

test('slash dispatch: /update invokes the host update hook', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/update');
  assert.equal(harness.calls.update, 1);
  harness.chat.dispose();
});

test('slash dispatch: /reload invokes the host reload hook', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/reload');
  assert.equal(harness.calls.reload, 1);
  harness.chat.dispose();
});

test('slash dispatch: /reload warns when the host has no reload hook', async () => {
  const harness = makeHarness({ reloadHook: false });
  await dispatch(harness.chat, '/reload');
  assert.equal(harness.calls.reload, 0);
  assert.ok(harness.calls.notify.some(entry => entry.color === 'warning' && entry.text.includes('Reload')));
  harness.chat.dispose();
});

test('slash dispatch: /exit, /quit and /q request exit', async () => {
  for (const input of ['/exit', '/quit', '/q']) {
    const harness = makeHarness();
    await dispatch(harness.chat, input);
    assert.equal(harness.calls.exit, 1, input);
    harness.chat.dispose();
  }
});

test('ctrl+c on an empty editor shows the press-again exit hint', async () => {
  const harness = makeHarness();
  // First press arms the double-press window: the hint must be VISIBLE in the
  // notification row between the editor and the status line.
  harness.chat.handleInput('\x03');
  assert.ok(harness.calls.notify.some(entry => entry.text === t('exit-press-again')));
  assert.ok(harness.rendered().includes(t('exit-press-again')));
  assert.equal(harness.calls.exit, 0);
  // The second press inside the window exits.
  harness.chat.handleInput('\x03');
  assert.equal(harness.calls.exit, 1);
  harness.chat.dispose();
});

test('slash dispatch: /tips mounts the tips panel', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/tips');
  assert.ok(harness.rendered().includes('/tips'));
  harness.chat.dispose();
});

test('slash dispatch: /help pushes the shortcut reference', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/help');
  assert.equal(harness.calls.pushLocal[0]?.title, '/help');
  assert.ok(harness.calls.pushLocal[0].lines.length > 5);
  harness.chat.dispose();
});

test('slash dispatch: /context reports the loaded context or warns', async () => {
  const empty = makeHarness();
  await dispatch(empty.chat, '/context');
  assert.ok(empty.calls.notify.some(entry => entry.color === 'warning'));
  empty.chat.dispose();

  const loaded = makeHarness({
    loadedContext: {
      agents: [],
      bootstrapWarnings: [],
      contexts: [],
      files: [],
      mcpWarnings: [],
      projectRoot: '/repo',
      sections: [{ name: 'CLAUDE.md', text: 'project notes' }],
      sessionId: 's',
      shortModel: 'm',
      skills: [],
      tools: [],
      totalTokens: 0,
    },
  });
  await dispatch(loaded.chat, '/context');
  assert.equal(loaded.calls.pushLocal[0]?.title, '/context');
  loaded.chat.dispose();
});

test('slash dispatch: /status pushes the session report', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/status');
  const report = harness.calls.pushLocal[0];
  assert.equal(report?.title, '/status');
  assert.ok(report.lines.some(line => line.includes('test-model')));
  harness.chat.dispose();
});

test('slash dispatch: /cost and /tokens report usage', async () => {
  const cost = makeHarness();
  await dispatch(cost.chat, '/cost');
  assert.equal(cost.calls.pushLocal[0]?.title, '/cost');
  assert.ok(cost.calls.pushLocal[0].lines.some(line => line.includes('Tokens')));
  cost.chat.dispose();

  const tokens = makeHarness();
  await dispatch(tokens.chat, '/tokens');
  assert.ok(tokens.calls.notify.some(entry => entry.text.length > 0));
  tokens.chat.dispose();
});

test('slash dispatch: /config and /doctor push diagnostics', async () => {
  const config = makeHarness();
  await dispatch(config.chat, '/config');
  assert.equal(config.calls.pushLocal[0]?.title, '/config');
  config.chat.dispose();

  const doctor = makeHarness();
  await dispatch(doctor.chat, '/doctor');
  assert.equal(doctor.calls.doctorInfo, 1);
  assert.equal(doctor.calls.pushLocal[0]?.title, '/doctor');
  assert.ok(doctor.calls.pushLocal[0].lines.includes('doctor-line'));
  doctor.chat.dispose();
});

test('slash dispatch: /plugins pushes plugin diagnostics', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/plugins check ./x');
  assert.deepEqual(harness.calls.pluginsInfo, ['check ./x']);
  assert.equal(harness.calls.pushLocal[0]?.title, '/plugins');
  harness.chat.dispose();
});

test('slash dispatch: /export notifies the saved path', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/export');
  assert.equal(harness.calls.exportSession, 1);
  assert.ok(harness.calls.notify.some(entry => entry.text.includes('/tmp/export.md')));
  harness.chat.dispose();
});

test('slash dispatch: /init notifies the created AGENTS.md', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/init');
  assert.equal(harness.calls.initWorkspace, 1);
  assert.ok(harness.calls.notify.some(entry => entry.text.includes('/repo/AGENTS.md')));
  harness.chat.dispose();
});

test('slash dispatch: /login pushes the credential report', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/login');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.describeCredential, ['DEEPSEEK_API_KEY']);
  assert.equal(harness.calls.pushLocal[0]?.title, '/login');
  harness.chat.dispose();
});

test('slash dispatch: /logout notifies the hint', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/logout');
  assert.equal(harness.calls.notify.length, 1);
  harness.chat.dispose();
});

test('slash dispatch: /permission mounts the mode picker and applies on Enter', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/permission');
  assert.ok(harness.rendered().includes(t('picker-title-permission')));
  // The current mode (default) opens focused; ↓ moves to plan, Enter applies.
  harness.chat.handleInput('\x1b[B');
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.setMode, ['plan']);
  harness.chat.dispose();
});

test('slash dispatch: /permission opens focused on the current mode row', async () => {
  const harness = makeHarness({ modeId: 'plan' });
  await dispatch(harness.chat, '/permission');
  const rendered = harness.rendered();
  // The active mode row opens focused (the → prefix), not the first row.
  assert.ok(rendered.includes(`→ ${t('mode-plan')}`));
  assert.ok(!rendered.includes(`→ ${t('mode-default')}`));
  // Editor-slot mount: the status chrome stays visible alongside the picker.
  assert.ok(rendered.includes('test-model'));
  // Enter applies the focused (already active) mode.
  harness.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.setMode, ['plan']);
  harness.chat.dispose();
});

test('slash dispatch: /permission <id> applies directly, unknown id warns', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/permission full');
  assert.deepEqual(harness.calls.setMode, ['full']);
  harness.chat.dispose();

  const unknown = makeHarness({ setModeResult: false });
  await dispatch(unknown.chat, '/permission nope');
  assert.deepEqual(unknown.calls.setMode, ['nope']);
  assert.ok(unknown.calls.notify.some(entry => entry.color === 'warning'));
  unknown.chat.dispose();
});

test('shift+tab cycles the session permission mode', async () => {
  const harness = makeHarness();
  // Legacy backtab; the editor may hold text — the cycle fires regardless.
  harness.chat.handleInput('\x1b[Z');
  assert.equal(harness.calls.cycleMode, 1);
  harness.chat.handleInput('\x1b[Z');
  assert.equal(harness.calls.cycleMode, 2);
  harness.chat.dispose();
});

test('shift+tab does not cycle while a transient picker is open', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/permission');
  assert.ok(harness.rendered().includes(t('picker-title-permission')));
  // The picker owns the keyboard: backtab reaches it, never the chat root.
  harness.chat.handleInput('\x1b[Z');
  assert.equal(harness.calls.cycleMode, 0);
  harness.chat.dispose();
});

test('slash dispatch: /add-dir, /hooks, /mcp push their reports', async () => {
  const addDir = makeHarness();
  await dispatch(addDir.chat, '/add-dir');
  assert.equal(addDir.calls.pushLocal[0]?.title, '/add-dir');
  addDir.chat.dispose();

  const hooks = makeHarness();
  await dispatch(hooks.chat, '/hooks');
  assert.equal(hooks.calls.pushLocal[0]?.title, '/hooks');
  hooks.chat.dispose();

  const mcp = makeHarness();
  await dispatch(mcp.chat, '/mcp');
  assert.equal(mcp.calls.mcpStatus, 1);
  assert.equal(mcp.calls.pushLocal[0]?.title, '/mcp');
  mcp.chat.dispose();
});

test('slash dispatch: /vim notifies, /terminal-setup and /connect push hints', async () => {
  const vim = makeHarness();
  await dispatch(vim.chat, '/vim');
  assert.equal(vim.calls.notify.length, 1);
  vim.chat.dispose();

  const terminal = makeHarness();
  await dispatch(terminal.chat, '/terminal-setup');
  assert.equal(terminal.calls.pushLocal[0]?.title, '/terminal-setup');
  terminal.chat.dispose();

  const connect = makeHarness();
  await dispatch(connect.chat, '/connect');
  assert.equal(connect.calls.pushLocal[0]?.title, '/connect');
  connect.chat.dispose();
});

test('slash dispatch: /rename renames or prints usage', async () => {
  const usage = makeHarness();
  await dispatch(usage.chat, '/rename');
  assert.equal(usage.calls.pushLocal[0]?.title, '/rename');
  usage.chat.dispose();

  const renamed = makeHarness();
  await dispatch(renamed.chat, '/rename My Session');
  assert.deepEqual(renamed.calls.renameSession, ['My Session']);
  assert.ok(renamed.calls.notify.some(entry => entry.text.includes('My Session')));
  renamed.chat.dispose();
});

test('slash dispatch: skill commands submit their activation prompts', async () => {
  const skills: Array<[string, string]> = [
    ['/review', 'skill-review-prompt'],
    ['/pr_comments', 'skill-pr-comments-prompt'],
    ['/audit', 'skill-audit-prompt'],
    ['/practice', 'skill-practice-prompt'],
    ['/bug', 'skill-bug-prompt'],
    ['/release-notes', 'skill-release-notes-prompt'],
    ['/vuln-check', 'skill-vuln-check-prompt'],
  ];
  for (const [command, key] of skills) {
    const harness = makeHarness();
    await dispatch(harness.chat, command);
    assert.deepEqual(harness.calls.submit, [t(key)], command);
    harness.chat.dispose();
  }
});

test('slash dispatch: /provider without a host warns, with a host asks', async () => {
  const missing = makeHarness({ providerSetup: undefined });
  await dispatch(missing.chat, '/provider');
  assert.ok(missing.calls.notify.some(entry => entry.color === 'warning'));
  missing.chat.dispose();

  const hosted = makeHarness({ providerSetup: {} });
  await dispatch(hosted.chat, '/provider');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hosted.calls.askQuestion, 1);
  hosted.chat.dispose();
});

test('slash dispatch: /btw streams a side question into its panel', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/btw hello there');
  assert.deepEqual(harness.calls.sideQuestion, ['hello there']);
  assert.ok(harness.rendered().includes('/btw'));
  await new Promise((resolve) => setImmediate(resolve));
  harness.chat.dispose();

  const bare = makeHarness();
  await dispatch(bare.chat, '/btw');
  assert.equal(bare.calls.sideQuestion.length, 0);
  assert.equal(bare.calls.notify.length, 1);
  bare.chat.dispose();
});

test('slash dispatch: /deepseek replays the logo without side effects', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/deepseek');
  assert.equal(harness.calls.submit.length, 0);
  assert.equal(harness.calls.notify.length, 0);
  assert.doesNotThrow(() => harness.rendered());
  harness.chat.dispose();
});

// ---- B. workspace command flow ----------------------------------------------

test('slash dispatch: /workspace usage, resume picker and extension flows', async () => {
  const usage = makeHarness({ workspaceCommands: [{ name: 'ssh', description: 'ssh things' }] });
  await dispatch(usage.chat, '/workspace');
  assert.equal(usage.calls.pushLocal[0]?.title, '/workspace');
  assert.ok(usage.calls.pushLocal[0].lines.some(line => line.includes('ssh')));
  usage.chat.dispose();

  const resume = makeHarness({
    listWorkspaces: [{ uri: 'dsh-ws://one', label: 'one' }],
  });
  await dispatch(resume.chat, '/workspace resume');
  assert.ok(resume.rendered().includes('one'));
  resume.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resume.calls.switchWorkspace, 1);
  resume.chat.dispose();

  const flow = makeHarness({
    workspaceCommands: [{ name: 'ssh' }],
    workspaceResult: {
      choices: [
        {
          choose: () => ({ kind: 'target', target: { uri: 'dsh-ws://host', label: 'host' } }),
          id: 'host-1',
          label: 'host-one',
        },
      ],
      kind: 'choices',
      title: 'Pick host',
    },
  });
  await dispatch(flow.chat, '/workspace ssh');
  assert.deepEqual(flow.calls.runWorkspaceCommand, [{ input: '', name: 'ssh' }]);
  assert.ok(flow.rendered().includes('Pick host'));
  flow.chat.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flow.calls.switchWorkspace, 1);
  flow.chat.dispose();

  const unknown = makeHarness();
  await dispatch(unknown.chat, '/workspace nope');
  assert.ok(unknown.calls.notify.some(entry => entry.color === 'error'));
  unknown.chat.dispose();
});

// ---- C. fallback behavior -----------------------------------------------------

test('slash dispatch: unknown commands fall back to submit verbatim', async () => {
  const harness = makeHarness();
  await dispatch(harness.chat, '/foobar some args');
  assert.deepEqual(harness.calls.submit, ['/foobar some args']);
  assert.equal(harness.calls.external.length, 0);
  harness.chat.dispose();
});

test('slash dispatch: external registry commands run and notify their text', async () => {
  const harness = makeHarness({
    commandList: [{ external: true, name: 'plan' } as never],
    externalResult: 'registry said hi',
  });
  await dispatch(harness.chat, '/plan off');
  assert.deepEqual(harness.calls.external, [{ name: 'plan', rawInput: 'off' }]);
  assert.equal(harness.calls.submit.length, 0);
  assert.deepEqual(harness.calls.notify, [{ color: undefined, text: 'registry said hi' }]);
  harness.chat.dispose();
});

test('slash dispatch: external command returning undefined falls back to submit', async () => {
  const harness = makeHarness({
    commandList: [{ external: true, name: 'plan' } as never],
    externalResult: undefined,
  });
  await dispatch(harness.chat, '/plan off');
  assert.deepEqual(harness.calls.external, [{ name: 'plan', rawInput: 'off' }]);
  assert.deepEqual(harness.calls.submit, ['/plan off']);
  harness.chat.dispose();
});

test('slash dispatch: external command failures notify the error', async () => {
  const harness = makeHarness({
    commandList: [{ external: true, name: 'plan' } as never],
    externalResult: new Error('boom'),
  });
  await dispatch(harness.chat, '/plan');
  assert.equal(harness.calls.submit.length, 0);
  assert.ok(harness.calls.notify.some(entry => entry.color === 'error' && entry.text === 'Command failed: boom'));
  harness.chat.dispose();
});

// ---- D. coverage meta-test ----------------------------------------------------

test('slash dispatch: dispatch table exactly covers LOCAL_COMMANDS + hidden entries', () => {
  // `trajectory`/`subagents` are dispatch aliases of `trace`/`agents` (not
  // catalog entries); `deepseek` lives in HIDDEN_COMMANDS. Everything else is
  // a LOCAL_COMMANDS name — the assertion is an exact set equality both ways.
  const covered = [
    'model', 'effort', 'preset', 'theme', 'lang', 'activity', 'thinking',
    'resume', 'settings', 'trace', 'trajectory', 'agents', 'subagents',
    'skills', 'workspace', 'provider', 'btw', 'tips', 'help', 'context',
    'status', 'cost', 'tokens', 'config', 'doctor', 'plugins', 'export',
    'init', 'login', 'logout', 'permission', 'add-dir', 'hooks', 'mcp',
    'vim', 'terminal-setup', 'rename', 'connect', 'clear', 'new', 'compact',
    'rewind', 'tree', 'fork', 'update', 'reload', 'exit', 'quit', 'q', 'review', 'pr_comments',
    'audit', 'practice', 'bug', 'release-notes', 'vuln-check', 'deepseek',
  ];
  const expected = [
    ...LOCAL_COMMANDS.map(command => command.name),
    ...HIDDEN_COMMANDS.map(command => command.name),
    'trajectory',
    'subagents',
  ];
  assert.deepEqual(covered.slice().sort(), expected.slice().sort());
});
