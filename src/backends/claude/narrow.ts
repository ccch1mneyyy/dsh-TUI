/** Narrowing helpers for the untyped SDK frames and transcript records. */

export type Rec = Readonly<Record<string, unknown>>

/** A plain object (not an array), else undefined. */
export const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined

export const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** A finite number, else undefined. */
export const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const arr = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
