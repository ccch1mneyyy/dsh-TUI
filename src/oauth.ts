/**
 * Public entry for the built-in OAuth Cordis module. The bundle patch keeps
 * mounting this subpath so existing profile overrides and loader ordering
 * remain compatible after the former dsh-auth package was folded into the
 * TUI's adapter tree.
 *
 * @module @deepseek-harness-tui/dsh-tui/oauth
 */
export * from './dsh-adapter/oauth/index.js'
