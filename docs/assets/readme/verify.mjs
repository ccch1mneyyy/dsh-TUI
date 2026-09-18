// Dependency-free checks for the committed capture and generated assets.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderRuntime } from './runtime-svg.mjs'
import { withWelcomeCopy } from './welcome-copy.mjs'
import { WHALE_FRAMES } from '../../../src/components/whaleFrames.ts'

assert.equal(WHALE_FRAMES.length, 22)
for (const language of ['zh', 'en']) {
  const readmeName = language === 'zh' ? 'README.md' : 'README_EN.md'
  const readme = await readFile(new URL(`../../../${readmeName}`, import.meta.url), 'utf8')
  const navigation = readme.split('<!-- readme-svg-navigation:start -->')[1]?.split('<!-- readme-svg-navigation:end -->')[0]
  assert.ok(navigation, 'Navigation markers must exist')
  assert.deepEqual([...navigation.matchAll(/nav-(.*?)-(?:zh|en)\.svg/g)].map(match => match[1]),
    ['start', 'configuration', 'interaction', 'themes', 'architecture', 'vscode', 'plugins', 'contributing'])
  const previewHeading = language === 'zh' ? '## 界面预览' : '## Preview'
  const navigationHeading = language === 'zh' ? '## 文档索引' : '## Documentation'
  assert.match(readme.slice(readme.indexOf(previewHeading), readme.indexOf(navigationHeading)), /<\/picture>\s*$/)
  const securityTarget = language === 'zh' ? 'docs/architecture.md#权限与安全边界' : 'docs/architecture.en.md#permissions-and-security-boundary'
  assert.ok(readme.includes(`<a href="${securityTarget}"><img src="docs/assets/readme/security-link-${language}.svg"`))
  const button = await readFile(new URL(`security-link-${language}.svg`, import.meta.url), 'utf8')
  assert.ok(button.includes('viewBox="0 0 288 44"'))
  assert.ok(button.includes(securityTarget))
  assert.ok(!/<(?:script|foreignObject|image|iframe)\b/.test(button))
  const logo = await readFile(new URL(language === 'zh' ? 'logo.svg' : 'logo-en.svg', import.meta.url), 'utf8')
  assert.equal((logo.match(/data-whale-frame="/g) || []).length, 8)
  assert.ok(logo.includes(language === 'zh' ? '我想要' : 'I desire'))
  assert.ok(logo.includes(language === 'zh' ? '星标' : 'Star'))
  assert.ok(logo.includes(language === 'zh' ? '已加星标' : 'Starred'))
  assert.ok(logo.includes('≧∀≦'))
  assert.ok(logo.includes('5200ms'))
  assert.ok(logo.includes('logo-particles'))
  assert.ok(logo.includes('data-pose="standard"'))
  assert.ok(!logo.includes('data-pose="sleep1"') && !logo.includes('data-pose="heart1"'))
  assert.ok(!logo.includes('data-pose="spout1"'))
  for (const variant of ['desktop', 'mobile']) {
    const capture = JSON.parse(await readFile(new URL(`runtime/${language}-${variant}.json`, import.meta.url), 'utf8'))
    const original = JSON.stringify(capture)
    assert.equal(capture.versions.tui, '0.10.2')
    assert.equal(capture.versions.dsh, '0.1.5-rc.1')
    assert.match(capture.ansiSha256, /^[a-f0-9]{64}$/)
    for (const frame of capture.frames) {
      assert.ok(frame.duration > 0)
      const positions = new Set()
      for (const [x, y, , width] of frame.cells) {
        assert.ok(x >= 0 && x + width <= capture.cols && y >= 0 && y < capture.rows)
        assert.ok(!positions.has(`${x},${y}`))
        positions.add(`${x},${y}`)
      }
    }
    const presentation = withWelcomeCopy(capture)
    assert.equal(JSON.stringify(capture), original, 'Presentation must not mutate evidence')
    assert.ok(presentation.editorialLabels.length > 0)
    const output = renderRuntime(presentation)
    const filename = `preview-${language}${variant === 'mobile' ? '-mobile' : ''}.svg`
    assert.equal(await readFile(new URL(filename, import.meta.url), 'utf8'), output)
    assert.ok(!output.includes('H:\\CODEX\\'))
    assert.ok(!/<(?:script|foreignObject|image|iframe)\b/.test(output))
    assert.equal((output.match(/data-whale-frame="/g) || []).length, variant === 'desktop' ? 22 : 0)
    if (variant === 'desktop') {
      assert.equal((output.match(/animation:whale\d+ 1000ms/g) || []).length, 22)
      for (const pose of WHALE_FRAMES) assert.ok(output.includes(`data-pose="${pose.name}"`))
    }
    console.log(`PASS ${filename}: immutable capture, reproducible output, bounded cells and sprite timing`)
  }
}
