import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// lib/ is exclusively generated output. Resolve it from this script instead
// of the caller's cwd so the cleanup target cannot drift outside the package.
const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
rmSync(libDir, { recursive: true, force: true })
