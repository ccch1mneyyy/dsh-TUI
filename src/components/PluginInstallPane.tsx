import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { cleanRenderText, NOTICE_CELLS } from '../channel/sanitize.js'
import type { PluginInstallStep, VersionExemptions } from '../dsh-adapter/plugin-install.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { Pane } from './design-system/Pane.js'
import { PluginGrantList, usePaneTextRows } from './PluginGrantList.js'

/** One package the running host refuses: the shape the step carries, named
 *  through the step so this file needs no upstream types of its own. */
type IncompatibleRow = Extract<PluginInstallStep, { kind: 'incompatible' }>['packages'][number]

/** Foreign text on its way to the screen: control sequences stripped, bounded. */
const clean = (value: string): string => cleanRenderText(value, NOTICE_CELLS)

/**
 * The target's identity is the subject of the confirmation, and it is foreign
 * text like everything else here: the name comes from the package's own
 * manifest, so it can carry newlines or thousands of cells. Bounded to what a
 * line can show — at 50 columns an unbounded name buries the title and the key
 * hints, which are exactly what the person needs to answer the question.
 */
const TARGET_CELLS = 80

/**
 * `/plugin install <spec>`: the pane that asks what the flow cannot answer on
 * its own (Stage C-4).
 *
 * The flow (`dsh-adapter/plugin-install.ts`) writes every line of the install
 * into the transcript as it happens — the inspection, pnpm's phases, the result
 * — so this pane only carries the two things a person must decide before that:
 * gate 1's pre-install notice and gate 3's trust confirmation. It also renders
 * the two "decide and retry" steps (unapproved build scripts, an incompatible
 * version), which are the same kind of question.
 *
 * Presentational only: the step state lives in Chat, keys are handled there
 * (Enter confirms / retries, Esc cancels), exactly like the SDK install wizard.
 */
