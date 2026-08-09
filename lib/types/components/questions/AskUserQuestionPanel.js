import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The questionnaire panel — Claude Code style ask-user-question UI for the
 * DSH user-interaction seam. One question per panel (progress header, header
 * chip, wrapped question text, optional detail, option list with focus
 * pointer and multi-select checkmarks, free-text "Other" mode), styled in
 * the cc-tui mist-blue design language.
 */
import React from 'react';
import { Box, Text, useInput } from '../../ui.js';
import { Divider } from '../design-system/Divider.js';
import { POINTER } from '../../cc/figures.js';
const CHECKED = '◉';
const UNCHECKED = '○';
const PENCIL = '✎';
export function AskUserQuestionPanel({ question, position, total, answered, onAnswer, onCancel, }) {
    const options = question.options ?? [];
    const multiSelect = question.multiSelect === true;
    const [focusIndex, setFocusIndex] = React.useState(0);
    const [checked, setChecked] = React.useState(() => new Set());
    const [mode, setMode] = React.useState(options.length > 0 ? 'options' : 'custom');
    const [customText, setCustomText] = React.useState('');
    const [customCursor, setCustomCursor] = React.useState(0);
    const [error, setError] = React.useState(null);
    const moveFocus = (delta) => {
        if (options.length <= 1)
            return;
        setFocusIndex(index => (index + delta + options.length) % options.length);
    };
    const submitOptions = () => {
        if (multiSelect) {
            const selected = [...checked].sort((a, b) => a - b).map(index => options[index]?.label)
                .filter((label) => label !== undefined);
            if (selected.length === 0) {
                setError('至少选择一个选项，或按 Tab 输入自定义回答');
                return;
            }
            onAnswer({ selected });
            return;
        }
        const label = options[focusIndex]?.label;
        if (label === undefined) {
            setError('至少选择一个选项，或按 Tab 输入自定义回答');
            return;
        }
        onAnswer({ selected: [label] });
    };
    const submitCustom = () => {
        const custom = customText.trim();
        if (custom === '') {
            setError('先输入回答内容再提交');
            return;
        }
        const selected = multiSelect
            ? [...checked].sort((a, b) => a - b).map(index => options[index]?.label)
                .filter((label) => label !== undefined)
            : [];
        onAnswer({ selected, custom });
    };
    useInput((input, key) => {
        if (mode === 'custom') {
            if (key.escape) {
                if (options.length > 0) {
                    setMode('options');
                    setError(null);
                }
                else {
                    onCancel();
                }
                return;
            }
            if (key.ctrl && input === 'c') {
                onCancel();
                return;
            }
            if (key.return) {
                submitCustom();
                return;
            }
            if (key.backspace) {
                if (customCursor > 0) {
                    setCustomText(text => text.slice(0, customCursor - 1) + text.slice(customCursor));
                    setCustomCursor(cursor => cursor - 1);
                }
                return;
            }
            if (key.delete) {
                if (customCursor < customText.length) {
                    setCustomText(text => text.slice(0, customCursor) + text.slice(customCursor + 1));
                }
                return;
            }
            if (key.leftArrow) {
                setCustomCursor(cursor => Math.max(0, cursor - 1));
                return;
            }
            if (key.rightArrow) {
                setCustomCursor(cursor => Math.min(customText.length, cursor + 1));
                return;
            }
            if (key.home) {
                setCustomCursor(0);
                return;
            }
            if (key.end) {
                setCustomCursor(customText.length);
                return;
            }
            if (!key.ctrl && !key.meta && input) {
                setCustomText(text => text.slice(0, customCursor) + input + text.slice(customCursor));
                setCustomCursor(cursor => cursor + input.length);
            }
            return;
        }
        // Options mode.
        if (key.escape || (key.ctrl && input === 'c')) {
            onCancel();
            return;
        }
        if (key.upArrow) {
            moveFocus(-1);
            return;
        }
        if (key.downArrow) {
            moveFocus(1);
            return;
        }
        if (key.tab) {
            setMode('custom');
            setError(null);
            return;
        }
        if (input === ' ' && multiSelect) {
            setChecked(previous => {
                const next = new Set(previous);
                if (next.has(focusIndex))
                    next.delete(focusIndex);
                else
                    next.add(focusIndex);
                return next;
            });
            return;
        }
        if (key.return) {
            submitOptions();
        }
    }, { isActive: true });
    const remaining = total - answered;
    const headerTitle = ` 📋 提问 · 第 ${position}/${total} 题${remaining > 1 ? ` · 还剩 ${remaining} 题` : ''} `;
    const renderOptions = () => (_jsx(Box, { flexDirection: "column", marginTop: 1, children: options.map((option, index) => {
            const focused = index === focusIndex;
            const selected = multiSelect ? checked.has(index) : focused;
            return (_jsxs(Box, { flexDirection: "row", marginTop: focused ? 1 : 0, children: [_jsx(Box, { width: 1, flexShrink: 0, children: _jsx(Text, { color: focused ? 'claude' : undefined, bold: focused, children: focused ? POINTER : ' ' }) }), _jsx(Box, { width: 1, flexShrink: 0, children: _jsx(Text, { color: focused ? 'claude' : undefined, bold: selected, children: selected ? (multiSelect ? CHECKED : '●') : UNCHECKED }) }), _jsxs(Box, { flexDirection: "column", marginLeft: 1, children: [_jsx(Text, { bold: focused || selected, color: focused ? 'claude' : undefined, wrap: "wrap", children: option.label }), option.description !== undefined && (_jsx(Text, { dimColor: true, wrap: "wrap", children: option.description }))] })] }, option.label));
        }) }));
    const renderCustom = () => {
        const cursorChar = customCursor < customText.length ? customText[customCursor] : ' ';
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "suggestion", bold: true, children: [PENCIL, ' '] }), _jsx(Text, { color: "claude", bold: true, children: "\u81EA\u5B9A\u4E49\u56DE\u7B54" })] }), _jsxs(Box, { flexDirection: "row", marginTop: 1, children: [_jsx(Text, { wrap: "wrap", children: customText.slice(0, customCursor) }), _jsx(Text, { inverse: true, children: cursorChar }), _jsx(Text, { wrap: "wrap", children: customText.slice(customCursor + 1) })] })] }));
    };
    const hintParts = mode === 'custom'
        ? [
            'Enter 提交',
            ...(options.length > 0 ? ['Esc 返回选项'] : ['Esc 取消']),
            ...(multiSelect && checked.size > 0 ? [`已选 ${checked.size}`] : []),
        ]
        : [
            '↑/↓ 选择',
            ...(multiSelect ? ['Space 多选'] : []),
            ...(options.length > 0 ? ['Tab 自定义'] : []),
            'Enter 提交',
            'Esc 中断',
            ...(multiSelect && checked.size > 0 ? [`已选 ${checked.size}`] : []),
        ];
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Divider, { color: "permission", title: headerTitle }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [question.header !== undefined && (_jsxs(Text, { color: "suggestion", bold: true, children: ["\u25C8 ", question.header] })), _jsx(Text, { bold: true, wrap: "wrap", children: question.question }), question.detail !== undefined && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: question.detail.split('\n').map((line, index) => (_jsx(Text, { dimColor: true, italic: true, wrap: "wrap", children: line }, index))) }))] }), mode === 'custom' ? renderCustom() : renderOptions(), error !== null && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "error", children: error }) })), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: hintParts.join(' · ') }) })] }));
}
