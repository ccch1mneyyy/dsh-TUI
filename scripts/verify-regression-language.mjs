#!/usr/bin/env node
/**
 * #1030: copy-sensitive regressions must run independently of the host's
 * locale, saved /lang choice, and DSH_TUI_LANG (including CI's zh default).
 * Run after build: node scripts/verify-regression-language.mjs
 * Each child runs the real assertions with a fresh, disposable HOME and
 * host settings opposing its expected language. Keep script paths literal:
 * verify-fixed-window scans this list as well as run-ci-group's registry.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const scripts = [
  { lang: 'zh', args: ['--import', 'tsx/esm', 'scripts/repro-askpanel.tsx'] },
  { lang: 'zh', args: ['--import', 'tsx/esm', 'scripts/verify-askpanel-layout.tsx'] },
  { lang: 'zh', args: ['--import', 'tsx/esm', 'scripts/verify-askpanel-hide-custom-input.tsx'] },
  { lang: 'zh', args: ['--import', 'tsx/esm', 'scripts/verify-compact-switch.tsx'] },
  { lang: 'zh', args: ['scripts/verify-compact.mjs'] },
  { lang: 'zh', args: ['--import', 'tsx/esm', 'scripts/verify-question-paste.tsx'] },
  { lang: 'en', args: ['--import', 'tsx/esm', 'scripts/repro-external-editor.tsx'] },
]

let checks = 0
let failures = 0
for (const { lang, args } of scripts) {
  const opposite = lang === 'zh' ? 'en' : 'zh'
  const cases = [
    { name: 'locale', locale: opposite },
    { name: 'saved preference', locale: lang, saved: opposite },
    { name: 'environment override', locale: lang, saved: lang, envLang: opposite },
  ]
  for (const testCase of cases) {
    checks++
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-lang-test-'))
    try {
      if (testCase.saved) {
        const dir = join(home, '.dsh-tui')
        mkdirSync(dir)
        writeFileSync(join(dir, 'lang.json'), JSON.stringify({ lang: testCase.saved }))
      }
      const locale = testCase.locale === 'zh' ? 'zh_CN.UTF-8' : 'en_US.UTF-8'
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LANG: locale,
        LC_ALL: locale,
        LC_MESSAGES: locale,
      }
      delete env.DSH_TUI_LANG
      if (testCase.envLang) env.DSH_TUI_LANG = testCase.envLang
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const ok = result.status === 0 && !result.error
      console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name} → ${lang}: ${args.at(-1)}`)
      if (!ok) {
        failures++
        console.error(result.error ?? `exit=${result.status}, signal=${result.signal}`)
        process.stderr.write(result.stdout ?? '')
        process.stderr.write(result.stderr ?? '')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}
console.log(`${checks - failures}/${checks} language-isolation checks passed`)
process.exitCode = failures === 0 ? 0 : 1
