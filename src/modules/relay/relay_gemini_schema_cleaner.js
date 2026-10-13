const appendHint = (description, hint) => {
  if (!hint) {
    return description || ''
  }
  if (!description) {
    return hint
  }
  return `${description} (${hint})`
}

const getRefHint = (refValue) => {
  const ref = String(refValue || '')
  if (!ref) {
    return ''
  }
  const idx = ref.lastIndexOf('/')
  const name = idx >= 0 ? ref.slice(idx + 1) : ref
  return name ? `See: ${name}` : ''
}

const normalizeType = (typeValue) => {
  if (typeof typeValue === 'string' && typeValue) {
    return { type: typeValue, hint: '' }
  }
  if (!Array.isArray(typeValue) || typeValue.length === 0) {
    return { type: '', hint: '' }
  }
  const raw = typeValue.map((t) => (t === null || t === undefined ? '' : String(t))).filter(Boolean)
  const hasNull = raw.includes('null')
  const nonNull = raw.filter((t) => t !== 'null')
  const primary = nonNull[0] || 'string'
  const hintParts = []
  if (nonNull.length > 1) {
    hintParts.push(`Accepts: ${nonNull.join(' | ')}`)
  }
  if (hasNull) {
    hintParts.push('nullable')
  }
  return { type: primary, hint: hintParts.join('; ') }
}

const CONSTRAINT_KEYS = [
  'minLength',
  'maxLength',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'minItems',
  'maxItems',
]

const scoreSchema = (schema) => {
  if (!schema || typeof schema !== 'object') {
    return { score: 0, type: '' }
  }
  const t = typeof schema.type === 'string' ? schema.type : ''
  if (t === 'object' || (schema.properties && typeof schema.properties === 'object')) {
    return { score: 3, type: t || 'object' }
  }
  if (t === 'array' || schema.items) {
    return { score: 2, type: t || 'array' }
  }
  if (t && t !== 'null') {
    return { score: 1, type: t }
  }
  return { score: 0, type: t || 'null' }
}

const pickBestFromAlternatives = (alternatives) => {
  let bestIndex = 0
  let bestScore = -1
  const types = []
  for (let i = 0; i < alternatives.length; i += 1) {
    const alt = alternatives[i]
    const { score, type } = scoreSchema(alt)
    if (type) {
      types.push(type)
    }
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }
  return { best: alternatives[bestIndex], types: Array.from(new Set(types)).filter(Boolean) }
}

// parametersJsonSchema 保留的标准 JSON Schema 约束（CLIProxyAPI b532db9c）
const PRESERVED_JSON_SCHEMA_KEYS = [...CONSTRAINT_KEYS, 'minimum', 'maximum', 'format', 'default', 'title']

const schemaError = (path, keyword) => {
  const message = `Antigravity Claude cannot preserve tool schema ${keyword} at ${path}`
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'unsupported_tool_schema',
    response: { status: 400, data: { error: { code: 'unsupported_tool_schema', message } } }
  })
}

