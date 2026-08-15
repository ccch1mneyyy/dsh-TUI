import React from 'react';
import type { LlmModelInfo } from '../dsh-adapter/types.js';
/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the model list as Select rows (❯ focus pointer, ✓ on the active model,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 *
 * 长列表按焦点窗口化（Select 同款）：picker 经 OverlayAbove 浮层挂载后有
 * maxHeight 裁剪，全量渲染会让焦点行被裁掉（看不到焦点按 Enter）。
 */
export declare function ModelPicker({ models, focusIndex, currentModel, }: {
    models: readonly LlmModelInfo[];
    focusIndex: number;
    currentModel: string;
}): React.ReactNode;
//# sourceMappingURL=ModelPicker.d.ts.map