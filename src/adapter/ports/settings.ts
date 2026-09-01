/**
 * Internal Host Port for settings-section contributions.
 *
 * This port models the TUI host's settings editor surface: declared
 * sections, fields, groups, and the subscribe feed. It deliberately carries
 * no dsh settings protocol / revision / permission semantics and no
 * caller-supplied owner.
 */

import type { HostDisposer } from './owner.js'

export type HostSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

export interface HostSettingsFieldOption {
  readonly value: string
  readonly label: string
}

export interface HostSettingsGroup {
  readonly id: string
  readonly title: string
}

export interface HostSettingsField {
  readonly path: readonly string[]
  readonly label: string
  readonly hint?: string
  readonly group?: string
  readonly kind: HostSettingsFieldKind
  readonly options?: readonly HostSettingsFieldOption[]
  readonly placeholder?: string
  readonly secret?: { readonly ref: string }
}

export interface HostSettingsSection {
  readonly ns: string
  readonly title: string
  readonly groups?: readonly HostSettingsGroup[]
  readonly fields: readonly HostSettingsField[]
}

export interface HostSettingsPort {
  register(section: HostSettingsSection): HostDisposer
  list(): readonly HostSettingsSection[]
  section(ns: string): HostSettingsSection | undefined
  subscribe(listener: () => void): HostDisposer
}

export type HostSettingsDisposer = HostDisposer
