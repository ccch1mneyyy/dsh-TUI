# README SVG assets

The two root READMEs embed these self-contained SVG images. No JavaScript,
foreignObject, remote fonts, runtime server, model requests or telemetry is used.
The composer is explicitly presented as an animation, not a working input.

## Regenerate

With Node.js 24 (no additional dependencies are required):

```sh
node docs/assets/readme/generate.mjs
```

The generator updates four responsive, bilingual automatic animated previews,
24 navigation tiles and the marked navigation blocks in both READMEs. It verifies
local link targets before writing the indexes. Do not edit generated SVG files by hand.

Each navigation tile has an internal SVG link for standalone SVG viewers.
GitHub's image embedding disables internal interaction, so the READMEs also wrap
each tile in a normal HTML anchor. The real clickable surface is that outer
anchor, not the SVG's internal link. Input elements are not supported in GitHub
README rendering; no hidden or nonfunctional input is inserted.

The preview loops every 16 seconds. The README's `picture` selects the narrow
animated composition at 640 CSS pixels; both sources remain animated. Its layout
mirrors the production component tree: `LogoV2`, transcript rows, thinking preview,
tool card, pinned composer and the two-line status area. The narrow source follows
the runtime breakpoint and hides the whale while retaining the wordmark. An earlier
version used a four-phase product-demo rail; the current assets instead reconstruct
a running session from the actual screen hierarchy.

## Attribution

- Pixel art is generated from the existing `src/components/whaleFrames.ts`
  standard frame, originally by @lhh010 in dsh-ui-whale (BSD-3-Clause).
  The sprite remains still once the example conversation begins, matching the
  product's post-task behavior. See the repository's existing acknowledgements
  and `THIRD_PARTY_LICENSES`.
- Icons are the 14 required icon definitions from Lucide 1.46.0, reused from the
  preceding web preview's installed package and preserved in `lucide-icons.json`.
  No runtime or development dependency is added. The SVG paths are emitted from
  that data without altering their geometry. The complete
  ISC license and the MIT notice for inherited Feather icons are retained in
  [LICENSE-lucide.txt](LICENSE-lucide.txt), copied from that package.
- `screenshots/qq-group.jpg` is the original community image supplied for this
  documentation update, kept at its original aspect ratio and resolution.
