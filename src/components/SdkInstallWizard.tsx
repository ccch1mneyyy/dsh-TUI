import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { Pane } from './design-system/Pane.js'

/**
 * The SDK install wizard (the kernel picker's dim Claude row, Enter): one
 * pane, one step machine. The phase lives in Chat — it is async process
 * state, which stays out of the overlay union by design (chatOverlay.ts
 * note 3); this component renders it and never touches useInput, exactly
 * like the pickers. Keys (Chat): Enter confirms / returns, Esc backs out to
 * the kernel picker, `r` retries a failed install.
 */
export type SdkInstallPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirm'; readonly dir: string; readonly version: string; readonly specifier: string; readonly storeDir?: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly exitCode: number; readonly tail: readonly string[]; readonly dir: string; readonly version: string; readonly specifier: string; readonly storeDir?: string }
  | { readonly kind: 'store-mismatch'; readonly storeDir: string; readonly dir: string; readonly version: string; readonly specifier: string }
  | { readonly kind: 'pnpm-missing'; readonly dir: string; readonly version: string; readonly specifier: string; readonly storeDir?: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-target'; readonly reason: 'standalone' | 'no-profile' }

/** The pnpm output tail we show on failure — enough to identify the error,
 *  not enough to push the pane past OverlayAbove's height budget. */
const TAIL_LINES = 6

/** The command the user can run by hand. It carries `--store-dir` whenever the
 *  wizard knows the store, so the copy is the wizard's own command: dropping
 *  the flag would resolve a store by environment and can land on a different
 *  one, which is the ERR_PNPM_UNEXPECTED_STORE this pane is warning about. */
function manualLine(dir: string, specifier: string, storeDir?: string): string {
  const store = storeDir === undefined ? '' : ` --store-dir ${storeDir}`
  return `cd ${dir} && pnpm add ${specifier}${store}`
}

export function SdkInstallWizard({ phase }: { phase: SdkInstallPhase }): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('sdk-install-title')}
          </Text>
        </Box>
        {phase.kind === 'confirm' && (
          <Box flexDirection="column">
            <Text>{t('sdk-install-confirm-what', { version: phase.version })}</Text>
            <Text>{t('sdk-install-confirm-where', { dir: phase.dir })}</Text>
            <Box marginTop={1}>
              <Text dimColor>{t('sdk-install-confirm-note')}</Text>
            </Box>
          </Box>
        )}
        {(phase.kind === 'checking' || phase.kind === 'running') && (
          <Box flexDirection="column">
            <LoadingState
              message={phase.kind === 'checking' ? t('sdk-install-checking') : t('sdk-install-running')}
              subtitle={phase.kind === 'running' ? t('sdk-install-running-sub') : undefined}
            />
          </Box>
        )}
        {phase.kind === 'done' && <Text>{t('sdk-install-done')}</Text>}
        {phase.kind === 'failed' && (
          <Box flexDirection="column">
            <Text>{t('sdk-install-failed', { code: String(phase.exitCode) })}</Text>
            <Text dimColor>{t('sdk-install-manual', { command: manualLine(phase.dir, phase.specifier, phase.storeDir) })}</Text>
            {phase.tail.slice(-TAIL_LINES).map((line, index) => (
              <Text key={index} dimColor wrap="truncate-end">{line}</Text>
            ))}
          </Box>
        )}
        {phase.kind === 'store-mismatch' && (
          <Box flexDirection="column">
            <Text>{t('sdk-install-store-mismatch', { store: phase.storeDir })}</Text>
            <Text dimColor>{t('sdk-install-manual', { command: manualLine(phase.dir, phase.specifier, phase.storeDir) })}</Text>
          </Box>
        )}
        {phase.kind === 'pnpm-missing' && (
          <Box flexDirection="column">
            <Text>{t('sdk-install-pnpm-missing')}</Text>
            <Text dimColor>{t('sdk-install-manual', { command: manualLine(phase.dir, phase.specifier, phase.storeDir) })}</Text>
          </Box>
        )}
        {phase.kind === 'cancelled' && <Text>{t('sdk-install-cancelled')}</Text>}
        {phase.kind === 'no-target' && (
          <Text>{t(phase.reason === 'standalone' ? 'sdk-install-no-target-standalone' : 'sdk-install-no-target-no-profile')}</Text>
        )}
      </Box>
      <Text dimColor italic>
        <HintLine
          text={
            phase.kind === 'confirm' ? t('sdk-install-confirm-hint')
            : phase.kind === 'done' ? t('sdk-install-done-hint')
            : phase.kind === 'failed' || phase.kind === 'store-mismatch' ? t('sdk-install-failed-hint')
            : t('sdk-install-exit-hint')
          }
        />
      </Text>
    </Pane>
  )
}
