/**
 * Input type from the first bytes, so callers can pass bytes without a file name or MIME type.
 */
import type { DocumentModel } from '../model/types'

export type MimeType = DocumentModel['meta']['mimeType']

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x)

/** The MIME type of `bytes` by magic number, or null when it is none of the supported types. */
export function sniffMimeType(bytes: Uint8Array): MimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  // "%PDF-" may be preceded by junk (some generators write a BOM or a few bytes first).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  if (head.includes('%PDF-')) return 'application/pdf'
  if (looksLikeText(bytes)) return 'text/plain'
  return null
}

/** Valid UTF-8 without control characters other than tab/newline/CR: plain text. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return false
  try {
    // stream: a multi-byte character cut at the 4096-byte boundary is not an error.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 4096), { stream: true })
    return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)
  } catch {
    return false
  }
}
