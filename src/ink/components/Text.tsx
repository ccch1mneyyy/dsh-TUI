import type { ReactNode, Ref } from 'react';
import React from 'react';
import type { Color, Styles, TextStyles } from '../styles.js';
import type { DOMElement } from '../dom.js';
type BaseProps = {
  /**
   * Change text color. Accepts a raw color value (rgb, hex, ansi).
   */
  readonly color?: Color;
  /**
   * Ref to the underlying ink-text DOMElement. dsh-tui addition: lets
   * useDeclaredCursor park the native cursor on an inline caret cell without
   * wrapping it in a Box (a wrapper Box changes flex shrink behaviour and
   * breaks wrapped-line layouts).
   */
  readonly ref?: Ref<DOMElement>;

  /**
   * Same as `color`, but for background.
   */
  readonly backgroundColor?: Color;

  /**
   * Make the text italic.
   */
  readonly italic?: boolean;

  /**
   * Make the text underlined.
   */
  readonly underline?: boolean;

  /**
   * Make the text crossed with a line.
   */
  readonly strikethrough?: boolean;

  /**
   * Inverse background and foreground colors.
   */
  readonly inverse?: boolean;

  /**
   * This property tells Ink to wrap or truncate text if its width is larger than container.
   * If `wrap` is passed (by default), Ink will wrap text and split it into multiple lines.
   * If `truncate-*` is passed, Ink will truncate text instead, which will result in one line of text with the rest cut off.
   */
  readonly wrap?: Styles['textWrap'];
  /**
   * Typed paint metadata (Styles.decoration): header row, per-row
   * prefix, and wrap-continuation hanging indent painted alongside this
   * leaf's own text. Producers must memo the object — style diffing
   * compares it by reference.
   */
  readonly decoration?: Styles['decoration'];
  readonly children?: ReactNode;
};

/**
 * Bold and dim are mutually exclusive in terminals.
 * This type ensures you can use one or the other, but not both.
 */
type WeightProps = {
  bold?: never;
  dim?: never;
} | {
  bold: boolean;
  dim?: never;
} | {
  dim: boolean;
  bold?: never;
};
export type Props = BaseProps & WeightProps;
const wrapStyles = new Map<NonNullable<Styles['textWrap']>, Styles>()

/** A text leaf. Empty children produce no layout node. */
function Text({ children, ref, wrap = 'wrap', color, backgroundColor,
  bold, dim, italic, underline, strikethrough, inverse, decoration,
}: Props) {
  const textStyles = React.useMemo<TextStyles>(() => {
    const values = { color, backgroundColor, bold, dim, italic, underline, strikethrough, inverse }
    return Object.fromEntries(Object.entries(values).filter(([, value]) => Boolean(value)))
  }, [color, backgroundColor, bold, dim, italic, underline, strikethrough, inverse])
  if (children == null) return null
  if (decoration === undefined) {
    let style = wrapStyles.get(wrap)
    if (!style) {
      style = { flexDirection: 'row', flexGrow: 0, flexShrink: 1, textWrap: wrap }
      wrapStyles.set(wrap, style)
    }
    return <ink-text ref={ref} style={style} textStyles={textStyles}>{children}</ink-text>
  }
  // A decorated leaf cannot share the wrapStyles cache object; its own
  // style is shallow-compared by the reconciler, so a stable decoration
  // reference keeps re-renders clean.
  const decoratedStyle = React.useMemo<Styles>(() => ({
    flexDirection: 'row', flexGrow: 0, flexShrink: 1, textWrap: wrap, decoration,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- wrap is captured on purpose: a wrap change must rebuild the style
  }), [wrap, decoration])
  return <ink-text ref={ref} style={decoratedStyle} textStyles={textStyles}>{children}</ink-text>
}

export default React.memo(Text)