// DEC_20261013_165233 Antigravity Claude 工具 Schema 仅作语义等价转换，无法表达的约束返回 400。
export const convertAntigravityToolSchema = (schema) => {
  const annotations = new Set([
    '$schema',
    '$id',
    '$anchor',
    '$comment',
    '$defs',
    'definitions',
    'default',
    'examples'
  ])
  const merge = (left, right, path) => {
    const result = { ...left }
    for (const [key, value] of Object.entries(right)) {
      if (key === 'description' || key === 'title') {
result[key] = value
} else if (key === 'properties') {
        result.properties = { ...result.properties }
        for (const [name, property] of Object.entries(value)) {
          const merged = Object.hasOwn(result.properties, name)
            ? merge(result.properties[name], property, `${path}/properties/${name}`)
            : property
          result.properties = { ...result.properties, [name]: merged }
        }
      } else if (key === 'required') {
        result.required = [...new Set([...(result.required ?? []), ...value])]
      } else if (key === 'items' && result.items) {
        result.items = merge(result.items, value, `${path}/items`)
      } else if (key === 'nullable' && Object.hasOwn(result, key)) {
        result.nullable = result.nullable && value
      } else if (
        key === 'type' &&
        [result.type, value].every((type) => ['number', 'integer'].includes(type))
      ) {
        result.type = result.type === 'integer' || value === 'integer' ? 'integer' : 'number'
      } else if (
        Object.hasOwn(result, key) &&
        JSON.stringify(result[key]) !== JSON.stringify(value)
      ) {
        throw schemaError(path, key)
      } else {
result[key] = value
}
    }
    return result
  }
  const convert = (node, path, refs = new Set()) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw schemaError(path, 'schema')
    }
    let result = {}
    if (node.$ref !== undefined) {
      const ref = node.$ref
      if (typeof ref !== 'string' || !ref.startsWith('#/') || refs.has(ref)) {
        throw schemaError(path, '$ref')
      }
      let target = schema
      let pointer
      try {
        pointer = decodeURIComponent(ref.slice(2))
          .split('/')
          .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      } catch {
        throw schemaError(path, '$ref')
      }
      for (const part of pointer) {
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) {
          throw schemaError(path, '$ref')
        }
        target = target[part]
      }
      result = convert(target, ref, new Set([...refs, ref]))
    }
    for (const [key, value] of Object.entries(node)) {
      if (annotations.has(key) || key === '$ref') {
continue
}
      if (key === 'allOf') {
        if (!Array.isArray(value) || !value.length) {
          throw schemaError(path, key)
        }
        for (let index = 0; index < value.length; index += 1) {
          result = merge(result, convert(value[index], `${path}/allOf/${index}`, refs), path)
        }
        continue
      }
      if (key === 'anyOf' || key === 'oneOf') {
        if (!Array.isArray(value) || !value.length) {
          throw schemaError(path, key)
        }
        const branches = value.filter(
          (branch) =>
            !(
              branch?.type === 'null' &&
              Object.keys(branch).every(
                (name) =>
                  name === 'type' ||
                  annotations.has(name) ||
                  name === 'description' ||
                  name === 'title'
              )
            )
        )
        if (branches.length !== 1 || value.length - branches.length > 1) {
          throw schemaError(path, key)
        }
        const branch = convert(branches[0], `${path}/${key}`, refs)
        if (value.length > branches.length) {
          if (!branch.type || branch.nullable === true) {
            throw schemaError(path, key)
          }
          branch.nullable = true
        }
        result = merge(result, branch, path)
        continue
      }
      let field = value
      if (key === 'type') {
        const types = [...new Set(Array.isArray(value) ? value : [value])]
        const nonNull = types.filter((type) => type !== 'null')
        if (
          nonNull.length !== 1 ||
          !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(nonNull[0])
        ) {
          throw schemaError(path, key)
        }
        field = nonNull[0]
        result = merge(result, { nullable: types.includes('null') || node.nullable === true }, path)
      } else if (key === 'properties') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw schemaError(path, key)
        }
        field = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            convert(child, `${path}/properties/${name}`, refs)
          ])
        )
      } else if (key === 'items') {
        field = convert(value, `${path}/items`, refs)
      } else if (key === 'required') {
        if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
          throw schemaError(path, key)
        }
        field = [...new Set(value)]
      } else if (key === 'additionalProperties' && value === true) {
continue
} else if (key === 'nullable' && typeof value !== 'boolean') {
        throw schemaError(path, key)
      } else if (!['description', 'title', 'nullable'].includes(key)) {
        throw schemaError(path, key)
      }
      result = merge(result, { [key]: field }, path)
    }
    return result
  }
  return convert(schema, '#')
}

