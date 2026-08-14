import { jsx as _jsx } from "react/jsx-runtime";
import { c as _c } from "react/compiler-runtime";
/**
 * Adds one or more newline (\n) characters. Must be used within <Text> components.
 */
export default function Newline(t0) {
    const $ = _c(4);
    const { count: t1 } = t0;
    const count = t1 === undefined ? 1 : t1;
    let t2;
    if ($[0] !== count) {
        t2 = "\n".repeat(count);
        $[0] = count;
        $[1] = t2;
    }
    else {
        t2 = $[1];
    }
    let t3;
    if ($[2] !== t2) {
        t3 = _jsx("ink-text", { children: t2 });
        $[2] = t2;
        $[3] = t3;
    }
    else {
        t3 = $[3];
    }
    return t3;
}