export function PluginInstallPane({ step, busy }: { step: PluginInstallStep; busy: boolean }): React.ReactNode {
  const textRows = usePaneTextRows()
  if (busy) {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text color="remember" bold>{t('plugins-install-pane-title')}</Text>
          <Box marginTop={1}>
            <LoadingState message={t('plugins-install-installing')} />
          </Box>
        </Box>
        <Text dimColor italic><HintLine text={t('plugins-install-key-cancel')} /></Text>
      </Pane>
    )
  }
  if (step.kind === 'confirm') {
    const { artifact, trust, notice, grants } = step
    const spec = artifact.name === undefined
      ? t('plugins-install-unidentified')
      : cleanRenderText(
        `${artifact.name}${artifact.version === undefined ? '' : `@${artifact.version}`}`,
        TARGET_CELLS,
      )
    const title = t('plugins-install-pane-title')
    const configure = t('plugins-install-configure', {
      spec,
      kind: artifact.kind,
      bundle: artifact.bundle === true ? 'bundle' : artifact.bundle === false ? 'not a bundle' : 'unknown',
    })
    const trustText = trust.kind === 'third-party' ? t('plugins-install-trust-third-party') : undefined
    const noticeText = notice.kind === 'declared' ? t('plugins-install-notice-declared')
      : notice.kind === 'undeclared' ? t('plugins-install-notice-undeclared')
        : notice.kind === 'invalid' ? t('plugins-install-notice-invalid', { err: notice.error })
          : notice.kind === 'unjudged' ? t('plugins-install-notice-unjudged')
            : undefined
    const grantCount = grants?.entries.length ?? 0
    const hint = grantCount > 0
      ? t('plugins-install-key-confirm-grant', { count: String(grantCount) })
      : t('plugins-install-key-confirm')
    // Everything the overlay draws besides the permission rows: Pane's top line
    // and padding, the title and its gap, the configure line, the facts gap, the
    // trust/notice copy and the hint. Measured at this width, so the list folds
    // itself instead of pushing them off a short terminal.
    const frameRows = 2 + textRows(title) + 1 + textRows(configure) + 1
      + (trustText === undefined ? 0 : textRows(trustText))
      + (noticeText === undefined ? 0 : textRows(noticeText)) + textRows(hint)
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>{title}</Text>
          </Box>
          <Text>{configure}</Text>
          <Box marginTop={1} flexDirection="column">
            {trustText !== undefined && <Text>{trustText}</Text>}
            {noticeText !== undefined && <Text dimColor={notice.kind === 'declared'}>{noticeText}</Text>}
          </Box>
          {grants !== undefined && <PluginGrantList plan={grants} mode="grant" frameRows={frameRows} />}
        </Box>
        <Text dimColor italic><HintLine text={hint} /></Text>
      </Pane>
    )
  }
  if (step.kind === 'grant') {
    const title = t('plugins-install-pane-title')
    const ask = t('plugins-install-grant-ask', { id: clean(step.plan.id) })
    const hint = t('plugins-install-key-grant', { count: String(step.plan.entries.length) })
    // Pane frame, title and its gap, the question, the hint.
    const frameRows = 2 + textRows(title) + 1 + textRows(ask) + textRows(hint)
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>{title}</Text>
          </Box>
          <Text>{ask}</Text>
          <PluginGrantList plan={step.plan} mode="grant" frameRows={frameRows} />
        </Box>
        <Text dimColor italic><HintLine text={hint} /></Text>
      </Pane>
    )
  }
  if (step.kind === 'build-blocked') {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text color="remember" bold>{t('plugins-install-pane-title')}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{t('plugins-install-builds-title')}</Text>
            {step.builds.map(build => <Text key={build} dimColor>{`  ${clean(build)}`}</Text>)}
          </Box>
        </Box>
        <Text dimColor italic><HintLine text={t('plugins-install-key-builds')} /></Text>
      </Pane>
    )
  }
  if (step.kind === 'incompatible') {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text color="remember" bold>{t('plugins-install-pane-title')}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{t('plugins-install-incompatible-title')}</Text>
            {step.packages.map(entry => <Text key={`${entry.name}@${entry.version}`} dimColor>{describe(entry)}</Text>)}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>{t('plugins-install-exemptions-title')}</Text>
            {exemptionLines(step.exemptions).map((line, index) => <Text key={index} dimColor>{line}</Text>)}
          </Box>
        </Box>
        <Text dimColor italic><HintLine text={t('plugins-install-key-incompatible')} /></Text>
      </Pane>
    )
  }
  // `done` never renders: its lines are already in the transcript, so Chat
  // closes the pane instead of leaving an empty box behind.
  return null
}

/**
 * One package the running host refuses, with the peers it fails.
 *
 * Every field here is foreign text — a package name, a version, a peer range
 * the author wrote — and the pane is a render path like any other, so each one
 * goes through the same sanitizer the rest of the interface uses before it can
 * reach the screen.
 */
function describe(entry: IncompatibleRow): string {
  const peers = Object.entries(entry.peers)
    .map(([name, range]) => `${clean(name)} ${clean(range)}`)
    .join(', ')
  return `  ${clean(entry.name)}@${clean(entry.version)} (running ${clean(entry.runtimeVersion)}${peers === '' ? '' : `; needs ${peers}`})`
}

/**
 * The profile's compatibility file as rows. The file maps `package@version` to
 * the runtime versions exempted for it, and a corrupt one answers warnings
 * instead — both shapes are the person's business here, because this is the
 * step where they decide whether to add another. The file is user-editable and
 * carries whatever somebody typed, so its rows are sanitized too.
 */
function exemptionLines(exemptions: VersionExemptions): string[] {
  const rows = Object.entries(exemptions.exemptions)
    .map(([packageVersion, runtimes]) => `  ${clean(packageVersion)} → ${runtimes.map(runtime => clean(runtime)).join(', ')}`)
  if (rows.length === 0 && exemptions.warnings.length === 0) return [`  ${t('plugins-info-registries-none')}`]
  return [...rows, ...exemptions.warnings.map(warning => `  ${clean(warning)}`)]
}
