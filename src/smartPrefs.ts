/** Durable Smart enhancement preference and per-session fork state. */
import {
  type EnhancementSessionEvent,
  type EnhancementSessionHeader,
  enhancementModeOf,
  readEnhancementDefault,
  readEnhancementSession,
  resolvePersistedEnhancement,
  writeEnhancementDefault,
  writeEnhancementSession,
} from './enhancementPrefs.js'

const DEFINITION = { file: 'smart.json' } as const

export const readSmartDefault = (dir?: string): boolean | undefined =>
  readEnhancementDefault(DEFINITION, dir)
export const writeSmartDefault = (enabled: boolean, dir?: string): boolean =>
  writeEnhancementDefault(DEFINITION, enabled, dir)
export const readSmartSession = (sessionId: string, dir?: string): boolean | undefined =>
  readEnhancementSession(DEFINITION, sessionId, dir)
export const writeSmartSession = (sessionId: string, enabled: boolean, dir?: string): boolean =>
  writeEnhancementSession(DEFINITION, sessionId, enabled, dir)

export function smartModeOf(
  session: { header: EnhancementSessionHeader; events: readonly EnhancementSessionEvent[] },
  stored?: boolean,
): boolean {
  return enhancementModeOf(DEFINITION, session, stored)
}

export async function resolvePersistedSmart(
  ctx: { get(name: string): unknown },
  sessionId: string,
): Promise<boolean> {
  return await resolvePersistedEnhancement(DEFINITION, ctx, sessionId)
}
