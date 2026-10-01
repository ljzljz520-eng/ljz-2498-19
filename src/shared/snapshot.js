// 数据快照 + 变量求值编排。
// 同一快照驱动预览与导出：求值只依赖传入的 snapshot，绝不二次取数。

import { evalAst } from './expr/evaluator.js'
import { compileDefinitions, buildGraph, LIMITS } from './variables.js'
import { ExpressionError, AccessDeniedError } from './errors.js'
import { MISSING, Missing, SecretValue, isMissing, isSecret, DateTimeValue } from './types.js'
import { applyDefault, formatDateTime, formatNumber, parseDateTime, parseNumberStrict, DEFAULT_ZONE } from './rules.js'

// snapshot: {
//   id, templateVersion, createdAt, zone,
//   data: { sourceKey: 字段对象 },          // 已取数并冻结
//   acl:  { principal, deniedPaths: ['order.customer.idNo', 'hr.salary'] }
// }

export function createBudget(max = LIMITS.MAX_EVAL_NODE_VISITS) {
  let used = 0
  return {
    get used() { return used },
    tick(n) {
      used += n
      if (used > max) {
        throw new ExpressionError('E_LIMIT', `求值规模超过预算（${used} > ${max} 节点次）`, { phase: 'eval' })
      }
    },
  }
}

// 在数据对象外层包一层守卫：读取被拒绝的字段时抛 AccessDeniedError。
// 数组下标（数字键）不参与路径判权；嵌套对象在读取时惰性包装，路径随之下钻。
export function guardData(rootKey, data, deniedSet, principal, onDenied) {
  const wrap = (node, pathSegments) => {
    if (node === null || typeof node !== 'object') return node
    return new Proxy(node, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop]
        const isIndex = Array.isArray(target) && /^\d+$/.test(String(prop))
        const segs = isIndex ? pathSegments : [...pathSegments, String(prop)]
        const full = segs.join('.')
        if (!isIndex && deniedSet.has(full)) {
          onDenied?.(full)
          throw new AccessDeniedError(rootKey, full, principal)
        }
        const v = target[prop]
        if (v && typeof v === 'object') return wrap(v, segs)
        return v
      },
    })
  }
  // 根级整体被拒
  if (deniedSet.has(rootKey)) {
    onDenied?.(rootKey)
    throw new AccessDeniedError(rootKey, rootKey, principal)
  }
  return wrap(data, [rootKey])
}

function coerceByType(value, def, diags) {
  if (isMissing(value)) return MISSING
  const secret = isSecret(value)
  const v = secret ? value.plain : value
  try {
    switch (def.type) {
      case 'number': {
        if (v === null || v === undefined) return MISSING
        const n = parseNumberStrict(v)
        return secret ? new SecretValue(n, value.variableId) : n
      }
      case 'datetime':
      case 'date': {
        if (v === null || v === undefined) return MISSING
        const dt = v instanceof DateTimeValue ? v : parseDateTime(v, def.tz || DEFAULT_ZONE)
        if (def.type === 'date' && dt.kind === 'datetime') dt.kind = 'date'
        return dt
      }
      case 'boolean':
        if (typeof v === 'boolean') return v
        if (v === 'true') return true
        if (v === 'false') return false
        return Boolean(v)
      case 'url':
      case 'text':
      default:
        return value
    }
  } catch (e) {
    diags.push({ level: 'error', code: e.code || 'E_COERCE', variableId: def.id, variableKey: def.key, message: e.message })
    return MISSING
  }
}

