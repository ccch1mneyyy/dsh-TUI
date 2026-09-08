import { isAbsolute, join } from 'node:path'
import { extractMentions } from '../../utils/mentions.js'
import { COMPOSER_IMAGE_TOKEN } from './composer-images.js'
import {
  MENTION_MAX_DIR_ENTRIES,
  MENTION_MAX_FILE_CHARS,
  MENTION_MAX_TOTAL_CHARS,
  mentionImageMediaType,
  tryResolveMention,
} from './mentions.js'
import { basename } from './paths.js'
import type { MentionAttachments, MentionExpansion, MentionFs, MentionImageBlock } from './types.js'

/**
 * Expand a submitted text's `@` mentions (issue #15) into model-facing
 * attachment blocks: supported image files become durable image blocks,
 * other files contribute capped text, and directories contribute a shallow
 * listing. Reads always go through the active fs service, so provider-owned
 * workspaces keep their routing semantics. The typed text stays first and
 * verbatim. Best-effort failures degrade to `missing`, never a failed send.
 *
 * Staged composer images (`[Image #N]`) share ONE admission queue with
 * `@image` files: the earliest reference in the user's text wins both the
 * per-message count and byte budgets, and image blocks preserve that order.
 */
export async function expandComposerMentions(
  fs: MentionFs | undefined,
  cwd: string,
  text: string,
  attachments?: MentionAttachments,
  stagedImages?: ReadonlyMap<string, MentionImageBlock['attachment']>,
): Promise<MentionExpansion> {
  const blocks: MentionExpansion['blocks'] = [{ type: 'text', text }]
  const attached: string[] = []
  const missing: string[] = []
  const mentions = extractMentions(text)
  let budget = MENTION_MAX_TOTAL_CHARS
  let imageCount = 0
  let imageBytes = 0
  type ExpansionReference =
    | { kind: 'mention'; start: number; mention: (typeof mentions)[number] }
    | { kind: 'staged-image'; start: number; token: string; attachment: MentionImageBlock['attachment'] }
  const references: ExpansionReference[] = fs === undefined
    ? []
    : mentions.map(mention => ({ kind: 'mention', start: mention.start, mention }))
  if (stagedImages !== undefined) {
    const seen = new Set<string>()
    for (const match of text.matchAll(COMPOSER_IMAGE_TOKEN)) {
      const token = match[0]
      if (seen.has(token)) continue
      seen.add(token)
      const attachment = stagedImages.get(token)
      if (attachment === undefined) continue
      references.push({
        kind: 'staged-image',
        start: match.index,
        token,
        attachment,
      })
    }
  }
  references.sort((a, b) => a.start - b.start)

  // `@image` files and staged `[Image #N]` capabilities share one admission
  // queue. The earliest reference in the user's text wins both the per-
  // message count and byte budgets, and image blocks preserve that order.
  for (const reference of references) {
    if (reference.kind === 'staged-image') {
      const { attachment, token } = reference
      // A referenced-but-dropped staged image must be loud: silently sending
      // the bare token would leave the user believing the image reached the
      // model. Reuse the missing-mention warning channel.
      if (attachments === undefined) {
        missing.push(token)
        continue
      }
      const limits = attachments.imageLimits
      if (
        imageCount >= limits.maxImagesPerMessage
        || imageBytes + attachment.bytes > limits.maxMessageImageBytes
        || !limits.mediaTypes.includes(attachment.mediaType)
      ) {
        missing.push(token)
        continue
      }
      blocks.push({ type: 'image', attachment })
      imageCount += 1
      imageBytes += attachment.bytes
      continue
    }

    if (fs === undefined) continue
    const { mention } = reference
    const display = mention.literal ?? mention.path
    const imageMediaType = mentionImageMediaType(mention.path)
    // A depleted text budget must not hide a later image reference: image
    // admission has independent limits and still follows source order.
    if (budget <= 0 && imageMediaType === undefined) continue
    // Mentions resolve against the session cwd, same as the model-facing fs
    // tools; absolute paths pass through untouched. A `#L12-14` line suffix
    // (issue #359) is stripped before resolution; when the stripped path
    // misses, the typed literal (suffix intact) gets ONE fallback try so
    // filenames genuinely containing `#L…` still resolve as whole files.
    const absolute = isAbsolute(mention.path) ? mention.path : join(cwd, mention.path)
    let resolved = await tryResolveMention(fs, absolute)
    let literalFallback = false
    if (resolved === undefined && mention.literal !== undefined) {
      const literalPath = isAbsolute(mention.literal) ? mention.literal : join(cwd, mention.literal)
      resolved = await tryResolveMention(fs, literalPath)
      literalFallback = resolved !== undefined
    }
    if (resolved === undefined) {
      missing.push(display)
      continue
    }
    const { target, info } = resolved
    // On a literal-fallback hit the attached file IS the typed name — the
    // model must see that path, not the suffix-stripped one.
    const shownPath = literalFallback ? display : mention.path
    // …and judge image-ness by the typed extension in that case too.
    const imageType = literalFallback && mention.literal !== undefined
      ? mentionImageMediaType(mention.literal)
      : imageMediaType
    if (info?.type === 'file') {
      if (imageType !== undefined && attachments !== undefined && fs.readBytes !== undefined) {
        const limits = attachments.imageLimits
        if (!limits.mediaTypes.includes(imageType) || imageCount >= limits.maxImagesPerMessage) {
          missing.push(display)
          continue
        }
        try {
          const data = await fs.readBytes(target, undefined, limits.maxImageBytes)
          if (imageBytes + data.byteLength > limits.maxMessageImageBytes) {
            missing.push(display)
            continue
          }
          const attachment = await attachments.saveImage({
            data,
            mediaType: imageType,
            name: basename(target.displayPath),
          })
          blocks.push({ type: 'image', attachment })
          imageCount += 1
          imageBytes += data.byteLength
          attached.push(display)
        } catch {
          missing.push(display)
        }
        continue
      }
      try {
        const cap = Math.min(MENTION_MAX_FILE_CHARS, budget)
        const content = await fs.readText(target)
        let body = content
        let truncated = false
        let header = `<attached-file path="${shownPath}">`
        if (mention.startLine !== undefined && !literalFallback) {
          // Line-range slice (issue #359): 1-based inclusive. An endLine
          // past EOF clamps to the file; a startLine past EOF falls back
          // to the whole file with an in-band note — never a silent
          // empty attach. Line ranges never apply to literal-fallback
          // hits (those files really are named `…#L…`, no suffix typed).
          const lines = content.split('\n')
          if (mention.startLine > lines.length) {
            header = `<attached-file path="${shownPath}" lines="${mention.startLine}-${mention.endLine}" note="requested lines beyond EOF (file has ${lines.length} line${lines.length === 1 ? '' : 's'}); whole file attached">`
          } else {
            const endLine = Math.min(mention.endLine ?? mention.startLine, lines.length)
            header = `<attached-file path="${shownPath}" lines="${mention.startLine}${endLine === mention.startLine ? '' : `-${endLine}`}">`
            body = lines.slice(mention.startLine - 1, endLine).join('\n')
          }
        }
        if (body.length > cap) {
          body = body.slice(0, cap)
          truncated = true
        }
        budget -= body.length
        blocks.push({
          type: 'text',
          text: `${header}\n${body}${truncated ? '\n[… truncated]' : ''}\n</attached-file>`,
        })
        attached.push(display)
      } catch {
        // Binary/undecodable or unreadable — report it like a miss.
        missing.push(display)
      }
      continue
    }
    if (info?.type === 'directory') {
      try {
        const entries = await fs.listDir(target)
        const listing = entries
          .slice(0, MENTION_MAX_DIR_ENTRIES)
          .map(entry => (entry.type === 'directory' ? `${entry.name}/` : entry.name))
        if (entries.length > MENTION_MAX_DIR_ENTRIES) {
          listing.push(`… (${entries.length - MENTION_MAX_DIR_ENTRIES} more)`)
        }
        const body = listing.join('\n')
        budget -= body.length
        blocks.push({
          type: 'text',
          text: `<attached-directory path="${shownPath}">\n${body}\n</attached-directory>`,
        })
        attached.push(display)
      } catch {
        missing.push(display)
      }
      continue
    }
    // Absent (stat → undefined) or a special file.
    missing.push(display)
  }
  return { blocks, attached, missing }
}
