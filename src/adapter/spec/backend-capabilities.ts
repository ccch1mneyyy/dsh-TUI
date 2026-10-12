/**
 * The backend capability vocabulary, authored once at the spec boundary.
 *
 * A backend contribution declares `capabilities` — the session capabilities its
 * handler will actually serve — and the host must decide, before anything runs,
 * whether it recognizes each name. The truth for "which names exist" is
 * `SessionCapabilities` in `src/agent/capabilities.ts`, which cannot be imported
 * here: the layering is one-way (`src/adapter/**` imports nothing from
 * `src/agent/**` today), so the list is written here and
 * `scripts/verify-backend-contribution.ts` compares it **bidirectionally** with
 * the interface's member names, extracted with the TypeScript AST — the same
 * technique `verify-protocol-single-source.ts` uses for the decision-event
 * vocabulary. Adding a member to `SessionCapabilities` therefore turns a silent
 * drift into a red gate, which is the whole point (roadmap §5, B-2 risk 4).
 *
 * An unknown name is **not** a failure: a contribution may declare a capability
 * this host's session model does not know, and the admission records it as a
 * pending item instead of refusing the backend (D-3, "unknown names degrade, they
 * do not reject").
 */
export const BACKEND_CAPABILITY_NAMES: readonly string[] = Object.freeze([
  'pendingRetraction',
  'permissions',
  'questions',
  'models',
  'effort',
  'modes',
  'channels',
  'compact',
  'init',
  'rewind',
  'fork',
  'subagents',
  'tasks',
  'transcript',
  'mcp',
  'sideQuery',
  'rename',
  'color',
  'images',
  'commands',
  'context',
  'account',
  'auth',
  'workingActivity',
  'diagnostics',
  'goals',
  'native',
])
