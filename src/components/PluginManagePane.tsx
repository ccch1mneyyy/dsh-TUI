import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { cleanRenderText, NOTICE_CELLS } from '../channel/sanitize.js'
import type { PluginManageStep, PluginManageTarget } from '../dsh-adapter/plugin-manage.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { Pane } from './design-system/Pane.js'
import { PluginGrantList, usePaneTextRows } from './PluginGrantList.js'

/** Foreign text on its way to the screen: control sequences stripped, bounded. */
const clean = (value: string): string => cleanRenderText(value, NOTICE_CELLS)

/**
 * The target's identity is the subject of the question, and it is foreign text
 * like everything else here: a package name and a module specifier come from
 * somebody else's manifest, so either can carry newlines or thousands of cells.
 * Bounded to what a line can show — at 50 columns an unbounded name buries the
 * title and the key hints, which are exactly what the person needs to answer.
 */
const TARGET_CELLS = 80

/**
 * `/plugin remove | enable | disable`: the pane that asks what the flow cannot
 * answer on its own (Stage C-5).
 *
 * The flow (`dsh-adapter/plugin-manage.ts`) writes every line of the action into
 * the transcript — what it resolved, why it refused, what the service answered —
 * so this pane only carries the one thing a person must decide before the write.
 * Unlike the install pane there is no progress, no cancellation and no retry:
 * each action is a single call that settles once.
 *
 * Presentational only, and the same three parts as its install sibling
 * (`PluginInstallPane`): the pane, the facts that make the question answerable,
 * and the key hints. Keys are handled in Chat (Enter answers, Esc closes).
 */
export function PluginManagePane({ step, busy }: { step: PluginManageStep; busy: boolean }): React.ReactNode {
  const textRows = usePaneTextRows()
  if (busy) {
    // A write is in flight. Esc closes the pane and the write finishes anyway —
    // the service has no cancellation for these three, and saying "cancelling"
    // here would be a promise nobody can keep.
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text color="remember" bold>{t('plugins-manage-pane-title')}</Text>
          <Box marginTop={1}>
            <LoadingState message={t('plugins-manage-working')} />
          </Box>
        </Box>
        <Text dimColor italic><HintLine text={t('plugins-manage-key-busy')} /></Text>
      </Pane>
    )
  }
  if (step.kind === 'confirm') {
    const title = t('plugins-manage-pane-title')
    const configure = t('plugins-manage-configure', {
      action: t(actionKeyOf(step.target)),
      target: describe(step.target),
    })
    const facts: string[] = []
    if (step.question.kind === 'remove') {
      facts.push(t('plugins-manage-remove-facts', {
        rows: String(step.target.kind === 'bundle' ? step.target.rows : 0),
        overrides: String(step.target.kind === 'bundle' ? step.target.overrides : 0),
      }))
    } else if (step.question.kind === 'trust') {
      facts.push(t('plugins-manage-trust-facts'))
    } else if (step.question.kind === 'host-row') {
      facts.push(t('plugins-manage-host-row-facts'))
    } else if (step.question.kind === 'team-active') {
      if (step.question.members > 0) {
        facts.push(t('plugins-manage-team-active-facts', { members: String(step.question.members) }))
      }
      if (step.question.unseen > 0) {
        facts.push(t('plugins-manage-team-unseen-facts', { members: String(step.question.unseen) }))
      }
      facts.push(t('plugins-manage-team-active-stop'))
    }
    const grantFacts = step.target.action === 'remove' && step.grants !== undefined
      ? t('plugins-manage-remove-grant-facts')
      : undefined
    const hint = hintTextOf(step)
    // Everything the overlay draws besides the permission rows: Pane's top line
    // and padding, the title and its gap, the configure line, the facts gap, the
    // facts themselves, the removal note and the hint. Measured at this width,
    // so the list folds instead of pushing them off a short terminal.
    const frameRows = 2 + textRows(title) + 1 + textRows(configure) + 1
      + facts.reduce((rows, fact) => rows + textRows(fact), 0)
      + (grantFacts === undefined ? 0 : 1 + textRows(grantFacts))
      + textRows(hint)
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>{title}</Text>
          </Box>
          <Text>{configure}</Text>
          <Box marginTop={1} flexDirection="column">
            {facts.map((fact, index) => <Text key={index}>{fact}</Text>)}
          </Box>
          {step.target.kind === 'bundle' && step.target.action === 'enable'
            && step.grants !== undefined
            && <PluginGrantList plan={step.grants} mode="grant" frameRows={frameRows} />}
          {step.target.kind === 'bundle' && step.target.action === 'disable'
            && step.grants !== undefined
            && <PluginGrantList plan={step.grants} mode="revoke" frameRows={frameRows} />}
          {grantFacts !== undefined
            && <Box marginTop={1}><Text>{grantFacts}</Text></Box>}
        </Box>
        <Text dimColor italic><HintLine text={hint} /></Text>
      </Pane>
    )
  }
  // `done` never renders: its lines are already in the transcript, so Chat
  // closes the pane instead of leaving an empty box behind.
  return null
}

/**
 * The key hint for this question. Enabling grants the declared permissions and
 * disabling revokes them, so the hint names both halves of the action when
 * there is something to grant or revoke; a removal keeps the plain hint (its
 * grant fact is a line of its own).
 */
function hintTextOf(step: Extract<PluginManageStep, { kind: 'confirm' }>): string {
  const grants = step.grants
  if (step.target.kind === 'bundle' && grants !== undefined && grants.entries.length > 0) {
    if (step.target.action === 'enable') return t('plugins-manage-key-enable-grant', { count: String(grants.entries.length) })
    if (step.target.action === 'disable') {
      return t('plugins-manage-key-disable-revoke', { count: String(grants.entries.length) })
    }
  }
  return t('plugins-manage-key-confirm')
}

/** Which verb the title asks about. */
function actionKeyOf(target: PluginManageTarget): 'plugins-manage-action-remove' | 'plugins-manage-action-enable' | 'plugins-manage-action-disable' {
  return target.action === 'remove'
    ? 'plugins-manage-action-remove'
    : target.action === 'enable' ? 'plugins-manage-action-enable' : 'plugins-manage-action-disable'
}

/**
 * The target as one bounded cell. A bundle is named by its package name; a row
 * by the module it loads, which is what the report listed it as and what a
 * person typed to get here.
 */
function describe(target: PluginManageTarget): string {
  if (target.kind === 'bundle') {
    const version = target.version === undefined ? '' : `@${target.version}`
    return cleanRenderText(`${target.name}${version}`, TARGET_CELLS)
  }
  return cleanRenderText(target.moduleName, TARGET_CELLS)
}
