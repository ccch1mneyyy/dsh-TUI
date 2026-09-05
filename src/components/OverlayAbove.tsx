import React from 'react'
import { Box } from '../ui.js'

/**
 * 瞬态面板的浮层容器：absolute 定位 + bottom:'100%' 把面板底边钉在锚点
 * （父元素）顶边，向上覆盖转录尾部行，自身**不占布局高度**。
 *
 * 为什么必须这样：inline 模式下整帧是内容高度。瞬态面板（picker/补全/
 * 对话框）若以 in-flow 方式挂载，帧高随之增长——终端滚动把帧顶行（splash、
 * 历史）推进 scrollback；面板关闭时的收缩重绘又把这些行重新写回视口，同一
 * 行在 scrollback 和视口各存一份（"每切一次 /model 多一份启动画"的真机报
 * 告）。浮层只改写既有行的单元格内容（帧高不变、零滚动、零沉积），关闭时
 * 原样写回，全程无重复。
 *
 * 先例：PromptInput 通知行（position=absolute marginTop={-1}）。
 *
 * 锚点纪律（防止浮层漂到 todo 上方的回归）：底部 chrome 里，凡是瞬态面板
 * 必须挂载在「输入簇」内——Chat 输入簇（可替换输入行链 + StatusLine +
 * 本浮层，见 Chat.tsx 底部 chrome），或 PromptInput 自身的输入行容器。绝不
 * 直接把 OverlayAbove 挂到包含 GoalTodoPanel 的外层 chrome Box 上：那里的
 * bottom:'100%' 会把面板顶到 todo 之上，远离输入框。in-flow 面板（问卷/
 * 对话框/提示等）走输入簇的替换链，天然落在输入行位置，同样不会越过 todo。
 */
export function OverlayAbove({
  children,
  maxHeight,
}: {
  children: React.ReactNode
  /** 防止面板高过可用区域时探出帧顶（短会话 + 高列表）。 */
  maxHeight?: number | undefined
}): React.ReactNode {
  return (
    <Box
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      flexDirection="column"
      justifyContent="flex-end"
      overflow="hidden"
      opaque
      {...(maxHeight === undefined ? {} : { maxHeight })}
    >
      {/* flexShrink={0}：内容超高时让 overflow 从顶部裁整行，而不是被 yoga
          把某个中间行挤成零高（挤压态的零高行会被渲染器跳过，列表中间凭
          空少一行且下方整体上移——30 模型实测焦点行消失）。 */}
      <Box flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  )
}
