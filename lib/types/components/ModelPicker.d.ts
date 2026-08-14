import React from 'react';
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm';
/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the model list as Select rows (❯ focus pointer, ✓ on the active model,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 */
export declare function ModelPicker({ models, focusIndex, currentModel, }: {
    models: readonly LlmModelInfo[];
    focusIndex: number;
    currentModel: string;
}): React.ReactNode;
//# sourceMappingURL=ModelPicker.d.ts.map