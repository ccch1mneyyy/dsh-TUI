import React from 'react';
/**
 * /btw side-question panel (CC's btw.tsx, inline-pane form like the local
 * pickers): title line with the question, a scrollable answer body (error /
 * markdown answer / answering spinner), and a hint line. Owns the keyboard
 * while open — every key it sees is consumed here.
 */
export declare function BtwPanel({ question, answer, error, streaming, onClose, onCopy, }: {
    question: string;
    answer: string;
    error?: string;
    streaming: boolean;
    onClose: () => void;
    onCopy: () => void;
}): React.ReactNode;
//# sourceMappingURL=BtwPanel.d.ts.map