/**
 * Stable dispatcher facade for the "./oauth" subpath (deploy-transition
 * S04 M1: every public TUI subpath resolves through the SAME process
 * pin as the main entry, so a Cordis row loaded by package name can
 * never mix generations with the running plugin. The pin (generation +
 * lease) is established before the target module is imported; see
 * dispatch/resolve.mjs. Source/legacy modes import the canonical file
 * next to dispatch/, byte-identical to the pre-dispatch world.
 *
 * The forwarded names are this subpath's complete runtime export set;
 * scripts/verify-dispatch-subpaths.mjs keeps them in lockstep with the
 * canonical module. "default" carries the raw module namespace.
 */
import { resolveTuiEntry } from "./resolve.mjs"

const mod = await resolveTuiEntry(import.meta.url, "lib/types/oauth.js")

export const name = mod.name
export const inject = mod.inject
export const Config = mod.Config
export const apply = mod.apply
export const CredentialFile = mod.CredentialFile
export const CredentialGatedAdapter = mod.CredentialGatedAdapter
export const DEEPSEEK_ACCOUNT_PROVIDER = mod.DEEPSEEK_ACCOUNT_PROVIDER
export const OAUTH_PROVIDER_IDS = mod.OAUTH_PROVIDER_IDS
export const QuestionBridge = mod.QuestionBridge
export const WhaleCouponStore = mod.WhaleCouponStore
export const availableOAuthProviderIds = mod.availableOAuthProviderIds
export const buildOAuthProfile = mod.buildOAuthProfile
export const copyToClipboard = mod.copyToClipboard
export const createDshAuthApi = mod.createDshAuthApi
export const deepSeekAccountFrom = mod.deepSeekAccountFrom
export const deepSeekCallbackOrigin = mod.deepSeekCallbackOrigin
export const deepSeekClientMetadata = mod.deepSeekClientMetadata
export const defaultCredentialsFile = mod.defaultCredentialsFile
export const describeEvent = mod.describeEvent
export const loginDeepSeekAccount = mod.loginDeepSeekAccount
export const openInBrowser = mod.openInBrowser
export const openerFor = mod.openerFor
export default mod.default ?? mod
