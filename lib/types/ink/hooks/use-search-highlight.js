import { useContext, useMemo } from 'react';
import StdinContext from '../components/StdinContext.js';
import instances from '../instances.js';
/**
 * Set the search highlight query on the Ink instance. Non-empty → all
 * visible occurrences are inverted on the next frame (SGR 7, screen-buffer
 * overlay, same damage machinery as selection). Empty → clears.
 *
 * This is a screen-space highlight — it matches the RENDERED text, not the
 * source message text. Works for anything visible (bash output, file paths,
 * error messages) regardless of where it came from in the message tree. A
 * query that matched in source but got truncated/ellipsized in rendering
 * won't highlight; that's acceptable — we highlight what you see.
 */
export function useSearchHighlight() {
    useContext(StdinContext); // anchor to App subtree for hook rules
    const ink = instances.get(process.stdout);
    return useMemo(() => {
        if (!ink) {
            return {
                setQuery: () => { },
                scanElement: () => [],
                setPositions: () => { },
            };
        }
        return {
            setQuery: (query) => ink.setSearchHighlight(query),
            scanElement: (el) => ink.scanElementSubtree(el),
            setPositions: state => ink.setSearchPositions(state),
        };
    }, [ink]);
}
//# sourceMappingURL=use-search-highlight.js.map