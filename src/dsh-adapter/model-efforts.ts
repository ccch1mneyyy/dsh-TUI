import { STANDARD_EFFORT_LADDER } from '../effortPrefs.js'

export interface ModelEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export type ModelReasoning = boolean | {
  readonly efforts?: readonly ModelEffort[]
  readonly defaultEffort?: string
} | undefined

/** Same native metadata vocabulary for the picker and explicit launch options.
 * An omitted tier list on a reasoning model offers the native standard ladder;
 * an explicit empty list means the model offers no selectable effort. */
export function modelEfforts(reasoning: ModelReasoning, label: (id: string) => string = id => id): readonly ModelEffort[] {
  if (reasoning === undefined || reasoning === false) return []
  if (typeof reasoning === 'object' && reasoning.efforts !== undefined) return reasoning.efforts
  return STANDARD_EFFORT_LADDER.map(id => ({ id, name: label(id) }))
}
