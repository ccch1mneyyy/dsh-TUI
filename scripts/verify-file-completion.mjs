#!/usr/bin/env node
/** Regression coverage for `@` completion in large generated trees (#278). */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

const fixture = await mkdtemp(join(tmpdir(), 'dsh-tui-file-completion-'))

function makeAgent() {
  return {
    id: 'file-completion-agent',
    ctx: { on: () => () => {} },
    status: 'idle',
    session: { id: 'file-completion-session', seq: 0, events: [] },
  }
}

const fsService = {
  async resolve(path) {
    return { displayPath: path }
  },
  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { displayPath: join(target.displayPath, entry.name) },
      }))
  },
}

try {
  const cmakeFiles = join(fixture, 'build_u22', 'CMakeFiles')
  const cmakePresetFiles = join(fixture, 'cmake-build-debug', 'CMakeFiles')
  const sourceDir = join(fixture, 'src')
  await mkdir(cmakeFiles, { recursive: true })
  await mkdir(cmakePresetFiles, { recursive: true })
  await mkdir(sourceDir)
  await Promise.all([
    ...Array.from({ length: 120 }, (_, index) =>
      writeFile(join(cmakeFiles, `artifact-${String(index).padStart(3, '0')}.o`), ''),
    ),
    writeFile(join(cmakePresetFiles, 'compiler_depend.make'), ''),
    writeFile(join(sourceDir, 'main.cpp'), 'int main() {}\n'),
  ])

  const ctx = {
    on: () => () => {},
    get(name) {
      return name === 'fs' ? fsService : undefined
    },
    logger: { warn() {} },
  }
  const channel = createChannel(ctx, makeAgent(), {
    model: 'test-model',
    provider: 'test-provider',
    cwd: fixture,
    activity: false,
  })

  const files = await channel.listFiles()
  assert.ok(
    files.includes('src/main.cpp'),
    `source file was crowded out by generated files:\n${files.join('\n')}`,
  )
  assert.ok(files.every(file => !file.startsWith('build_u22/')))
  assert.ok(files.every(file => !file.startsWith('cmake-build-debug/')))
  console.log('PASS: CMake build output cannot crowd source files out of @ completion')

  const generatedDir = join(fixture, 'generated')
  await mkdir(generatedDir)
  await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      writeFile(join(generatedDir, `generated-${String(index).padStart(3, '0')}.ts`), ''),
    ),
  )

  const filesWithLargeSibling = await channel.listFiles()
  assert.ok(
    filesWithLargeSibling.includes('src/main.cpp'),
    `an earlier sibling directory consumed the global completion budget:\n${filesWithLargeSibling.join('\n')}`,
  )
  console.log('PASS: a large sibling directory cannot crowd source files out of @ completion')

  const nestedSourceDir = join(sourceDir, 'features', 'editor')
  await mkdir(nestedSourceDir, { recursive: true })
  await writeFile(join(nestedSourceDir, 'view.ts'), 'export const view = true\n')

  const filesWithNestedSource = await channel.listFiles()
  assert.ok(
    filesWithNestedSource.includes('src/features/editor/view.ts'),
    `ordinary nested source exceeded the completion depth limit:\n${filesWithNestedSource.join('\n')}`,
  )
  console.log('PASS: ordinary nested source remains reachable in @ completion')
} finally {
  await rm(fixture, { recursive: true, force: true })
}
