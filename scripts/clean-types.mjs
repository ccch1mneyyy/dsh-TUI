import { rm } from 'node:fs/promises'

await rm(new URL('../lib/types/', import.meta.url), {
  force: true,
  recursive: true,
})
