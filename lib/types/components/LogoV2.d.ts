import React from 'react';
/**
 * The header splash: one layout, two phases. The **opening** (~3.4s, once)
 * plays the hand-drawn whale animation (blink → water-spout bloom → tail
 * wag) and runs the shimmer sweeps; the **settled** header is the same
 * tree frozen at t=0 — whale on the standard pose, sweep highlights parked
 * off-screen, clock unsubscribed, zero timers.
 *
 * Layout: the 13-row pixel whale beside a text column of matching height —
 * the `✦ dsh-TUI` wordmark with version, the `DEEPSEEK`/`HARNESS` tagline in
 * the 5-row block font (brand-blue → ice gradient), the model/effort and
 * cwd in plain text (no brand-color highlight), the startup tip, and below
 * the whale the welcome tagline, centered under the art, in ice
 * blue. Narrow terminals drop the whale and keep the text column.
 */
export declare function LogoV2({ model, effort, cwd, skipIntro, }: {
    model: string;
    effort?: string | undefined;
    cwd: string;
    /** Test seam: mount straight into the settled header (probes skip the intro). */
    skipIntro?: boolean;
}): React.ReactNode;
//# sourceMappingURL=LogoV2.d.ts.map