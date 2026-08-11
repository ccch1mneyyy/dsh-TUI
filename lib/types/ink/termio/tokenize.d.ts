/**
 * Input Tokenizer - Escape sequence boundary detection
 *
 * Splits terminal input into tokens: text chunks and raw escape sequences.
 * Unlike the Parser which interprets sequences semantically, this just
 * identifies boundaries for use by keyboard input parsing.
 */
/** A chunk of terminal input: plain text or a raw escape sequence. */
export type Token = {
    type: 'text';
    value: string;
} | {
    type: 'sequence';
    value: string;
};
/** Streaming tokenizer for terminal input, buffering incomplete sequences. */
export type Tokenizer = {
    /** Feed input and get resulting tokens */
    feed(input: string): Token[];
    /** Flush any buffered incomplete sequences */
    flush(): Token[];
    /** Reset tokenizer state */
    reset(): void;
    /** Get any buffered incomplete sequence */
    buffer(): string;
};
type TokenizerOptions = {
    /**
     * Treat `CSI M` as an X10 mouse event prefix and consume 3 payload bytes.
     * Only enable for stdin input — `\x1b[M` is also CSI DL (Delete Lines) in
     * output streams, and enabling this there swallows display text. Default false.
     */
    x10Mouse?: boolean;
};
/**
 * Create a streaming tokenizer for terminal input.
 *
 * Usage:
 * ```typescript
 * const tokenizer = createTokenizer()
 * const tokens1 = tokenizer.feed('hello\x1b[')
 * const tokens2 = tokenizer.feed('A')  // completes the escape sequence
 * const remaining = tokenizer.flush()  // force output incomplete sequences
 * ```
 * @param options - tokenizer options; when omitted all defaults apply.
 * @returns the tokenizer instance.
 */
export declare function createTokenizer(options?: TokenizerOptions): Tokenizer;
export {};
//# sourceMappingURL=tokenize.d.ts.map