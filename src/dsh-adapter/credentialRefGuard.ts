/**
 * Credential-ref reservation guard for the plugin settings-section seam.
 *
 * A settings section's `secret: { ref }` field writes whatever the user types
 * through the credentials seam — under ANY ref the section names. A malicious
 * section can therefore present a "plugin API key" card whose ref is actually
 * the harness's shared DEEPSEEK_API_KEY (or any DEEPSEEK_/DSH_-prefixed ref)
 * and overwrite the user's main credential. The guard is deliberately
 * restrained: only refs the host owns are protected, and only for plugin-side
 * registrations — plugins keep their own namespaces (my-plugin/key) untouched.
 */

/**
 * Refs the host/harness owns outright. The DEEPSEEK_/DSH_ prefixes below
 * cover future host-side additions without editing this list each time.
 */
const RESERVED_CREDENTIAL_REFS: readonly string[] = ['DEEPSEEK_API_KEY']
const RESERVED_CREDENTIAL_REF_PREFIXES: readonly string[] = ['DEEPSEEK_', 'DSH_']

/** Whether `ref` lives in a credential namespace reserved for the host. */
export function isReservedCredentialRef(ref: string): boolean {
  return RESERVED_CREDENTIAL_REFS.includes(ref)
    || RESERVED_CREDENTIAL_REF_PREFIXES.some(prefix => ref.startsWith(prefix))
}

/** Field shape the vetting needs; structural so any section type fits. */
interface FieldWithSecretRef {
  readonly path: readonly string[]
  readonly secret?: { ref: string }
}

/** One rejected field, for the caller's warning log. */
export interface SecretRefRejection {
  readonly path: readonly string[]
  readonly ref: string
}

/**
 * Drop every field whose secret ref is reserved for the host. Used on the
 * plugin-facing registration path only — host-identity registrations (no
 * activation owner) keep their reserved refs. The rest of the section is
 * preserved: one offending field must not take a plugin's whole settings
 * page down with it.
 */
export function vetSectionSecretRefs<S extends { fields: readonly FieldWithSecretRef[] }>(
  section: S,
): { section: S; rejected: SecretRefRejection[] } {
  const rejected: SecretRefRejection[] = []
  const fields = section.fields.filter(field => {
    const ref = field.secret?.ref
    if (ref === undefined || !isReservedCredentialRef(ref)) return true
    rejected.push({ path: field.path, ref })
    return false
  })
  // The spread keeps every other property of the caller's section type; the
  // fields array is the same element type minus nothing structural (only
  // fewer elements), so the cast is a pure narrowing of the same value.
  return { section: { ...section, fields: fields as S['fields'] }, rejected }
}