// 求值全部变量。返回 { values, secretOwners, diagnostics, budgetUsed, refLinks, principal }
export function evaluateVariables(defs, snapshot, options = {}) {
  const diagnostics = []
  const deniedSet = new Set(snapshot.acl?.deniedPaths || [])
  const principal = snapshot.acl?.principal || options.principal || 'anonymous'

  const { compiled, byKey } = compileDefinitions(defs)
  const snapshotKeys = new Set(Object.keys(snapshot.data || {}))
  const { order } = buildGraph(compiled, snapshotKeys)

  const values = new Map()
  const secretOwners = new Set()
  const budget = createBudget(options.maxNodeVisits)
  const refLinks = []

  // 守卫化的数据源根
  const guardedRoots = new Map()
  for (const key of Object.keys(snapshot.data || {})) {
    guardedRoots.set(key, guardData(key, snapshot.data[key], deniedSet, principal, (path) => {
      // 具体归属变量在求值 catch 中补充；这里先记录原始拒绝
      diagnostics.push({ level: 'warning', code: 'E_NO_ACCESS', fieldPath: path, message: `主体 "${principal}" 无权读取 ${path}，按缺值处理` })
    }))
  }

  for (const def of order) {
    if (!def.ast) {
      // 直接映射变量
      const srcKey = def.sourceId || def.key
      let raw = MISSING
      if (snapshot.data[srcKey] !== undefined) {
        if (deniedSet.has(srcKey)) {
          raw = new Missing('NO_ACCESS')
          diagnostics.push({ level: 'warning', code: 'E_NO_ACCESS', variableId: def.id, variableKey: def.key, fieldPath: srcKey, message: `主体 "${principal}" 无权读取 ${srcKey}，按缺值处理` })
        } else {
          raw = snapshot.data[srcKey]
        }
      }
      let v = applyDefault(raw, def.defaultValue === undefined ? MISSING : def.defaultValue)
      v = coerceByType(v, def, diagnostics)
      if (def.sensitive) { secretOwners.add(def.id); if (!isMissing(v)) v = new SecretValue(isSecret(v) ? v.plain : v, def.id) }
      values.set(def.key, v)
      continue
    }

    const ctx = {
      currentVariableId: def.id,
      principal,
      budget,
      trace: {
        onVarRef: (name, fromId, val) => {
          refLinks.push({ from: def.key, to: name })
          if (isSecret(val)) secretOwners.add(val.variableId)
        },
        onDenied: (owner, fromId, fieldPath) => {
          diagnostics.push({ level: 'warning', code: 'E_NO_ACCESS', variableId: def.id, variableKey: def.key, fieldPath, message: `主体 "${principal}" 无权读取 ${fieldPath}，按缺值处理` })
        },
      },
      resolveVar: (name) => {
        if (byKey.has(name)) {
          const v = values.get(name)
          const owner = byKey.get(name)
          if (owner.sensitive && v !== undefined && !isMissing(v)) secretOwners.add(owner.id)
          return v === undefined ? MISSING : v
        }
        if (guardedRoots.has(name)) return guardedRoots.get(name)
        if (snapshot.data[name] !== undefined) return snapshot.data[name]
        throw new ExpressionError('E_UNDEFINED_VAR', `未定义的变量或数据源 "${name}"`, { variableId: def.id, refVar: name, phase: 'eval' })
      },
    }

    let result
    try {
      result = evalAst(def.ast, ctx)
      result = applyDefault(result, def.defaultValue === undefined ? MISSING : def.defaultValue)
      result = coerceByType(result, def, diagnostics)
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        diagnostics.push({ level: 'warning', code: 'E_NO_ACCESS', variableId: def.id, variableKey: def.key, fieldPath: e.fieldPath, message: e.message })
        result = new Missing('NO_ACCESS')
      } else {
        diagnostics.push({ level: 'error', code: e.code || 'E_EVAL', variableId: def.id, variableKey: def.key, message: e.message, location: e.location || null })
        result = new Missing('FAILED')
      }
    }
    if (def.sensitive) {
      secretOwners.add(def.id)
      if (!isMissing(result) && !(result instanceof Missing)) {
        result = new SecretValue(isSecret(result) ? result.plain : result, def.id)
      }
    }
    values.set(def.key, result)
  }

  return { values, secretOwners, diagnostics, budgetUsed: budget.used, refLinks, principal }
}

// 运行时值 -> 显示字符串（日期/数字遵循固定规则）
export function valueToDisplay(value, def = {}) {
  if (isMissing(value)) return { text: '', missing: true, reason: value.reason }
  if (value === null) return { text: '', missing: false, null: true }
  if (isSecret(value)) {
    const inner = valueToDisplay(value.plain, def)
    return { ...inner, secret: true, secretOwner: value.variableId }
  }
  if (value instanceof DateTimeValue) return { text: formatDateTime(value, def.tz || DEFAULT_ZONE), missing: false }
  if (typeof value === 'number') return { text: def.format != null ? formatNumber(value, def.format) : String(value), missing: false }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', missing: false }
  return { text: String(value), missing: false, empty: typeof value === 'string' && value === '' }
}
