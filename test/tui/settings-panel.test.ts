import './redirect-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SettingsPanel } from '../../src/tui/components/settings-panel.js';
import {
  formatSettingValue,
  parseSettingText,
  writeSettingOps,
  type SettingsHost,
  type SettingsNamespaceView,
  type SettingsPathOp,
} from '../../src/dsh-adapter/settingsEditor.js';
import type { TuiSettingsSection, TuiSettingsField } from '../../src/dsh-adapter/settings-sections.js';
import type { TuiCommands } from '../../src/tui/commands.js';
import { t } from '../../src/i18n.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';

const SECTION: TuiSettingsSection = {
  ns: 'dsh-tui',
  title: 'dsh-tui',
  groups: [{ id: 'status-bar', title: 'Status bar' }],
  fields: [
    {
      path: ['lang'],
      label: 'Language',
      kind: 'select',
      options: [
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
      ],
    },
    {
      path: ['diffLayout'],
      label: 'Diff layout',
      kind: 'select',
      options: [
        { value: 'auto', label: 'Auto (by width)' },
        { value: 'split', label: 'Side-by-side' },
        { value: 'unified', label: 'Unified' },
      ],
    },
    { path: ['whale'], label: 'Whale art', kind: 'boolean' },
    { path: ['tokenLimit'], label: 'Token limit', kind: 'number' },
    { path: ['apiKey'], label: 'API key', kind: 'text', secret: { ref: 'TEST_API_KEY' } },
    { path: ['statusBar', 'compact'], label: 'Compact status bar', kind: 'boolean', group: 'status-bar' },
    { path: ['statusBar', 'model'], label: 'Show model', kind: 'boolean', group: 'status-bar' },
  ],
};

function makeNamespace(overrides: Partial<SettingsNamespaceView> = {}): SettingsNamespaceView {
  return {
    ns: 'dsh-tui',
    revision: 7,
    applies: 'live',
    value: {
      lang: 'zh',
      diffLayout: 'auto',
      whale: true,
      tokenLimit: 4096,
      statusBar: { compact: false, model: true },
    },
    user: {},
    ...overrides,
  };
}

const READONLY_NAMESPACE: SettingsNamespaceView = {
  ns: 'llm-deepseek',
  revision: 3,
  applies: 'restart',
  value: { baseUrl: 'https://api.example.test' },
  user: {},
};

interface WriteCall {
  ns: string;
  ops: readonly SettingsPathOp[];
  revision: number | undefined;
}

