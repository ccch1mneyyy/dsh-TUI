/** Byte range of one structurally complete frame; `end` is exclusive. */
export interface FrameRange {
    readonly start: number;
    readonly end: number;
}
/**
 * Locate the end of the frame starting at `start`, without decompressing it.
 *
 * The walk reads the Frame_Header (descriptor, optional window/dictionary/
 * content-size fields) and then each Block_Header in turn — a 3-byte
 * little-endian word carrying `last_block` (1 bit), `block_type` (2 bits) and
 * `block_size` (21 bits) — until the block marked last. A `Reserved` block
 * type means these bytes are not a frame at all, which is how a coincidental
 * magic gets rejected.
 *
 * @param buffer - Bytes available to the reader (may end mid-frame).
 * @param start - Offset of the candidate frame's magic.
 * @returns The frame's exclusive end offset, or -1 when the bytes at `start`
 *   are not a structurally complete frame within `buffer`.
 */
export declare function frameEnd(buffer: Buffer, start: number): number;
/**
 * Walk complete frames forward from `from`.
 *
 * @param buffer - Bytes to walk.
 * @param from - Offset to start at (must be a frame boundary).
 * @param maxFrames - Stop after this many frames; the reader's cost ceiling.
 * @returns Complete frames in file order. A window that ends mid-frame simply
 *   yields one fewer frame — the partial tail is never reported as complete.
 */
export declare function walkFrames(buffer: Buffer, from?: number, maxFrames?: number): FrameRange[];
/**
 * Re-synchronize on a frame boundary inside a window that starts mid-frame.
 *
 * A tail window has no boundary to start from, so the only anchor is the one
 * structural fact we know about the whole file: its last frame ends exactly at
 * EOF. Every magic candidate is tried in file order, and the first one whose
 * frame chain lands precisely on the window's end is the true boundary — a
 * coincidental magic would have to spell a valid block chain of exactly the
 * right total length to be mistaken for one.
 *
 * @param buffer - A window whose last byte is the file's last byte.
 * @returns Frames from the earliest recoverable boundary, or [] when the
 *   window holds no complete frame.
 */
export declare function resyncFrames(buffer: Buffer): FrameRange[];
/** One decoded log line, still untyped — the caller owns interpretation. */
export type LogLine = Record<string, unknown>;
/**
 * Decode frames to JSON log lines, tolerantly.
 *
 * A frame that fails to decompress or a line that fails to parse is skipped
 * rather than thrown: a log being appended to right now can hold a frame
 * flushed without its final checksum, and a torn tail is the backend's own
 * documented recovery case. A picker label is read-only UI state — degrading
 * to a fallback title beats refusing to list the session.
 *
 * @param buffer - Bytes the frames index into.
 * @param frames - Complete frame ranges within `buffer`.
 * @returns Parsed envelopes in log order.
 */
export declare function decodeFrames(buffer: Buffer, frames: readonly FrameRange[]): LogLine[];
/** A file's size and last-write time, read once for both. */
export interface FileFacts {
    readonly bytes: number;
    readonly modifiedAt: number;
}
/**
 * Size and mtime of a log, or undefined when it is gone.
 * @param path - Absolute artifact path.
 */
export declare function fileFacts(path: string): FileFacts | undefined;
/**
 * Read a window from one end of a file without loading the whole thing.
 *
 * @param path - Absolute artifact path.
 * @param bytes - Window budget; the whole file is read when it is smaller.
 * @param end - Read the last `bytes` instead of the first.
 * @returns The window, plus whether it covers the entire file (which tells a
 *   head reader that its last frame cannot be truncated).
 */
export declare function readWindow(path: string, bytes: number, end?: boolean): {
    buffer: Buffer;
    whole: boolean;
} | undefined;
/**
 * Decode a window read from the END of a file.
 *
 * A tail window has no frame boundary to start from unless it happens to
 * cover the whole file, so it re-synchronizes; a whole-file window is simply
 * walked.
 *
 * @param window - A window whose last byte is the file's last byte.
 * @returns Log lines from the trailing frames, oldest first.
 */
export declare function decodeTail(window: {
    buffer: Buffer;
    whole: boolean;
}): LogLine[];
//# sourceMappingURL=frames.d.ts.map