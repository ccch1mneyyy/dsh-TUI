/**
 * Terminals that support OSC 8 hyperlinks but are not detected by the
 * supports-hyperlinks library. Checked against both TERM_PROGRAM and
 * LC_TERMINAL (the latter is preserved inside tmux).
 */
export declare const ADDITIONAL_HYPERLINK_TERMINALS: string[];
type EnvLike = Record<string, string | undefined>;
type SupportsHyperlinksOptions = {
    env?: EnvLike;
    stdoutSupported?: boolean;
};
/**
 * Returns whether stdout supports OSC 8 hyperlinks.
 * Extends the supports-hyperlinks library with additional terminal detection.
 * @param options Optional overrides for testing (env, stdoutSupported)
 * @returns true when stdout or the detected terminal supports hyperlinks.
 */
export declare function supportsHyperlinks(options?: SupportsHyperlinksOptions): boolean;
export {};
//# sourceMappingURL=supports-hyperlinks.d.ts.map