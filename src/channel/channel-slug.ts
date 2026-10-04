import { createHash } from 'node:crypto'

/**
 * The stable id of a channel profile name: lowercase ASCII, runs of other
 * characters collapsed to `-`, edges trimmed. A name with no ASCII letter or
 * digit (智谱, 硅基流动) gets `channel-<first 8 hex of its sha256>` instead,
 * so two such names never share one id (nor the token ref derived from it).
 * Shared by the /channel wizard and the Claude backend's channel store.
 */
export function channelProfileSlug(name: string): string {
  const trimmed = name.trim()
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug !== '') return slug
  return `channel-${createHash('sha256').update(trimmed.normalize('NFC')).digest('hex').slice(0, 8)}`
}
