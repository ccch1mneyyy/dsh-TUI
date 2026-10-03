import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { ThemeCatalogEntry } from '../themeCatalog.js'
import { buildSyntaxTheme } from '../terminal-utils/syntaxTheme.js'
import { getCliHighlightPromise, type CliHighlight } from '../terminal-utils/cliHighlight.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { Color } from '../ink/styles.js'
import { truncateMiddle } from '../utils/truncateMiddle.js'

/**
 * 调色板键 → 渲染原语接受的显式色值：Theme 的值是宽松 string（hex 或
 * `ansi:<name>`），而 Text/Box 的 color 联合类型要 Color。与 ThemePicker 的
 * swatches 同一个断言（`theme[key] as Color`）——resolveColor 对 `#`/`rgb(`/
 * `ansi256(`/`ansi:` 前缀原样透传，所以候选主题的色不会被当前主题改写。
 */
function ink(color: string): Color {
  return color as Color
}

/**
 * `/theme` 右列的预览面板：用**被预览主题**的调色板（而不是当前生效主题）
 * 实渲染一段语法高亮代码块、一张代码操作工具卡和三行 diff。
 *
 * 为什么要有它：列表行只有 accent/text/success 三个色块，挑主题时看不到
 * 语法色（syntax*）、diff 色（diffAdded/diffRemoved）和工具卡底色
 * （toolCard 族/toolDot 族）——而那才是每天盯着的部分。预览跟随焦点行，移动
 * 光标即可比较，不必先 Enter 应用再后悔。
 *
 * 颜色全部走**显式色值**：调色板里的 hex/`ansi:` 值经 ThemedText/ThemedBox
 * 的 resolveColor 原样透传（那里只解析主题键名），于是预览列抹的是候选主题
 * 的色，而外层列表仍是当前主题——不需要给 design-system 加调色板覆盖层。
 * 同理这里一律不写 `dimColor`：ThemedText 的 dimColor 会盖掉传入的 color，
 * 把候选色换成**当前主题**的 inactive。
 */
export function ThemePreviewPane({
  entry,
  rows,
  width,
}: {
  /** 焦点行主题（目录条目自带已解析的完整调色板）。 */
  entry: ThemeCatalogEntry
  /** 预览列可用行数（已按浮层高度预算钳过）；装不下的块从底部裁掉。 */
  rows: number
  /** 预览列宽度（终端列数）：抬头主题名与跟随提示按它截断，不换行。 */
  width: number
}): React.ReactNode {
  const palette = entry.theme
  const [highlight, setHighlight] = React.useState<CliHighlight | null>(null)

  React.useEffect(() => {
    let alive = true
    // cli-highlight 是懒加载的（与 markdown.ts 的 fenced code 同一条路径）：
    // 首帧先上纯文本，加载完成后原位补色——不为预览阻塞浮层打开，也不改
    // 代码块在转录里的首帧行为。
    void getCliHighlightPromise().then((loaded) => {
      if (alive) setHighlight(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  const codeLines = React.useMemo(() => {
    const plain = SAMPLE_CODE.split('\n')
    if (highlight === null) return plain
    try {
      return highlight
        .highlight(SAMPLE_CODE, { language: 'typescript', theme: buildSyntaxTheme(palette) })
        .replace(/\n+$/u, '')
        .split('\n')
    } catch {
      // 高亮抛错（语言表缺失等）只降级为纯文本，绝不把浮层带崩。
      return plain
    }
  }, [highlight, palette])

  const label = t('theme-preview-title')
  const name = truncateMiddle(entry.displayName, Math.max(width - stringWidth(label) - 4, 4))

  const body: React.ReactNode[] = [
    <Box key="head" flexDirection="row">
      <Text color={ink(palette.accent)} bold>
        {label}
      </Text>
      <Text color={ink(palette.subtle)}>{' · '}</Text>
      <Text color={ink(palette.text)}>{name}</Text>
    </Box>,
    <Text key="follow" color={ink(palette.subtle)}>
      {truncateMiddle(t('theme-preview-follow'), Math.max(width, 1))}
    </Text>,
    <Text key="fence" color={ink(palette.subtle)}>{'```ts'}</Text>,
    ...codeLines.map((line, index) => (
      <Text key={`code-${index}`}>{`${CODE_INDENT}${line}`}</Text>
    )),
    // 工具卡按**默认外观**画：`toolBackground` 默认 'none'，真机卡片不涂底，
    // 预览涂一层 toolCardBackground 就是在展示一个默认看不到的色。点色、工具名
    // 色与 diff 词级色才是默认就能看到的主题差异。
    <Box key="card" flexDirection="row">
      <Text color={ink(palette.toolDotWrite)}>{'● '}</Text>
      <Text color={ink(palette.toolNameMutate)}>{'Write'}</Text>
      <Text color={ink(palette.subtle)}>{'  src/theme.ts'}</Text>
    </Box>,
    ...SAMPLE_DIFF.map((row, index) => (
      <Box key={`diff-${index}`} flexDirection="row">
        <Text color={ink(row.tone === 'add' ? palette.diffAddedWord : palette.diffRemovedWord)}>
          {index === 0 ? GUTTER_FIRST : GUTTER_REST}
        </Text>
        <Text color={ink(row.tone === 'add' ? palette.diffAddedWord : palette.diffRemovedWord)}>
          {row.text}
        </Text>
      </Box>
    )),
  ]

  // 行预算是硬约束：浮层向上生长且探出帧顶的行会被裁掉，超出预算的块宁可
  // 不画，也不能把上方的主题列表顶出可视区。
  const shown = body.slice(0, Math.max(rows, 0))
  if (shown.length === 0) return null
  return <Box flexDirection="column">{shown}</Box>
}

/** 预览代码块示例：每行 ≤ 30 列（最窄的预览列 34 列，留 2 列缩进），同时覆盖
 *  注释/关键字/字符串/类型四类 token，语法色的差异一眼可见。 */
const SAMPLE_CODE = [
  '// dsh-tui palette',
  "const theme = pick('dark')",
  'type Swatch = { hex: string }',
].join('\n')

/** 代码操作工具卡的示例 diff：一行删除 + 两行新增，覆盖 diffRemoved/diffAdded
 *  的词级变体（真机转录里工具卡正文用的就是这两个键）。 */
const SAMPLE_DIFF: ReadonlyArray<{ tone: 'add' | 'del'; text: string }> = [
  { tone: 'del', text: "- accent: '#3b4252'" },
  { tone: 'add', text: "+ accent: '#7aa2f7'" },
  { tone: 'add', text: "+ text:   '#e5e9f0'" },
]

/** 代码块正文缩进：与 markdown.ts 的 fenced code 同一约定（2 空格）。 */
const CODE_INDENT = '  '

/** 工具卡正文左侧沟槽：首行 ⎿、其余行同宽空格（真机转录的 GUTTER_FIRST/REST）。 */
const GUTTER_FIRST = ' ⎿ '
const GUTTER_REST = '   '
