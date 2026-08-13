import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { Children, isValidElement } from 'react';
import Text from '../../ink/components/Text.js';
/**
 * Joins children with a middot separator (" · ") for inline metadata display
 * (ported from the leak's design-system). Automatically filters out
 * null/undefined/false children and only renders separators between valid
 * elements.
 */
export function Byline({ children }) {
    // Children.toArray already filters out null, undefined, and booleans
    const validChildren = Children.toArray(children);
    if (validChildren.length === 0) {
        return null;
    }
    return (_jsx(_Fragment, { children: validChildren.map((child, index) => (_jsxs(React.Fragment, { children: [index > 0 && _jsx(Text, { dimColor: true, children: " \u00B7 " }), child] }, isValidElement(child) ? (child.key ?? index) : index))) }));
}
