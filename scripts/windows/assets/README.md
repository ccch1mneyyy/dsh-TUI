# Installer brand assets

Both marks come from the project's own artwork:

- the welcome page replays the animated pixel whale of the README logo
  ([\`docs/assets/readme/logo.svg\`](../../../docs/assets/readme/logo.svg) and its English
  twin \`logo-en.svg\`), so the panel speaks the language the wizard is using;
- the window title icon is the DeepSeek Harness desktop whale
  (\`deepseek-harness/apps/desktop/resources/icon-windows.svg\`, vendored here as
  \`icon.svg\`).

The SVG sources are the maintainable input; the ICO/BMP binaries are committed so
neither CI nor a normal build needs an SVG rasterizer.

| Source | Output | Consumer |
| --- | --- | --- |
| \`icon.svg\` whale glyph | ICO sizes 16/24/32 | Bare whale, legible in the title bar |
| \`icon.svg\` badge | ICO sizes 48/64/128/256 | Rounded app badge for Explorer and the taskbar |
| \`header.svg\` | \`dsh-tui-header.bmp\` (150×57) | \`MUI_HEADERIMAGE_BITMAP\` on inner pages |
| README \`logo.svg\` frames 0–7 + star tiles | \`dsh-tui-welcome-zh-00…15.bmp\` (164×314) | \`MUI_WELCOMEFINISHPAGE_BITMAP\` and the timer, Simplified Chinese |
| README \`logo-en.svg\` frames 0–7 + star tiles | \`dsh-tui-welcome-en-00…15.bmp\` (164×314) | Same, English |

\`make-brand-assets.mjs\` samples each README logo's 5200 ms step-end timeline into
16 frames of 325 ms: the whale blinks, flutters a fin and wags its tail while the
GitHub star tile cycles through its four states (我想要 / 点亮星标 / 感谢 / 已加星标, or
I want / Star this repo / Thank you / Starred). Every frame must stay 164×314 or the
panel shifts when the timer swaps them.

\`.onInit\` picks the set from \`$LANGUAGE\` and extracts only that one. The timer swaps
frames with \`LoadAndSetImage /RESIZETOFIT\` in \`WelcomeWhaleTick\`. That built-in
**deletes the bitmap it replaces** (see \`EW_LOADANDSETIMAGE\` in NSIS's
\`Source/exehead/exec.c\`), so the handle it returns is the only live one: never
restore \`$mui.WelcomePage.Image.Bitmap\` after the first swap — MUI loaded that
handle itself, and \`WelcomePageShow\` clears the variable so MUI's own
\`NSD_FreeImage\` cannot free a stale handle. \`WelcomePageShow\` runs before the page
is shown, which is why the first frame is loaded there instead of being left to MUI.

\`dsh-tui.ico\` carries uncompressed 32-bit BMP entries only (no PNG entries) so every
NSIS version can embed it — the desktop app's own \`tray-windows.ico\` stores PNG
entries and cannot be used directly. Regenerate after editing the SVGs:

\`\`\`sh
npm install --no-save sharp
node scripts/windows/make-brand-assets.mjs
\`\`\`

\`scripts/windows/installer.test.mjs\` validates the ICO directory, the BMP headers,
that the frames really differ (including between languages), and that
\`installer.nsi\` references every binary.
