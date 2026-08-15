import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * The plan-review panel — Claude Code style exit-plan-mode decision card
 * for the DSH user-interaction seam. plan-mode's `exit_plan_mode` tool asks
 * through `ctx.userQuestions` with `intent: { kind: 'plan-review',
 * approve }`: the plan markdown arrives in `detail`, the approve/decline
 * choices in `options` (labels verbatim — the protocol answers with the
 * asker's own labels).
 *
 * Protocol-exact answer mapping (dsh-plan-mode):
 * - Approve: `{ selected: [intent.approve] }` — custom MUST be absent, or
 *   plan-mode treats it as keep-planning-with-feedback.
 * - Keep planning / feedback: `{ selected: [declineLabel], custom? }` where
 *   declineLabel is the first option that is not the approve label.
 * - Esc / Ctrl+C: the store rejects with ASK_CANCELLED, which plan-mode
 *   reads as "the user dismissed the review to speak instead".
 */
import React from 'react';
import { t } from '../../i18n.js';
import { Box, Text, useInput } from '../../ui.js';
import { Divider } from '../design-system/Divider.js';
import { Markdown } from '../Markdown.js';
import { POINTER } from '../../cc/figures.js';
import { isPlainReturnInput } from '../../utils/modifiers.js';
const PENCIL = '✎';
export function PlanReviewPanel({ question, onAnswer, onCancel, }) {
    const options = question.options ?? [];
    const approveLabel = question.intent?.approve ?? options[0]?.label;
    const declineLabel = options.find(option => option.label !== approveLabel)?.label;
    /** Rows: the asker's options plus the feedback input row at the tail. */
    const rowCount = options.length + 1;
    const [focusIndex, setFocusIndex] = React.useState(0);
    const [feedback, setFeedback] = React.useState('');
    const [cursor, setCursor] = React.useState(0);
    const [error, setError] = React.useState(null);
    const inputFocused = focusIndex === options.length;
    const moveFocus = (delta) => {
        setFocusIndex(index => (index + delta + rowCount) % rowCount);
        setError(null);
    };
    /** Typing anywhere appends to the feedback buffer and focuses the input
     *  row — plan review has no "attach" semantics: approve must be clean. */
    const appendFeedback = (text) => {
        setFeedback(previous => previous + text);
        setCursor(previous => previous + text.length);
        setFocusIndex(options.length);
        setError(null);
    };
    const backspaceFeedback = () => {
        if (cursor <= 0)
            return;
        setFeedback(previous => previous.slice(0, cursor - 1) + previous.slice(cursor));
        setCursor(previous => previous - 1);
    };
    /** The decline answer: the other option's label when the asker named one,
     *  else an empty selection (plan-mode reads any non-approve as decline). */
    const declineSelected = () => declineLabel !== undefined ? [declineLabel] : [];
    /** Enter on an option row. Approve with feedback in the buffer is an
     *  error — the protocol would silently read it as keep-planning. */
    const submitOption = (index) => {
        const label = options[index]?.label;
        if (label === undefined)
            return;
        const text = feedback.trim();
        if (label === approveLabel && text !== '') {
            setError(t('plan-review-approve-needs-empty'));
            return;
        }
        if (label === approveLabel) {
            onAnswer({ selected: [label] });
            return;
        }
        onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) });
    };
    /** Enter on the feedback row: text routes to keep-planning-with-feedback;
     *  empty is a plain keep-planning. */
    const submitFeedback = () => {
        const text = feedback.trim();
        onAnswer({ selected: declineSelected(), ...(text !== '' ? { custom: text } : {}) });
    };
    useInput((input, key) => {
        if (key.escape || (key.ctrl && input === 'c')) {
            onCancel();
            return;
        }
        if (inputFocused) {
            if (key.upArrow) {
                moveFocus(-1);
                return;
            }
            if (key.downArrow) {
                moveFocus(1);
                return;
            }
            if (isPlainReturnInput(input, key)) {
                submitFeedback();
                return;
            }
            if (key.backspace) {
                backspaceFeedback();
                return;
            }
            if (key.delete) {
                if (cursor < feedback.length) {
                    setFeedback(text => text.slice(0, cursor) + text.slice(cursor + 1));
                }
                return;
            }
            if (key.leftArrow) {
                setCursor(value => Math.max(0, value - 1));
                return;
            }
            if (key.rightArrow) {
                setCursor(value => Math.min(feedback.length, value + 1));
                return;
            }
            if (key.home) {
                setCursor(0);
                return;
            }
            if (key.end) {
                setCursor(feedback.length);
                return;
            }
            if (!key.ctrl && !key.meta && input) {
                setFeedback(text => text.slice(0, cursor) + input + text.slice(cursor));
                setCursor(value => value + input.length);
                setError(null);
            }
            return;
        }
        // An option row.
        if (key.upArrow) {
            moveFocus(-1);
            return;
        }
        if (key.downArrow) {
            moveFocus(1);
            return;
        }
        if (isPlainReturnInput(input, key)) {
            submitOption(focusIndex);
            return;
        }
        if (key.backspace) {
            if (feedback !== '')
                backspaceFeedback();
            return;
        }
        if (!key.ctrl && !key.meta && input) {
            // Number quick-pick submits the option outright — but only with an
            // empty buffer; with feedback pending, digits are feedback chars.
            const digit = /^[1-9]$/.test(input) ? Number(input) : 0;
            if (feedback === '' && digit >= 1 && digit <= options.length) {
                submitOption(digit - 1);
                return;
            }
            appendFeedback(input);
        }
    }, { isActive: true });
    const cursorChar = cursor < feedback.length ? feedback[cursor] : ' ';
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Divider, { color: "permission", title: ` ${question.header ?? t('plan-review-fallback-header')} `, padding: 4 }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, wrap: "wrap", children: question.question }), question.detail !== undefined && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: _jsx(Markdown, { children: question.detail }) }))] }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [options.map((option, index) => {
                        const focused = index === focusIndex;
                        const isApprove = option.label === approveLabel;
                        return (_jsxs(Box, { flexDirection: "row", marginTop: focused ? 1 : 0, children: [_jsx(Box, { width: 1, flexShrink: 0, children: _jsx(Text, { color: focused ? 'claude' : undefined, bold: focused, children: focused ? POINTER : ' ' }) }), _jsxs(Box, { flexDirection: "column", marginLeft: 1, children: [_jsxs(Text, { bold: focused, color: focused || isApprove ? 'claude' : undefined, wrap: "wrap", children: [index + 1, ". ", option.label] }), option.description !== undefined && (_jsx(Text, { dimColor: true, wrap: "wrap", children: option.description }))] })] }, option.label));
                    }), _jsxs(Box, { flexDirection: "row", marginTop: inputFocused ? 1 : 0, children: [_jsx(Box, { width: 1, flexShrink: 0, children: _jsx(Text, { color: inputFocused ? 'claude' : undefined, bold: inputFocused, children: inputFocused ? POINTER : ' ' }) }), _jsx(Box, { width: 1, flexShrink: 0, children: _jsx(Text, { color: inputFocused ? 'claude' : 'suggestion', children: PENCIL }) }), _jsx(Box, { flexDirection: "row", marginLeft: 1, children: feedback === '' && !inputFocused ? (_jsx(Text, { dimColor: true, children: t('plan-review-feedback-placeholder') })) : (_jsxs(_Fragment, { children: [_jsx(Text, { wrap: "wrap", children: feedback.slice(0, cursor) }), inputFocused
                                            ? _jsx(Text, { inverse: true, children: cursorChar })
                                            : _jsx(Text, { color: "suggestion", children: "\u258F" }), _jsx(Text, { wrap: "wrap", children: feedback.slice(inputFocused ? cursor + 1 : cursor) })] })) })] })] }), error !== null && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "error", children: error }) })), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t('plan-review-hint') }) })] }));
}