function makePanel(options: {
  sections?: TuiSettingsSection[];
  namespaces?: SettingsNamespaceView[];
  failWrites?: boolean;
  secrets?: Record<string, boolean>;
  /** Simulate a composition without the settings/credentials services. */
  noHost?: boolean;
} = {}) {
  const writes: WriteCall[] = [];
  const credentials: Array<{ ref: string; value: string }> = [];
  const notices: Array<{ text: string; color?: string }> = [];
  let closed = 0;
  const host: SettingsHost = {
    listNamespaces: () => options.namespaces ?? [],
    write: async (ns, ops, revision) => {
      writes.push({ ns, ops, revision });
      if (options.failWrites === true) throw new Error('write failed');
    },
    credentialConfigured: async (ref) => options.secrets?.[ref] ?? false,
    writeCredential: async (ref, value) => {
      credentials.push({ ref, value });
    },
  };
  const commands = {
    settings: {
      settingsHost: () => (options.noHost === true ? undefined : host),
      settingsSections: () => options.sections ?? [],
      subscribeSettingsSections: () => () => {},
    },
    info: {
      notify: (text: string, notifyOptions?: { color?: string }) => {
        notices.push({ text, color: notifyOptions?.color });
        return () => {};
      },
    },
  } as unknown as TuiCommands;
  const panel = new SettingsPanel({ commands, onClose: () => { closed += 1; } });
  return {
    panel,
    writes,
    credentials,
    notices,
    closed: () => closed,
    rendered: () => panel.render(80).join('\n'),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Item order for SECTION: ungrouped fields in declaration order, then groups.
// 0 Language (select) · 1 Diff layout (select) · 2 Whale art (boolean)
// 3 Token limit (number) · 4 API key (secret) · 5 Status bar (group)

// ---------------------------------------------------------------------------
// settingsEditor helpers (extracted from the old staged form)
// ---------------------------------------------------------------------------

test('settings helpers: format/parse round-trip the field kinds', () => {
  const booleanField: TuiSettingsField = { path: ['b'], label: 'b', kind: 'boolean' };
  assert.equal(formatSettingValue(booleanField, true), 'true');
  assert.deepEqual(parseSettingText(booleanField, 'false'), { kind: 'set', value: false });

  const numberField: TuiSettingsField = { path: ['n'], label: 'n', kind: 'number' };
  assert.equal(formatSettingValue(numberField, 42), '42');
  assert.deepEqual(parseSettingText(numberField, '42'), { kind: 'set', value: 42 });
  assert.deepEqual(parseSettingText(numberField, ''), { kind: 'clear' });
  assert.equal(parseSettingText(numberField, 'abc'), undefined);

  const selectField: TuiSettingsField = {
    path: ['s'],
    label: 's',
    kind: 'select',
    options: [{ value: 'a', label: 'A' }],
  };
  assert.deepEqual(parseSettingText(selectField, 'a'), { kind: 'set', value: 'a' });
  assert.equal(parseSettingText(selectField, 'b'), undefined);

  const textField: TuiSettingsField = { path: ['t'], label: 't', kind: 'text' };
  assert.deepEqual(parseSettingText(textField, ' hello '), { kind: 'set', value: ' hello ' });
  assert.deepEqual(parseSettingText(textField, ''), { kind: 'clear' });
});

test('settings helpers: writeSettingOps retries once on SETTINGS_CONFLICT', async () => {
  const revisions: Array<number | undefined> = [];
  let failFirst = true;
  const host: SettingsHost = {
    listNamespaces: () => [{ ns: 'dsh-tui', revision: 99, applies: 'live', value: {}, user: {} }],
    write: async (_ns, _ops, revision) => {
      revisions.push(revision);
      if (failFirst) {
        failFirst = false;
        const error = new Error('conflict') as Error & { code: string };
        error.code = 'SETTINGS_CONFLICT';
        throw error;
      }
    },
    credentialConfigured: async () => false,
    writeCredential: async () => {},
  };
  await writeSettingOps(host, 'dsh-tui', [{ op: 'set', path: ['whale'], value: false }], 7);
  assert.deepEqual(revisions, [7, 99]);

  const other: SettingsHost = {
    ...host,
    write: async () => {
      throw new Error('boom');
    },
  };
  await assert.rejects(writeSettingOps(other, 'dsh-tui', [], 1), /boom/);
});

// ---------------------------------------------------------------------------
// Panel mapping + immediate writes
// ---------------------------------------------------------------------------

test('settings panel: maps sections/groups onto list rows with localized values', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  await flush(); // let the secret probe settle
  const out = harness.rendered();
  assert.ok(out.includes(t('settings-title')));
  assert.ok(out.includes('Language'));
  assert.ok(out.includes('中文')); // select shows the option label, not the raw value
  assert.ok(out.includes('Diff layout'));
  assert.ok(out.includes('Whale art'));
  assert.ok(out.includes(t('settings-value-on'))); // boolean on/off labels
  assert.ok(out.includes('Status bar'));
  assert.ok(out.includes(t('settings-secret-unset'))); // unprobed secret
  assert.ok(!out.includes('Compact status bar')); // group fields stay inside the submenu
  harness.panel.dispose();
});

test('settings panel: Enter on a boolean writes the toggled value immediately', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  harness.panel.handleInput(DOWN);
  harness.panel.handleInput(DOWN);
  harness.panel.handleInput(ENTER);
  await flush();
  assert.deepEqual(harness.writes, [
    { ns: 'dsh-tui', ops: [{ op: 'set', path: ['whale'], value: false }], revision: 7 },
  ]);
  assert.ok(harness.rendered().includes(t('settings-value-off')));
  harness.panel.dispose();
});

test('settings panel: Enter on a select cycles to the next option value', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  harness.panel.handleInput(DOWN); // Diff layout (auto)
  harness.panel.handleInput(ENTER);
  await flush();
  assert.deepEqual(harness.writes, [
    { ns: 'dsh-tui', ops: [{ op: 'set', path: ['diffLayout'], value: 'split' }], revision: 7 },
  ]);
  harness.panel.dispose();
});

test('settings panel: a failed write notifies and rolls the displayed value back', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()], failWrites: true });
  harness.panel.handleInput(DOWN);
  harness.panel.handleInput(DOWN);
  harness.panel.handleInput(ENTER);
  // The cycle flips the display optimistically before the write settles.
  assert.ok(harness.rendered().includes(t('settings-value-off')));
  await flush();
  assert.equal(harness.writes.length, 1);
  assert.ok(harness.notices.some(entry => entry.color === 'error' && entry.text.includes('dsh-tui')));
  // Rolled back to the stored value (whale: true).
  assert.ok(harness.rendered().includes(t('settings-value-on')));
  harness.panel.dispose();
});

test('settings panel: typing filters the list through the search input', () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  for (const character of 'whale') harness.panel.handleInput(character);
  const out = harness.rendered();
  assert.ok(out.includes('Whale art'));
  assert.ok(!out.includes('Diff layout'));
  harness.panel.dispose();
});

test('settings panel: a group opens a nested list, writes inside it, Esc returns', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  for (let index = 0; index < 5; index += 1) harness.panel.handleInput(DOWN);
  harness.panel.handleInput(ENTER); // open the Status bar group
  const submenu = harness.rendered();
  assert.ok(submenu.includes('Compact status bar'));
  assert.ok(submenu.includes('Show model'));
  assert.ok(!submenu.includes('Diff layout')); // the top list is replaced by the submenu

  harness.panel.handleInput(ENTER); // toggle Compact status bar: false → true
  await flush();
  assert.deepEqual(harness.writes, [
    { ns: 'dsh-tui', ops: [{ op: 'set', path: ['statusBar', 'compact'], value: true }], revision: 7 },
  ]);

  harness.panel.handleInput(ESC); // back to the top list, panel still open
  assert.equal(harness.closed(), 0);
  assert.ok(harness.rendered().includes('Diff layout'));
  harness.panel.handleInput(ESC); // now the panel itself closes
  assert.equal(harness.closed(), 1);
  harness.panel.dispose();
});

