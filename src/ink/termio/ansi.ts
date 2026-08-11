/**
 * ANSI Control Characters and Escape Sequence Introducers
 *
 * Based on ECMA-48 / ANSI X3.64 standards.
 */

/**
 * C0 (7-bit) control characters
 */
export const C0 = {
  NUL: 0x00,
  SOH: 0x01,
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  ENQ: 0x05,
  ACK: 0x06,
  BEL: 0x07,
  BS: 0x08,
  HT: 0x09,
  LF: 0x0a,
  VT: 0x0b,
  FF: 0x0c,
  CR: 0x0d,
  SO: 0x0e,
  SI: 0x0f,
  DLE: 0x10,
  DC1: 0x11,
  DC2: 0x12,
  DC3: 0x13,
  DC4: 0x14,
  NAK: 0x15,
  SYN: 0x16,
  ETB: 0x17,
  CAN: 0x18,
  EM: 0x19,
  SUB: 0x1a,
  ESC: 0x1b,
  FS: 0x1c,
  GS: 0x1d,
  RS: 0x1e,
  US: 0x1f,
  DEL: 0x7f,
} as const

// String constants for output generation

/** ESC control character (0x1B), the introducer of every escape sequence. */
export const ESC = '\x1b'

/** BEL control character (0x07), the common OSC sequence terminator. */
export const BEL = '\x07'

/** Parameter separator used inside CSI and OSC sequences. */
export const SEP = ';'

/**
 * Escape sequence type introducers (byte after ESC)
 */
export const ESC_TYPE = {
  CSI: 0x5b, // [ - Control Sequence Introducer
  OSC: 0x5d, // ] - Operating System Command
  DCS: 0x50, // P - Device Control String
  APC: 0x5f, // _ - Application Program Command
  PM: 0x5e, // ^ - Privacy Message
  SOS: 0x58, // X - Start of String
  ST: 0x5c, // \ - String Terminator
} as const

/**
 * Check if a byte is a C0 control character.
 * @param byte - the byte value to check.
 * @returns true when the byte is in the C0 range (0x00-0x1F) or is DEL (0x7F).
 */
export function isC0(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f
}

/**
 * Check if a byte is an ESC sequence final byte (0-9, :, ;, <, =, >, ?, @ through ~).
 * ESC sequences have a wider final byte range than CSI.
 * @param byte - the byte value to check.
 * @returns true when the byte is in the final-byte range (0x30-0x7E).
 */
export function isEscFinal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x7e
}
