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

process.stdout.write('clipboard image regression passed\n')
