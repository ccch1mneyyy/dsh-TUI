/** Native ESM entry: Git consumers do not compile TypeScript or vendor submodules. */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { managementModules, prepareRuntime } from './prepare.mjs'
import { compareVersions, PACKAGE, packageDirectory, PROFILE, readJson, RESCUE_PROFILE, runtimeStatus } from './runtime-profile.mjs'

export const name = 'dsh-tui-profile-manager'
export const inject = ['loader']

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export async function apply(ctx) {
  const source = ctx.get('profileContext')
  if (source === undefined || await managementModules(source.installAnchor, { optional: true }) === undefined) {
    throw new Error('Automatic TUI profile management requires a newer DSH host; run dsh-tui once to prepare this profile, or upgrade DSH to 0.2.0-rc.2 or later')
  }
  // DSH resolves an installation copy before a profile copy. A modern global
  // entry must still prepare the version actually installed by the UI.
  const manifest = readJson(join(packageDirectory(source.dir), 'package.json')) ?? readJson(join(packageRoot, 'package.json'))
  if (manifest?.name !== PACKAGE) throw new Error('Cannot identify the TUI installation')
  const profile = source.name === RESCUE_PROFILE ? RESCUE_PROFILE : PROFILE
  const ownProfile = resolve(source.dir) === resolve(source.home, 'profiles', profile)
  const require = createRequire(source.installAnchor)
  const { bindTypertRemote, Remote } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-protocol')).href)
  let flight
  let controller
  let disposed = false
  let phase = 'idle'
  let failure

  class TuiProfileManager {
    constructor() {
      this.ctx = ctx
      this.typertRemote = bindTypertRemote(this, 'tuiProfileManager')
      // The standard decorator's initializer also works for native JS methods.
      for (const method of ['status', 'prepare', 'cancel']) {
        Remote(this[method], {
          kind: 'method', name: method, static: false, private: false,
          addInitializer: initialize => initialize.call(this),
        })
      }
    }

    status() {
      const actual = runtimeStatus(join(source.home, 'profiles', profile))
      const ready = actual.ready && compareVersions(actual.version, manifest.version) >= 0
      return {
        ...actual, ready, profile, requestedVersion: manifest.version,
        phase: flight !== undefined ? phase : ready ? 'ready' : failure ? 'failed' : 'pending',
        error: failure,
        launch: ['node', join(actual.packageRoot, 'bin', 'dsh-tui.js')],
        launchEnvironment: { DSH_HOME: source.home },
      }
    }

    prepare() {
      if (disposed) return Promise.reject(new Error('The TUI management entry has been disabled'))
      if (flight !== undefined) return flight
      controller = new AbortController()
      failure = undefined
      phase = 'initializing'
      const publish = next => {
        phase = next
        ctx.emit('tui-profile/state', { profile, phase, version: manifest.version })
      }
      flight = (async () => {
        const actual = runtimeStatus(join(source.home, 'profiles', profile))
        if (actual.ready && compareVersions(actual.version, manifest.version) >= 0) return actual
        const registries = await ctx.get('pluginManager')?.registries()
        return prepareRuntime({
          Context: ctx.root.constructor, Loader: ctx.loader.constructor,
          source, version: manifest.version, profile, registries,
          signal: controller.signal, onPhase: publish,
        })
      })().then(result => { publish('ready'); return result }, error => {
        failure = error.message
        publish('failed')
        throw error
      }).finally(() => { flight = undefined })
      return flight
    }

    cancel() {
      controller?.abort(new Error('TUI preparation cancelled'))
      return { cancelling: flight !== undefined }
    }
  }

  const service = new TuiProfileManager()
  ctx.provide('tuiProfileManager', service)
  ctx.effect(() => async () => {
    disposed = true
    controller?.abort(new Error('TUI management entry disposed'))
    await flight?.catch(() => {})
  }, 'dsh-tui profile preparation')

  // The official commands service can mount later in the same composition.
  ctx.inject(['commands'], scope => {
    scope.effect(() => scope.commands.register({
      name: 'tui-status', description: 'Show the DSH TUI installation and launch command',
      handler: () => ({ kind: 'success', text: JSON.stringify(service.status(), null, 2) }),
    }))
    scope.effect(() => scope.commands.register({
      name: 'tui-prepare', description: 'Retry preparing the DSH TUI environment',
      handler: async () => { await service.prepare(); return { kind: 'success', text: JSON.stringify(service.status(), null, 2) } },
    }))
  })

  // Compatibility with `dsh --profile dsh-tui` after a direct CLI install.
  // Wait until initial startup has settled: reconciling the current Loader
  // from its own awaited initialization would wait on itself.
  if (ownProfile && !service.status().ready) {
    const ready = ctx.get('appReady')
    const hmr = ctx.get('hmr')
    const exit = ctx.get('appExit')
    if (ready === undefined || hmr === undefined) throw new Error('Run dsh-tui once to prepare this profile before starting it directly')
    ctx.effect(() => ready.onReady(() => {
      const timer = setTimeout(() => {
        void hmr.runExclusive(async () => {
          await service.prepare()
          return hmr.reconcileProfile()
        }).then(result => {
          const reason = result.restartReason ?? result.pending?.[0]?.reason
          if (reason === undefined) return
          // Recomposition may already have disposed this entry. Its completed
          // restart requirement still belongs to the running application.
          process.stderr.write(process.env.DSH_TUI_LANG === 'en'
            ? `[dsh-tui] The TUI profile is prepared, but DSH requires a restart to load its updated packages (${reason}).\nRun again with the same DSH_HOME: dsh --profile ${profile}\n`
            : `[dsh-tui] TUI profile 已准备完成；DSH 需要重启才能加载更新后的包（${reason}）。\n保持相同的 DSH_HOME，重新运行：dsh --profile ${profile}\n`)
          exit?.(1)
        }).catch(error => {
          if (disposed) return
          ctx.logger.error(error)
          exit?.(1)
        })
      }, 0)
      ctx.effect(() => () => clearTimeout(timer))
    }))
  }
}
