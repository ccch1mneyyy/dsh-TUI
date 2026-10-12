/**
 * The stable id of a channel profile name, for backends (D15).
 *
 * Backends keep their own channel store and must not reach into
 * `src/channel/` (B-3's boundary rule), while the `/channel` wizard keeps
 * using `src/channel/channel-slug.ts`. The two implementations MUST stay
 * byte-identical: the id is a *persistent* join key (the profile file's row
 * and the token ref derived from it), so a drift would make the wizard and a
 * backend disagree about which channel a row is.
 * `scripts/verify-claude-channels.ts` pins that equality over a name vector.
 *
 * A name with no ASCII letter or digit (智谱, 硅基流动) gets
 * `channel-<first 8 hex of its sha256>` instead, so two such names never
 * share one id.
 */
import { createHash } from 'node:crypto'

/** The id of a channel profile name: lowercase ASCII, runs of other
 *  characters collapsed to `-`, edges trimmed. */
export function channelProfileSlug(name: string): string {
  const trimmed = name.trim()
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug !== '') return slug
  return `channel-${createHash('sha256').update(trimmed.normalize('NFC')).digest('hex').slice(0, 8)}`
}
