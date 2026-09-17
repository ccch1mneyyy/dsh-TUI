# README SVG assets

The two root READMEs embed these self-contained SVG images. No JavaScript,
foreignObject, remote fonts, runtime server, model requests or telemetry is used.
The composer is explicitly presented as an animation, not a working input.

## Regenerate

With Node.js 24 (no additional dependencies are required):

```sh
node docs/assets/readme/generate.mjs
node docs/assets/readme/verify.mjs
```

The generator updates four responsive, bilingual automatic animated previews,
16 navigation tiles and the marked navigation blocks in both READMEs. It verifies
local link targets before writing the indexes. Do not edit generated SVG files by hand.

Each navigation tile has an internal SVG link for standalone SVG viewers.
GitHub's image embedding disables internal interaction, so the READMEs also wrap
each tile in a normal HTML anchor. The real clickable surface is that outer
anchor, not the SVG's internal link. Input elements are not supported in GitHub
README rendering; no hidden or nonfunctional input is inserted.

## Captured Runtime

`capture-runtime.cjs` runs the installed dsh-TUI 0.10.2 through node-pty/Windows
ConPTY and decodes its actual ANSI output with xterm-headless. DSH CLI and its
engine dependencies are pinned to 0.1.5-rc.1. HOME, USERPROFILE, DSH_HOME and session
storage are isolated. No production settings or credentials are copied.

The four files in `runtime/` preserve the original character cells, ANSI colors,
attributes, capture timestamps, package versions and source ANSI SHA-256 hashes.
Desktop capture uses 110 columns x 42 rows; narrow capture uses 58 x 36. The
sequence opens command completion and `/help`, returns to the welcome screen,
then types a greeting without submitting it. There are no model requests.

To recapture an already prepared isolated installation:

```powershell
$env:DSH_TUI_CAPTURE_ROOT = 'PATH_TO_ISOLATED_INSTALL'
node docs/assets/readme/capture-runtime.cjs zh desktop
node docs/assets/readme/capture-runtime.cjs zh mobile
node docs/assets/readme/capture-runtime.cjs en desktop
node docs/assets/readme/capture-runtime.cjs en mobile
node docs/assets/readme/generate.mjs
```

The root must contain `cli-rc1/node_modules`, the installed `dsh-home` profile
and an empty `workspace`. Capture dependencies belong to that isolated environment,
not the published TUI package. Raw ANSI and text evidence stay under its `captures/`.

The SVG retains terminal cell positions and colors. Consolas at 15px uses an
8.25px cell advance and 18px row height; font rasterization can differ between
viewers. It is a vector reconstruction, not a claim of identical screenshot pixels.
The real single-line status area remains below the composer.

Two requested editorial changes are applied without rewriting the raw capture:

- `welcome-copy.mjs` replaces only directory labels with welcome slogans,
  retaining the field's captured position and style.
- `whale-animation.mjs` replaces the desktop sprite region with all 22 credited
  source poses, at 22 fps / 1000ms per cycle. This accelerated gallery is not the
  runtime's original idle timing. Other screen states retain readable dwell times.

The narrow source keeps the runtime's text-only header; it does not add a whale
where the real application hides it. The README selects it at 640 CSS pixels.
Text sequences loop in approximately 13.4s (Chinese) and 15.3s (English), independently
of the one-second sprite cycle. All four SVGs are script-free and self-contained.

## Attribution

- All 22 pixel-art frames are reused without changing their pixels from
  `src/components/whaleFrames.ts`, originally by @lhh010 in dsh-ui-whale
  (BSD-3-Clause). Palette and header geometry match `src/components/Whale.tsx`.
  See the root README acknowledgements and `THIRD_PARTY_LICENSES` for the
  complete copyright, redistribution conditions and disclaimer.
- Icons are the 14 required icon definitions from Lucide 1.46.0, reused from the
  preceding web preview's installed package and preserved in `lucide-icons.json`.
  No runtime or development dependency is added. The SVG paths are emitted from
  that data without altering their geometry. The complete
  ISC license and the MIT notice for inherited Feather icons are retained in
  [LICENSE-lucide.txt](LICENSE-lucide.txt), copied from that package.
- `screenshots/qq-group.jpg` is the original community image supplied for this
  documentation update, kept at its original aspect ratio and resolution.
