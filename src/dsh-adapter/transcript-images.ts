import type { ContentBlock } from '@deepseek-ai/dsh-llm'

type ImageBlock = Extract<ContentBlock, { type: 'image' }>
type ImageAttachment = ImageBlock['attachment']

/** UI-safe facade for one durable image block in the session transcript. */
export interface TranscriptImage {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly name?: string
  read(): Promise<Uint8Array>
}

interface AttachmentReader {
  readImage(
    attachment: ImageAttachment,
    signal?: AbortSignal,
  ): Promise<{ readonly data: Uint8Array }>
}

/**
 * Project durable image blocks without leaking the DSH attachment service
 * into UI code. The returned reader resolves the service at call time so a
 * late-mounted attachment provider still works.
 */
export function transcriptImagesOf(
  content: readonly ContentBlock[] | undefined,
  resolveAttachments: () => unknown,
): readonly TranscriptImage[] {
  const images: TranscriptImage[] = []
  const visit = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'tool-result') {
        visit(block.content)
        continue
      }
      if (block.type !== 'image') continue
      const attachment = validAttachment(block.attachment)
      if (attachment === undefined) continue
      images.push({
        id: String(attachment.attachmentId),
        width: attachment.width,
        height: attachment.height,
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
        async read() {
          const reader = resolveAttachments() as AttachmentReader | undefined
          if (typeof reader?.readImage !== 'function') {
            throw new Error('image attachments are unavailable in this profile')
          }
          const stored = await reader.readImage(attachment)
          if (!(stored?.data instanceof Uint8Array)) {
            throw new Error('attachment store returned invalid image data')
          }
          return stored.data
        },
      })
    }
  }
  visit(content ?? [])
  return images
}

function validAttachment(value: unknown): ImageAttachment | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const attachment = value as Partial<ImageAttachment>
  if (
    typeof attachment.attachmentId !== 'string' ||
    attachment.attachmentId === '' ||
    typeof attachment.mediaType !== 'string' ||
    !/^image\/[a-z0-9.+-]+$/u.test(attachment.mediaType) ||
    !positiveInteger(attachment.width) ||
    !positiveInteger(attachment.height)
  ) {
    return undefined
  }
  if (attachment.name !== undefined && typeof attachment.name !== 'string') {
    return undefined
  }
  return attachment as ImageAttachment
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
