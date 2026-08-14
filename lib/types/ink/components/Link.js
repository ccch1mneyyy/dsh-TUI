import { jsx as _jsx } from "react/jsx-runtime";
import { c as _c } from "react/compiler-runtime";
import { supportsHyperlinks } from '../supports-hyperlinks.js';
import Text from './Text.js';
export default function Link(t0) {
    const $ = _c(5);
    const { children, url, fallback } = t0;
    const content = children ?? url;
    if (supportsHyperlinks()) {
        let t1;
        if ($[0] !== content || $[1] !== url) {
            t1 = _jsx(Text, { children: _jsx("ink-link", { href: url, children: content }) });
            $[0] = content;
            $[1] = url;
            $[2] = t1;
        }
        else {
            t1 = $[2];
        }
        return t1;
    }
    const t1 = fallback ?? content;
    let t2;
    if ($[3] !== t1) {
        t2 = _jsx(Text, { children: t1 });
        $[3] = t1;
        $[4] = t2;
    }
    else {
        t2 = $[4];
    }
    return t2;
}