// options.preserveConstraints：parametersJsonSchema 形态，保留约束与 additionalProperties
export const cleanJsonSchemaForGemini = (schema, options = {}) => {
  const preserveConstraints = options.preserveConstraints === true
  const clean = (child) => cleanJsonSchemaForGemini(child, options)
  // 布尔 true 子 schema 等价于 {}（CLIProxyAPI c93978c4）
  if (schema === true) {
    return preserveConstraints ? {} : { type: 'object', properties: {} }
  }
  if (schema === null || schema === undefined) {
    return { type: 'object', properties: {} }
  }
  // JSON Schema 字段保留引用、组合、类型数组和原约束；typed Schema 清洗仅用于旧字段。
  if (preserveConstraints) {
    return structuredClone(schema)
  }
  if (typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }
  if (Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }

  // $ref：Gemini/Antigravity 不支持，转换为 hint
  if (typeof schema.$ref === 'string' && schema.$ref) {
    return {
      type: 'object',
      description: appendHint(schema.description || '', getRefHint(schema.$ref)),
      properties: {},
    }
  }

  // anyOf / oneOf：选择最可能的 schema，保留类型提示
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : null
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : null
  const alts = anyOf && anyOf.length ? anyOf : oneOf && oneOf.length ? oneOf : null
  if (alts) {
    const { best, types } = pickBestFromAlternatives(alts)
    const cleaned = clean(best)
    const mergedDescription = appendHint(cleaned.description || '', schema.description || '')
    const typeHint = types.length > 1 ? `Accepts: ${types.join(' || ')}` : ''
    return {
      ...cleaned,
      description: appendHint(mergedDescription, typeHint),
    }
  }

  // allOf：合并 properties/required
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const merged = {}
    let mergedDesc = schema.description || ''
    const mergedReq = new Set()
    const mergedProps = {}
    for (const item of schema.allOf) {
      const cleaned = clean(item)
      if (cleaned.description) {
        mergedDesc = appendHint(mergedDesc, cleaned.description)
      }
      if (Array.isArray(cleaned.required)) {
        for (const r of cleaned.required) {
          if (typeof r === 'string' && r) {
            mergedReq.add(r)
          }
        }
      }
      if (cleaned.properties && typeof cleaned.properties === 'object') {
        Object.assign(mergedProps, cleaned.properties)
      }
      if (cleaned.type && !merged.type) {
        merged.type = cleaned.type
      }
      if (cleaned.items && !merged.items) {
        merged.items = cleaned.items
      }
      if (Array.isArray(cleaned.enum) && !merged.enum) {
        merged.enum = cleaned.enum
      }
    }
    if (Object.keys(mergedProps).length) {
      merged.type = merged.type || 'object'
      merged.properties = mergedProps
      const req = Array.from(mergedReq).filter((r) => mergedProps[r])
      if (req.length) {
        merged.required = req
      }
    }
    if (mergedDesc) {
      merged.description = mergedDesc
    }
    return clean(merged)
  }

  const result = {}
  const constraintHints = []

  // description
  if (typeof schema.description === 'string') {
    result.description = schema.description
  }

  if (preserveConstraints) {
    for (const key of PRESERVED_JSON_SCHEMA_KEYS) {
      const value = schema[key]
      if (value !== undefined && value !== null && typeof value !== 'object') {
        result[key] = value
      }
    }
  } else {
    for (const key of CONSTRAINT_KEYS) {
      const value = schema[key]
      if (value === undefined || value === null || typeof value === 'object') {
        continue
      }
      constraintHints.push(`${key}: ${value}`)
    }
  }

  // const -> enum
  if (schema.const !== undefined && !Array.isArray(schema.enum)) {
    result.enum = [schema.const]
  }

  // enum
  if (Array.isArray(schema.enum)) {
    const en = schema.enum.filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    if (en.length) {
      result.enum = en
    }
  }

  // type（flatten 数组 type）
  const { type: normalizedType, hint: typeHint } = normalizeType(schema.type)
  if (normalizedType) {
    result.type = normalizedType
  }
  if (typeHint) {
    result.description = appendHint(result.description || '', typeHint)
  }

  if (!preserveConstraints && result.enum && result.enum.length > 1 && result.enum.length <= 10) {
    const list = result.enum.map((item) => String(item)).join(', ')
    result.description = appendHint(result.description || '', `Allowed: ${list}`)
  }

  if (constraintHints.length) {
    result.description = appendHint(result.description || '', constraintHints.join(', '))
  }

  // additionalProperties：parametersJsonSchema 原样保留；parameters（OpenAPI 子集）不接受布尔值，转 hint
  if (preserveConstraints && schema.additionalProperties !== undefined) {
    result.additionalProperties =
      typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null
        ? clean(schema.additionalProperties)
        : schema.additionalProperties
  } else if (schema.additionalProperties === false) {
    result.description = appendHint(result.description || '', 'No extra properties allowed')
  }

  // properties
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const props = {}
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      props[name] = clean(propSchema)
    }
    result.type = result.type || 'object'
    result.properties = props
  }

  // items
  if (schema.items !== undefined) {
    result.type = result.type || 'array'
    result.items = clean(schema.items)
  }

  // required（最后再清理无效字段）
  if (Array.isArray(schema.required) && result.properties) {
    const req = schema.required.filter(
      (r) => typeof r === 'string' && r && Object.prototype.hasOwnProperty.call(result.properties, r),
    )
    if (req.length) {
      result.required = req
    }
  }

  // 只保留 Gemini 兼容字段：其他（$schema/$id/$defs/definitions/format/constraints/pattern...）一律丢弃

  if (!result.type) {
    result.type = result.properties ? 'object' : result.items ? 'array' : 'object'
  }
  if (result.type === 'object' && !result.properties) {
    result.properties = {}
  }
  return result
}
