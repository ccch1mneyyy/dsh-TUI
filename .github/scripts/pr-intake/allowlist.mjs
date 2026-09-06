import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export function parseUserList(content) {
  return new Set(content
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => line && !line.startsWith('#')))
}

export async function loadApprovedContributors(workspace) {
  try {
    const content = await readFile(join(workspace, '.github/APPROVED_CONTRIBUTORS'), 'utf8')
    return parseUserList(content)
  } catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw error
  }
}
