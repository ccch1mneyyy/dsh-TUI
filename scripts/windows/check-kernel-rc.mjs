#!/usr/bin/env node
/**
 * Detect whether upstream publishes a compatible DSH RC that this checkout does
 * not yet bundle. The build always resolves the newest compatible RC at build
 * time; this probe is the scheduled early warning when the contract drifts.
 *
 *   node scripts/windows/check-kernel-rc.mjs [--json]
 *
 * Exit 0 when the contract primary is the newest compatible RC, 1 when a newer
 * compatible RC is available (rebuild to adopt it), a newer RC exists outside
 * the validated range (bump src/dsh-adapter/contract.ts first), or the contract
 * primary is no longer published at all.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { extractContract, selectKernelVersion, compatibleKernelVersions, newerKernelVersions, DSH_PACKAGE } from './policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const metadata = extractContract(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), readFileSync(join(root, 'src/dsh-adapter/contract.ts'), 'utf8'))
const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const view = ['view', DSH_PACKAGE, 'versions', '--json']
const versions = JSON.parse(existsSync(npmCli)
  ? execFileSync(process.execPath, [npmCli, ...view], { encoding: 'utf8' })
  : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', view, { encoding: 'utf8' }))
const newestCompatible = selectKernelVersion(versions, metadata)
const newerValidated = compatibleKernelVersions(versions, metadata).filter(value => semver.gt(value, metadata.kernelVersion))
const aheadOfContract = newerKernelVersions(versions, metadata)
const report = {
  tuiVersion: metadata.tuiVersion,
  contractPrimary: metadata.kernelVersion,
  validatedRange: `${metadata.kernelMinimum}..${metadata.kernelMaximum}`,
  newestCompatible,
  newerValidated,
  newerUnvalidated: aheadOfContract,
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`TUI ${report.tuiVersion}; contract primary ${report.contractPrimary}; range ${report.validatedRange}`)
  console.log(`Newest compatible published RC: ${report.newestCompatible}`)
  if (report.newerValidated.length) console.log(`Newer compatible RC(s) than the contract primary: ${report.newerValidated.join(', ')}`)
  if (report.newerUnvalidated.length) console.log(`Newer RC(s) outside the validated range: ${report.newerUnvalidated.join(', ')}`)
}
if (newerValidated.length || aheadOfContract.length) {
  console.error('Kernel contract drift detected; see README_ZH.md / README.md for the rebuild or contract-bump path.')
  process.exit(1)
}
// No newer RC exists, so a differing primary means it is no longer published and
// a build would silently bundle an older kernel than the contract declares.
if (newestCompatible !== metadata.kernelVersion) {
  console.error(`Contract primary ${metadata.kernelVersion} is not the newest compatible published RC (${newestCompatible}); update src/dsh-adapter/contract.ts.`)
  process.exit(1)
}
// Only the no-drift path reaches this line, and --json callers parse stdout.
if (!process.argv.includes('--json')) console.log('Contract primary is the newest compatible RC.')
