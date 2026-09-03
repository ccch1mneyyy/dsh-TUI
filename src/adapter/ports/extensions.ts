/**
 * Internal Host Ports for TUI extension seams.
 *
 * These are host-internal, non-protocol interfaces: status lines, keyboard
 * shortcuts, session-entry renderers, runtime themes, toasts, and command
 * completion trees. None of them carry apiVersion/kind, negotiation,
 * manifest, permission, or caller-supplied owner semantics.
 */

import type { HostDisposer } from './owner.js'

// ── status ────────────────────────────────────────────────────────────────

export interface HostStatusEntry {
  readonly key: string
  readonly text: string
}

export interface HostStatusPort {
  set(key: string, text: string | number | boolean | undefined): HostDisposer
  snapshot(): readonly HostStatusEntry[]
  subscribe(listener: () => void): HostDisposer
}

// ── shortcuts ─────────────────────────────────────────────────────────────

export type HostShortcutKey = {
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly name?: string
  readonly raw?: string
}

export interface HostShortcutOptions {
  readonly description: string
  readonly handler: () => void | Promise<void>
}

export interface HostShortcutEntry {
  readonly combo: string
  readonly description: string
}

export interface HostShortcutsPort {
  register(combo: string, options: HostShortcutOptions): HostDisposer
  list(): readonly HostShortcutEntry[]
  dispatch(input: string, key: HostShortcutKey): boolean
}

// ── renderers ─────────────────────────────────────────────────────────────

export interface HostRenderResult {
  readonly title?: string
  readonly lines: readonly string[]
}

export type HostEntryRenderer = (payload: unknown) => HostRenderResult | undefined

export interface HostRenderersPort {
  register(type: string, renderer: HostEntryRenderer): HostDisposer
  render(type: string, payload: unknown): HostRenderResult | undefined
}

// ── themes ────────────────────────────────────────────────────────────────

export interface HostThemeDescriptor {
  readonly name: string
  readonly displayName?: string
  readonly base: 'light' | 'dark' | 'dark-ansi'
  readonly colors?: Readonly<Record<string, unknown>>
}

export interface HostThemeRegistration {
  readonly name: string
  readonly displayName: string
  readonly base: 'light' | 'dark' | 'dark-ansi'
  readonly colors: Readonly<Record<string, unknown>>
}

export interface HostThemesPort {
  register(descriptor: HostThemeDescriptor): HostDisposer
  snapshot(): readonly HostThemeRegistration[]
  resolve(name: string): unknown
  subscribe(listener: () => void): HostDisposer
}

// ── toast ─────────────────────────────────────────────────────────────────

export interface HostToastDelivery {
  readonly text: string
  readonly color?: 'success' | 'warning' | 'error'
  readonly timeoutMs: number
}

export interface HostToastPort {
  show(delivery: HostToastDelivery): boolean
}

// ── command trees ─────────────────────────────────────────────────────────

export interface HostCommandTreeProvider {
  readonly root: string
  children(canonicalPath: readonly string[]): readonly unknown[]
  readonly descriptions?: Readonly<Record<string, unknown>>
}

export interface HostCommandTreesPort {
  register(provider: HostCommandTreeProvider): HostDisposer
  children(canonicalPath: readonly string[]): readonly unknown[]
  descriptions(root: string): Readonly<Record<string, unknown>> | undefined
}

export type HostExtensionsDisposer = HostDisposer
