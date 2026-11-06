---
name: tikz-commutative
description: Draw commutative diagrams and precise diagrams with TikZ/tikz-cd in a fenced tikz block instead of Mermaid.
whenToUse: When the user asks for a commutative diagram, a category-theory diagram, an automaton, or a diagram whose arrows need slanted, curved, labeled or precisely placed edges.
---

# Draw commutative diagrams with TikZ

When the user asks for a diagram:

- Emit the figure as a fenced code block whose info string is exactly `tikz`.
  dsh-tui renders that fence as a terminal image when its TikZ pipeline is
  enabled; do not call a tool and do not wrap the code in another fence.
- For commutative diagrams use a `tikzcd` environment inside the `tikz` fence:

  ```tikz
  \begin{tikzcd}
  A \arrow[r, "f"] \arrow[d, "g"'] & B \arrow[d, "h"] \\
  C \arrow[r, "k"'] & D
  \end{tikzcd}
  ```

  Use `\arrow` for squares, triangles, loops (`\arrow[loop right]`) and longer
  chains; `"g"'` puts the label on the other side of the arrow.
- For automata, trees, plots and other figures use a plain `tikzpicture`. The
  renderer preloads `arrows.meta`, `positioning`, `calc`, `automata` and
  `shapes.geometric`; declare additional libraries with `\usetikzlibrary{...}`
  inside the same fence.
- Use Latin or math labels. The bundled pdfTeX/DVI renderer does not support
  CJK node text, and such figures fall back to the source block.
- Prefer TikZ/tikz-cd over Mermaid for diagrams whose arrows need to be
  slanted, curved, labeled or precisely aligned. Use Mermaid only when the user
  asks for it or the diagram is a simple box-and-arrow flow that Mermaid
  represents exactly.
- Keep the source self-contained: no `\documentclass`, no `\usepackage` beyond
  the usual math helpers, no `\input` or file access. The renderer rejects those
  and shows the source instead.