test('settings panel: Esc on the top list closes the panel', () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  harness.panel.handleInput(ESC);
  assert.equal(harness.closed(), 1);
  harness.panel.dispose();
});

test('settings panel: number fields edit through an input submenu', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  for (let index = 0; index < 3; index += 1) harness.panel.handleInput(DOWN);
  harness.panel.handleInput(ENTER); // open Token limit, seeded with 4096
  assert.ok(harness.rendered().includes('4096'));
  harness.panel.handleInput('0'); // cursor parks at the draft end: 4096 → 40960
  harness.panel.handleInput(ENTER);
  await flush();
  assert.deepEqual(harness.writes, [
    { ns: 'dsh-tui', ops: [{ op: 'set', path: ['tokenLimit'], value: 40960 }], revision: 7 },
  ]);
  assert.ok(harness.rendered().includes('40960'));
  harness.panel.dispose();
});

test('settings panel: an invalid number stays open with an error and writes nothing', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace()] });
  for (let index = 0; index < 3; index += 1) harness.panel.handleInput(DOWN);
  harness.panel.handleInput(ENTER);
  harness.panel.handleInput('x'); // 4096x is not a number
  harness.panel.handleInput(ENTER);
  await flush();
  assert.equal(harness.writes.length, 0);
  assert.ok(harness.rendered().includes(t('settings-field-invalid')));
  harness.panel.dispose();
});

test('settings panel: secret fields mask the draft and write through the credentials seam', async () => {
  const harness = makePanel({
    sections: [SECTION],
    namespaces: [makeNamespace()],
    secrets: { TEST_API_KEY: true },
  });
  await flush(); // probe marks the row configured
  assert.ok(harness.rendered().includes(t('settings-secret-set')));

  for (let index = 0; index < 4; index += 1) harness.panel.handleInput(DOWN);
  harness.panel.handleInput(ENTER); // open the API key editor (blank draft)
  harness.panel.handleInput(ENTER); // a blank draft writes nothing
  await flush();
  assert.equal(harness.credentials.length, 0);

  harness.panel.handleInput(ENTER); // reopen
  for (const character of 'sk-x') harness.panel.handleInput(character);
  const masked = harness.rendered();
  assert.ok(masked.includes('••••'));
  assert.ok(!masked.includes('sk-x'));
  harness.panel.handleInput(ENTER);
  await flush();
  assert.deepEqual(harness.credentials, [{ ref: 'TEST_API_KEY', value: 'sk-x' }]);
  assert.ok(harness.rendered().includes(t('settings-secret-set')));
  harness.panel.dispose();
});

test('settings panel: undeclared namespaces are not listed', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [makeNamespace(), READONLY_NAMESPACE] });
  const out = harness.rendered();
  assert.ok(!out.includes('llm-deepseek'));
  // Every listed row stays editable (writes land through the same panel).
  assert.equal(harness.writes.length, 0);
  harness.panel.dispose();
});

test('settings panel: sections whose namespace is not served are hidden', async () => {
  const harness = makePanel({ sections: [SECTION], namespaces: [] });
  const out = harness.rendered();
  assert.ok(!out.includes('Language'));
  assert.ok(out.includes(t('settings-empty')));
  harness.panel.dispose();
});

test('settings panel: empty composition renders the empty state and unavailable badge', () => {
  const empty = makePanel({ noHost: true });
  const out = empty.rendered();
  assert.ok(out.includes(t('settings-title')));
  assert.ok(out.includes(t('settings-unavailable')));
  assert.ok(out.includes(t('settings-empty')));
  empty.panel.dispose();
});

test('settings panel: the fullscreen boolean field lists and shows the effective value when unset', async () => {
  const section: TuiSettingsSection = {
    ns: 'dsh-tui',
    title: 'dsh-tui',
    fields: [
      {
        path: ['fullscreen'],
        label: 'Fullscreen mode',
        kind: 'boolean',
        // Same pattern as the plugin's field: unset shows the boot value.
        format: (value: unknown) => (value === undefined || value === null ? 'false' : String(value)),
      },
    ],
  };
  // The namespace carries no `fullscreen` key: the row must show the
  // effective (cordis) value's off label rather than a blank "unset".
  const harness = makePanel({ sections: [section], namespaces: [makeNamespace()] });
  await flush();
  const out = harness.rendered();
  assert.ok(out.includes('Fullscreen mode'));
  assert.ok(out.includes(t('settings-value-off')));
  // Cycling the row writes the toggled boolean immediately.
  harness.panel.handleInput(ENTER);
  await flush();
  assert.deepEqual(harness.writes, [
    { ns: 'dsh-tui', ops: [{ op: 'set', path: ['fullscreen'], value: true }], revision: 7 },
  ]);
  harness.panel.dispose();
});
