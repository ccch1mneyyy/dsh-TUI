/**
 * Backend discovery and the standalone host's final composition mode. Drives
 * the real HostRoot, Cordis Loader, assembly and profile include; the installed
 * host boundary supplies a temporary profile and records DSH-only preparation.
 * No TTY, credentials, backend session or external process is needed.
 *
 * Run: node --import tsx/esm scripts/verify-backend-host.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as appBoot from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { assembleBackendsFromProfile } from '../src/dsh-adapter/backend-assembly.js'
import { prepareHostRoot, type HostDsh } from '../src/dsh-adapter/host-dsh.js'
import { configuredBackend, entryKernel } from '../src/hostEntryRoute.js'
import { createEntrySlot } from '../src/dsh-adapter/entry-slot.js'

const dir = mkdtempSync(join(tmpdir(), 'verify-backend-host-'))
let passed = 0
const check = (label: string, ok: boolean): void => {
  assert.ok(ok, label)
  passed += 1
  console.log(`PASS ${label}`)
}

const originalUserAgentSuffix = process.env.DSH_USER_AGENT_SUFFIX
for (const source of ['env', 'memory', 'config', 'dsh', 'dsh-rc2', 'proxy-failure', 'cmdline-failure'] as const) {
  const failing = source === 'proxy-failure' || source === 'cmdline-failure'
  const expectedDsh = source === 'dsh' || source === 'dsh-rc2' || failing
  process.env.DSH_USER_AGENT_SUFFIX = 'existing-suffix'
  const profileName = 'verify / 中文 (%)'
  const encodedProfile = 'host-encoded-profile'
  const home = join(dir, source)
  const profileDir = join(home, 'profile')
  const bundle = `@dsh-tui-verify/host-${source}`
  const id = `host-${source}-agent`
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', bundle]
  const packageDir = join(profileDir, 'node_modules', ...bundle.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: bundle, version: '0.1.0', type: 'module', exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(packageDir, 'index.js'), 'export const backend = {}\n')
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(packageDir, 'dsh-plugin.json'), JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    manifestVersion: '0.15', id: `com.example.host-${source}`, name: 'Host backend', version: '0.1.0',
    facets: { host: { entry: 'index.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [] }, permissions: [], subscriptions: [],
    contributes: { commands: [], 'x-dsh-tui': [{
      apiVersion: 'tui.dsh/v1alpha1', kind: 'Backend', id: `com.example.host-${source}.backend`, name: 'host_backend',
      spec: { id, label: { text: 'Host backend' }, shortLabel: 'Host', capabilities: [], grants: [] },
    }] },
  }))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `verify-host-${source}`, private: true, dsh: { profile: { bundles } },
  }))
  const memory = join(home, 'kernel.json')
  if (source === 'memory') writeFileSync(memory, JSON.stringify({ backend: id }))
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const userPatches = source === 'config' ? [{ id: 'dsh-tui', config: { backend: id } }] : []
  writeFileSync(patchPath, JSON.stringify(userPatches))

  // The front-door row stands in for a second runtime. A light composition must
  // not activate it, while ordinary third-party rows still have to activate.
  const frontDoor = join(home, 'front-door.txt')
  const plugin = join(home, 'plugin.txt')
  for (const [name, marker] of [['front-door', frontDoor], ['plugin', plugin]] as const) {
    writeFileSync(join(home, `${name}.js`), `import { writeFileSync } from 'node:fs'\nexport default function () { writeFileSync(${JSON.stringify(marker)}, 'activated') }\n`)
  }
  writeFileSync(join(home, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(profileDir, 'cordis.yml'), JSON.stringify([
    { id: 'dsh-tui', name: pathToFileURL(join(home, 'front-door.js')).href },
    { id: 'third-party-row', name: pathToFileURL(join(home, 'plugin.js')).href },
  ]))
  const profile = {
    name: 'verify', dir: profileDir, patchPath, patches: userPatches, skippedBundles: [],
    layers: bundles.map(packageName => ({ packageName, packageDir: profileDir, patchPaths: [], patches: [] })),
  }
  const preparedLayers: string[][] = []
  let proxyInstalled = 0
  let proxyClosed = 0
  let failLoudInstalled = 0
  let failLoudRemoved = 0
  let cmdlineProvided = 0
  const host: HostDsh = {
    packageDir: home, version: '0.2.0-rc.2', Context, Loader,
    appBoot: {
      ...appBoot,
      loadLayeredEnv: () => ({ get: () => undefined, getFrom: () => undefined }),
      createRuntimeResolution: async () => ({
        profilesDir: home, profileDir, localPackageNames: [], entries: [], linkedRoots: [],
      }),
      installFailLoud: () => {
        failLoudInstalled += 1
        return () => { failLoudRemoved += 1 }
      },
      readProfilePatches: (_bin, _context, initialProfile) => {
        assert.ok(initialProfile !== undefined)
        preparedLayers.push(initialProfile.layers.map(layer => layer.packageName))
        return [...initialProfile.patches]
      },
    },
    homePaths: { dshHomePath: (...parts) => join(home, ...parts), resolveDshHome: () => home },
    launchEnvironmentKey: 'launchEnvironment',
    cmdline: { provideCmdline: (ctx, input) => {
      cmdlineProvided += 1
      if (source === 'cmdline-failure') throw new Error('cmdline-failure fixture failure')
      provideCmdline(ctx, input)
    } },
    profileBoot: {
      prepareProfile: () => profile, INSTALL_ANCHOR: home, PROFILE_ROOT_FILENAME: 'cordis.yml',
      ...(source === 'dsh' ? {} : { userAgentProfile: (name: string) => {
        assert.equal(name, profileName)
        return encodedProfile
      } }),
    },
    httpProxy: { installProxyFromEnvironment: async () => {
      assert.equal(process.env.DSH_USER_AGENT_SUFFIX,
        source === 'dsh' ? 'existing-suffix' : `dsh-profile/${encodedProfile}`)
      proxyInstalled += 1
      if (source === 'proxy-failure') throw new Error('proxy-failure fixture failure')
      return async () => { proxyClosed += 1 }
    } },
  }
  const env = source === 'env' ? { DSH_TUI_BACKEND: id } : {}
  const route = () => entryKernel(env, { configured: configuredBackend('verify', patchPath), memoryFile: memory })
  check(`${source}: before discovery the route only knows the built-in DSH fallback`, route() === 'dsh')
  const root = await prepareHostRoot(host, { profile: profileName, args: [] })
  root.ctx.logger.warn = () => undefined
  root.ctx.logger.info = () => undefined
  let rootDisposed = false
  root.ctx.effect(() => () => { rootDisposed = true })
  try {
    check(`${source}: preparation supplies a Loader without DSH-only services`,
      root.ctx.get('loader', false) !== undefined && root.ctx.get('profileContext', false) === undefined
      && proxyInstalled === 0 && failLoudInstalled === 0 && cmdlineProvided === 0)
    await assert.rejects(() => root.compose(() => undefined), /select the host kernel/)
    const assembled = assembleBackendsFromProfile(root.ctx)
    assert.deepEqual(assembled.registered, [id])
    const kernel = expectedDsh ? entryKernel({}, { memoryFile: join(home, 'absent.json') }) : route()
    const dsh = kernel === 'dsh'
    check(`${source}: discovery preserves the selected backend`, kernel === (expectedDsh ? 'dsh' : id))
    if (failing) {
      await assert.rejects(() => root.selectKernel(dsh), new RegExp(`${source} fixture failure`, 'u'))
      check(`${source}: failed preparation disposes the root and Loader`,
        rootDisposed && root.ctx.get('loader', false) === undefined)
      check(`${source}: an installed proxy is closed during failure cleanup`, proxyClosed === Number(source === 'cmdline-failure'))
      check(`${source}: an installed failure handler is removed during cleanup`, failLoudRemoved === Number(source === 'cmdline-failure'))
      continue
    }
    await root.selectKernel(dsh)
    check(`${source}: profile User-Agent follows the host export and selected kernel`,
      process.env.DSH_USER_AGENT_SUFFIX === (dsh && source !== 'dsh' ? `dsh-profile/${encodedProfile}` : 'existing-suffix'))
    const slot = createEntrySlot(dsh)
    check(`${source}: the slot and DSH-only preparation share the final mode`,
      slot.dsh === dsh && proxyInstalled === Number(dsh)
      && failLoudInstalled === Number(dsh) && cmdlineProvided === Number(dsh))
    await assert.rejects(() => root.selectKernel(!dsh), /already selected/)
    await root.compose(() => undefined)
    assert.deepEqual(preparedLayers, [dsh ? bundles : bundles.slice(1)])
    check(`${source}: only the DSH kernel activates the profile front door`, existsSync(frontDoor) === dsh)
    check(`${source}: third-party rows still activate on both composition modes`, readFileSync(plugin, 'utf8') === 'activated')
    check(`${source}: the runtime's second assembly registers no duplicate entry`,
      assembleBackendsFromProfile(root.ctx).registered.length === 0)
    root.uninstallFailLoud()
    check(`${source}: the selected DSH failure handler remains removable`, failLoudRemoved === Number(dsh))
  } finally {
    await root.ctx.fiber.dispose()
    if (originalUserAgentSuffix === undefined) delete process.env.DSH_USER_AGENT_SUFFIX
    else process.env.DSH_USER_AGENT_SUFFIX = originalUserAgentSuffix
  }
  check(`${source}: only a selected DSH proxy needs closing`, proxyClosed === Number(expectedDsh))
}

console.log(`verify-backend-host OK (${passed} checks)`)
