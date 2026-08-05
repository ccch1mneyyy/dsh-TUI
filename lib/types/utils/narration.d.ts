/**
 * Strip the `⏵` self-narration line from assistant text. The
 * dsh-working-activity narrate contract puts exactly one `⏵` line at the
 * very top of a reply; the live working line already surfaces it, so
 * showing it again in the transcript would double it. Only the FIRST line
 * is checked — the contract allows one `⏵` line per reply.
 */
export declare function stripNarration(text: string): string;
//# sourceMappingURL=narration.d.ts.map