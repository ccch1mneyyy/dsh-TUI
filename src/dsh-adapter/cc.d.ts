/**
 * Type augmentation for the optional dsh-session title plugin.
 */
export {}

// `session/title` records are appended by the optional dsh-session-title
// plugin; declare the record here so the channel can render it without that
// dependency (mirrors the plugin's own merge-extensible augmentation).
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'session/title': { title: string }
  }
}
