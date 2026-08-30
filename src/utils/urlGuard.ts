import { fileUrlToPath, parseFileLinkUrl } from './fileTarget.js'

/**
 * Security gate for URLs that leave the TUI via a click action.
 *
 * Link targets originate from model output (prompt injection can shape
 * them), plugin-rendered text, and file contents. Handing an arbitrary
 * scheme to the OS handler (`xdg-open` / `open` / cmd `start`) lets that
 * content launch registered protocol handlers — `ssh:`, custom IM
 * handlers, anything installed. Only http(s) and the TUI's own file
 * link forms may reach the OS; everything else is dropped here.
 */
export type OpenTargetClassification =
  | { kind: 'file-actions'; path: string }
  | { kind: 'external' }
  | { kind: 'rejected' }

const EXTERNAL_SCHEME = /^https?:\/\//i

/**
 * Classify a clicked link target. Mirrors the previous handleOpenTarget
 * dispatch order (dsh-file: and file: keep going through the file-action
 * menu), with the final fall-through narrowed from "open anything" to
 * "open http(s) only".
 * @param url - the clicked link target.
 * @returns the action the click handler should take.
 */
export function classifyOpenTarget(url: string): OpenTargetClassification {
  const fileLink = parseFileLinkUrl(url)
  if (fileLink !== undefined) return { kind: 'file-actions', path: fileLink }
  const filePath = fileUrlToPath(url)
  if (filePath !== undefined) return { kind: 'file-actions', path: filePath }
  if (EXTERNAL_SCHEME.test(url)) return { kind: 'external' }
  return { kind: 'rejected' }
}
