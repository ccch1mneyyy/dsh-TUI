import { parentPort } from 'node:worker_threads'
import { SixelEncoderCache } from './sixel-codec.js'
import type { SixelWorkerRequest } from './sixel-codec.js'

const cache = new SixelEncoderCache()
parentPort?.on('message', async (request: SixelWorkerRequest) => {
  try {
    parentPort?.postMessage(await cache.render(request))
  } catch {
    // Do not send image contents, paths or native decoder diagnostics to TTY.
    parentPort?.postMessage({ error: true })
  }
})
