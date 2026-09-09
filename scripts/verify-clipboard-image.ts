/** Regression checks for Ctrl+V image placeholders and Explorer image paths. */

import { expandMentions } from '../src/dsh-adapter/channel.js'
import { formatClipboardInsert } from '../src/utils/clipboard.js'

const fileInsert = formatClipboardInsert({
  kind: 'files',
  paths: ['C:\\shots\\cover.png', 'C:\\notes\\read me.txt'],
})
if (fileInsert !== '@C:\\shots\\cover.png "C:\\notes\\read me.txt"') {
  throw new Error(`Explorer image path was not converted to an @ mention: ${fileInsert}`)
}

const attachment = {
  attachmentId: 'sha256:clipboard-regression' as never,
  mediaType: 'image/png' as const,
  bytes: 128,
  width: 4,
  height: 4,
  name: 'clipboard.png',
}
const attachments = {
  imageLimits: {
    maxImageBytes: 1024,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 4096,
    mediaTypes: ['image/png'] as const,
  },
  saveImage: async () => attachment,
}
const result = await expandMentions(
  undefined,
  '.',
  'Describe [Image #1]',
  attachments,
  new Map([['[Image #1]', attachment]]),
)
if (result.blocks.length !== 2 || result.blocks[1]?.type !== 'image') {
  throw new Error('Clipboard placeholder did not produce one image block.')
}

const unavailableAttachments = await expandMentions(
  undefined,
  '.',
  'Describe [Image #1]',
  undefined,
  new Map([['[Image #1]', attachment]]),
)
if (unavailableAttachments.blocks.length !== 1 || unavailableAttachments.missing[0] !== '[Image #1]') {
  throw new Error('A staged image did not fail loud after the attachment service disappeared.')
}

const mentionedAttachment = {
  ...attachment,
  attachmentId: 'sha256:mention-regression' as never,
  bytes: 3,
  name: 'mentioned.png',
}
const imageFs = {
  resolve: async (path: string) => ({ displayPath: path }),
  stat: async () => ({ type: 'file' as const }),
  readText: async () => '',
  readBytes: async () => new Uint8Array([1, 2, 3]),
  listDir: async () => [],
}
const orderedExpansion = async (
  text: string,
  maxImagesPerMessage: number,
  maxMessageImageBytes = attachments.imageLimits.maxMessageImageBytes,
) => expandMentions(
  imageFs,
  '.',
  text,
  {
    ...attachments,
    imageLimits: { ...attachments.imageLimits, maxImagesPerMessage, maxMessageImageBytes },
    saveImage: async () => mentionedAttachment,
  },
  new Map([['[Image #1]', attachment]]),
)
const imageAttachments = (expansion: Awaited<ReturnType<typeof orderedExpansion>>) => expansion.blocks
  .filter((block): block is Extract<(typeof expansion.blocks)[number], { type: 'image' }> => block.type === 'image')
  .map(block => block.attachment)

const stagedThenMentioned = await orderedExpansion('[Image #1] compare @mentioned.png', 2)
if (
  imageAttachments(stagedThenMentioned)[0] !== attachment
  || imageAttachments(stagedThenMentioned)[1] !== mentionedAttachment
) {
  throw new Error('Staged and @ image blocks did not preserve staged-first source order.')
}

const mentionedThenStaged = await orderedExpansion('@mentioned.png compare [Image #1]', 2)
if (
  imageAttachments(mentionedThenStaged)[0] !== mentionedAttachment
  || imageAttachments(mentionedThenStaged)[1] !== attachment
) {
  throw new Error('Staged and @ image blocks did not preserve @-first source order.')
}

const stagedWinsLimit = await orderedExpansion('[Image #1] compare @mentioned.png', 1)
if (
  imageAttachments(stagedWinsLimit).length !== 1
  || imageAttachments(stagedWinsLimit)[0] !== attachment
  || stagedWinsLimit.missing.join(',') !== 'mentioned.png'
) {
  throw new Error('The earlier staged image did not win the shared max-images limit.')
}

const mentionWinsLimit = await orderedExpansion('@mentioned.png compare [Image #1]', 1)
if (
  imageAttachments(mentionWinsLimit).length !== 1
  || imageAttachments(mentionWinsLimit)[0] !== mentionedAttachment
  || mentionWinsLimit.missing.join(',') !== '[Image #1]'
) {
  throw new Error('The earlier @ image did not win the shared max-images limit.')
}

const stagedWinsByteBudget = await orderedExpansion('[Image #1] compare @mentioned.png', 2, attachment.bytes)
if (
  imageAttachments(stagedWinsByteBudget).length !== 1
  || imageAttachments(stagedWinsByteBudget)[0] !== attachment
  || stagedWinsByteBudget.missing.join(',') !== 'mentioned.png'
) {
  throw new Error('The earlier staged image did not win the shared image-byte budget.')
}

const mentionWinsByteBudget = await orderedExpansion('@mentioned.png compare [Image #1]', 2, attachment.bytes)
if (
  imageAttachments(mentionWinsByteBudget).length !== 1
  || imageAttachments(mentionWinsByteBudget)[0] !== mentionedAttachment
  || mentionWinsByteBudget.missing.join(',') !== '[Image #1]'
) {
  throw new Error('The earlier @ image did not win the shared image-byte budget.')
}

process.stdout.write('clipboard image regression passed\n')
