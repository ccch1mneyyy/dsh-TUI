/**
 * 零依赖 JSON Schema 校验器——上游 `conformance/tests/run.js` 的 check()
 * 的保真 TS 移植。刻意只实现 vendored schemas 用到的子集：本地 $ref、
 * oneOf（恰好一个匹配）、const/enum、object（required/additionalProperties:
 * false/patternProperties）、array（min/maxItems/items/uniqueItems）、
 * string（min/maxLength/pattern/format uri|date-time）、integer（minimum）、
 * boolean。遇到子集之外的构件不静默放行——schema 更新引入新构件时这里
 * 必须显式扩展（fixtures 矩阵会当场抓住）。
 */

type JsonSchema = Record<string, unknown>

/** Canonical JSON encoding for `uniqueItems`.  JSON object member order is not
 * semantically significant, while `JSON.stringify` preserves insertion order
 * and therefore lets equivalent objects evade duplicate detection. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  switch (typeof value) {
    case 'object': {
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
    }
    case 'string': return JSON.stringify(value)
    case 'number': return JSON.stringify(value) ?? 'null'
    case 'boolean': return value ? 'true' : 'false'
    case 'undefined': return 'undefined'
    default: return `${typeof value}:${String(value)}`
  }
}

function resolveRef(rootSchema: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/')) {
    throw new Error(`external ref is not supported by the zero-dependency checker: ${ref}`)
  }
  return ref
    .slice(2)
    .split('/')
    .reduce<JsonSchema>((value, key) => {
      const child = value[key.replace(/~1/g, '/').replace(/~0/g, '~')]
      if (child === null || typeof child !== 'object') {
        throw new Error(`unresolvable $ref segment "${key}" in ${ref}`)
      }
      return child as JsonSchema
    }, rootSchema)
}

/**
 * Validate `value` against `schema`; throws an Error with the failing path
 * (`$.a.b[0]: reason`) on the first violation.
 */
export function check(value: unknown, schema: JsonSchema, rootSchema: JsonSchema = schema, where = '$'): void {
  if (typeof schema.$ref === 'string') {
    return check(value, resolveRef(rootSchema, schema.$ref), rootSchema, where)
  }
  // oneOf: exactly one variant must match (JSON Schema semantics). Variants
  // are currently mutually exclusive by design; exact-one keeps future
  // overlap from being silently accepted.
  if (Array.isArray(schema.oneOf)) {
    let matched = 0
    const errors: string[] = []
    for (const variant of schema.oneOf as JsonSchema[]) {
      try {
        check(value, variant, rootSchema, where)
        matched += 1
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (matched !== 1) {
      throw new Error(`${where}: expected exactly one oneOf match, got ${matched}: ${errors.join(' | ')}`)
    }
    return
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${where}: expected ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    throw new Error(`${where}: value is not in enum`)
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${where}: expected object`)
    }
    const record = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) throw new Error(`${where}.${key}: required`)
    }
    // draft-2020-12: additionalProperties consults properties AND
    // patternProperties — a key matching a declared pattern is not
    // "additional".
    if (schema.additionalProperties === false) {
      const patterns = Object.keys((schema.patternProperties as JsonSchema | undefined) ?? {})
      for (const key of Object.keys(record)) {
        const declared = (schema.properties as JsonSchema | undefined)?.[key] !== undefined
        const patterned = patterns.some(pattern => new RegExp(pattern).test(key))
        if (!declared && !patterned) throw new Error(`${where}.${key}: additional property`)
      }
    }
    for (const [key, child] of Object.entries((schema.properties as JsonSchema | undefined) ?? {})) {
      if (key in record) check(record[key], child as JsonSchema, rootSchema, `${where}.${key}`)
    }
    if (schema.patternProperties !== undefined) {
      for (const [pattern, child] of Object.entries(schema.patternProperties as JsonSchema)) {
        for (const name of Object.keys(record)) {
          if (new RegExp(pattern).test(name)) check(record[name], child as JsonSchema, rootSchema, `${where}.${name}`)
        }
      }
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${where}: expected array`)
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
      throw new Error(`${where}: too few items`)
    }
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) {
      throw new Error(`${where}: too many items`)
    }
    for (let i = 0; i < value.length; i++) {
      check(value[i], schema.items as JsonSchema, rootSchema, `${where}[${i}]`)
    }
    if (schema.uniqueItems === true) {
      const encoded = value.map(canonicalJson)
      if (new Set(encoded).size !== encoded.length) throw new Error(`${where}: duplicate items`)
    }
    return
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${where}: expected string`)
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) {
      throw new Error(`${where}: too short`)
    }
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) {
      throw new Error(`${where}: too long`)
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string).test(value)) {
      throw new Error(`${where}: pattern mismatch`)
    }
    if (schema.format === 'uri' && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
      throw new Error(`${where}: invalid URI`)
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      throw new Error(`${where}: invalid date-time`)
    }
    return
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`${where}: expected integer`)
    if (schema.minimum !== undefined && (value as number) < (schema.minimum as number)) {
      throw new Error(`${where}: below minimum`)
    }
    return
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${where}: expected boolean`)
  }
}
