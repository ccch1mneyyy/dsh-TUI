export declare const UPSTREAM_VALIDATED_VERSION = "0.1.0-rc.6";
/**
 * Framework packages version on their own lines; the contract validates
 * their MAJOR (breaking surface), not the harness rc number.
 */
export declare const UPSTREAM_FRAMEWORK_MAJORS: Record<string, number>;
/** Official packages the adapter consumes at runtime or as types. */
export declare const UPSTREAM_BLESSED_PACKAGES: readonly ["@deepseek-ai/cordis", "@deepseek-ai/schemastery", "@deepseek-ai/dsh-invariants", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-agent-instructions", "@deepseek-ai/dsh-agent-presets", "@deepseek-ai/dsh-commands", "@deepseek-ai/dsh-cordis-host-runner", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-persona", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-skill", "@deepseek-ai/dsh-storage", "@deepseek-ai/dsh-storage-domain", "@deepseek-ai/dsh-storage-json", "@deepseek-ai/dsh-workspace", "@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-terminal", "@deepseek-ai/dsh-terminal-bash", "@deepseek-ai/dsh-tool-ask-user", "@deepseek-ai/dsh-tool-bash-persistent", "@deepseek-ai/dsh-tool-cordis", "@deepseek-ai/dsh-user-approval", "@deepseek-ai/dsh-user-questions"];
export interface UpstreamDriftEntry {
    package: string;
    installed: string | undefined;
    validated: string;
}
export declare function installedUpstreamVersions(): Record<string, string | undefined>;
/**
 * Report every blessed package whose installed version is NOT the validated
 * release line. Empty array = the running install matches the contract.
 */
export declare function upstreamDrift(): UpstreamDriftEntry[];
//# sourceMappingURL=contract.d.ts.map