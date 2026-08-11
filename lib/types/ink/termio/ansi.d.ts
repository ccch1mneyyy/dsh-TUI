/**
 * ANSI Control Characters and Escape Sequence Introducers
 *
 * Based on ECMA-48 / ANSI X3.64 standards.
 */
/**
 * C0 (7-bit) control characters
 */
export declare const C0: {
    readonly NUL: 0;
    readonly SOH: 1;
    readonly STX: 2;
    readonly ETX: 3;
    readonly EOT: 4;
    readonly ENQ: 5;
    readonly ACK: 6;
    readonly BEL: 7;
    readonly BS: 8;
    readonly HT: 9;
    readonly LF: 10;
    readonly VT: 11;
    readonly FF: 12;
    readonly CR: 13;
    readonly SO: 14;
    readonly SI: 15;
    readonly DLE: 16;
    readonly DC1: 17;
    readonly DC2: 18;
    readonly DC3: 19;
    readonly DC4: 20;
    readonly NAK: 21;
    readonly SYN: 22;
    readonly ETB: 23;
    readonly CAN: 24;
    readonly EM: 25;
    readonly SUB: 26;
    readonly ESC: 27;
    readonly FS: 28;
    readonly GS: 29;
    readonly RS: 30;
    readonly US: 31;
    readonly DEL: 127;
};
/** ESC control character (0x1B), the introducer of every escape sequence. */
export declare const ESC = "\u001B";
/** BEL control character (0x07), the common OSC sequence terminator. */
export declare const BEL = "\u0007";
/** Parameter separator used inside CSI and OSC sequences. */
export declare const SEP = ";";
/**
 * Escape sequence type introducers (byte after ESC)
 */
export declare const ESC_TYPE: {
    readonly CSI: 91;
    readonly OSC: 93;
    readonly DCS: 80;
    readonly APC: 95;
    readonly PM: 94;
    readonly SOS: 88;
    readonly ST: 92;
};
/**
 * Check if a byte is a C0 control character.
 * @param byte - the byte value to check.
 * @returns true when the byte is in the C0 range (0x00-0x1F) or is DEL (0x7F).
 */
export declare function isC0(byte: number): boolean;
/**
 * Check if a byte is an ESC sequence final byte (0-9, :, ;, <, =, >, ?, @ through ~).
 * ESC sequences have a wider final byte range than CSI.
 * @param byte - the byte value to check.
 * @returns true when the byte is in the final-byte range (0x30-0x7E).
 */
export declare function isEscFinal(byte: number): boolean;
//# sourceMappingURL=ansi.d.ts.map