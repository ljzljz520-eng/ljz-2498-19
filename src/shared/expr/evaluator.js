// AST 解释执行器（白名单）。没有 eval / new Function —— 模板绝不会被当作任意脚本执行。

import { AccessDeniedError, fail } from '../errors.js'
import { MISSING, Missing, SecretValue, isMissing, isSecret } from '../types.js'
import {
  parseDateTime, formatDateTime, formatNumber, formatMoney,
  parseNumberStrict, applyDefault, nowDateTime, todayDate, DEFAULT_ZONE,
} from '../rules.js'

// ctx: {
//   resolveVar(name): value
//   canRead?(ownerId, path[], principal): boolean
//   memberOwnerId?, principal?, currentVariableId?
//   budget: { tick(n) }
//   trace?: { onVarRef?, onDenied? }
// }

export function evalAst(node, ctx, pathStack = []) {
  ctx.budget.tick(1)
  const here = (extra) => ({ variableId: ctx.currentVariableId, path: [...pathStack], ...extra })

  switch (node.t) {
    case 'literal':
      return node.v
    case 'unary': {
      const a = evalAst(node.arg, ctx, [...pathStack, node.op])
      return isMissing(a) || a === null ? MISSING
        : node.op === '-' ? -parseNumberStrict(unwrap(a)) : !truthy(a)
    }
    case 'var': {
      let value
      try {
        value = ctx.resolveVar(node.name)
      } catch (e) {
        if (e instanceof AccessDeniedError) {
          ctx.trace?.onDenied?.(node.name, ctx.currentVariableId, e.fieldPath)
          taintRef(node, ctx)
          return new Missing('NO_ACCESS')
        }
        throw e
      }
      ctx.trace?.onVarRef?.(node.name, ctx.currentVariableId, value)
      taintRef(node, ctx)
      return value
    }
    case 'member': {
      const objRaw = evalAst(node.obj, ctx, [...pathStack, '.'])
      if (isMissing(objRaw) || objRaw === null || objRaw === undefined) return MISSING
      const secret = isSecret(objRaw)
      const obj = secret ? objRaw.plain : objRaw
      let key
      if (node.key.t === 'literal') key = node.key.v
      else key = unwrap(evalAst(node.key, ctx, [...pathStack, '[]']))
      if (key === null || isMissing(key)) return MISSING
      if (typeof obj !== 'object' || obj === null) {
        fail('E_TYPE', `无法在 ${describeType(obj)} 上取字段 "${key}"`, here({ snippet: key }))
      }
      // 权限在「快照守卫代理」层执行：受保护对象读字段时由代理抛 AccessDeniedError
      if (!(key in obj)) return MISSING
      const v = obj[key]
      if (v === undefined) return MISSING
      // 敏感变量取子字段：敏感向内传播
      if (secret) return new SecretValue(v, objRaw.variableId)
      if (isMissing(v) || v === null) return v === null ? null : MISSING
      return v
    }
    case 'bin': return evalBinary(node, ctx, pathStack, here)
    case 'tri': {
      const c = evalAst(node.cond, ctx, [...pathStack, '?'])
      return truthy(c)
        ? evalAst(node.yes, ctx, [...pathStack, ':1'])
        : evalAst(node.no, ctx, [...pathStack, ':0'])
    }
    case 'call': return evalCall(node, ctx, pathStack, here)
    default: fail('E_AST', `未知节点类型 ${node.t}`, here())
  }
}

function taintRef(node, ctx) {
  // 供溯源使用：引用节点位置（源表达式中的字符区间在 parser 已记录 pos，这里透传）
  if (ctx.trace?.onRefNode) ctx.trace.onRefNode(node.name, node.pos, ctx.currentVariableId)
}

const unwrap = (v) => (isSecret(v) ? v.plain : v)
const describeType = (v) => (Array.isArray(v) ? '数组' : typeof v)

function truthy(v) {
  if (isMissing(v) || v === null) return false
  if (isSecret(v)) return truthy(v.plain)
  if (typeof v === 'string') return v.length > 0 // 空串为 false，但仍是显式值
  return Boolean(v)
}

function looseEquals(a, b) {
  if (isMissing(a)) return isMissing(b) || b === null
  if (isMissing(b)) return a === null
  return a === b
}
export function toStringValue(v) {
  if (isMissing(v) || v === null) return ''
  if (isSecret(v)) return toStringValue(v.plain)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
function compare(l, r, here) {
  if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : l > r ? 1 : 0
  if (typeof l === 'string' && typeof r === 'string') return l < r ? -1 : l > r ? 1 : 0
  fail('E_TYPE', `不可比较：${typeof l} 与 ${typeof r}`, here())
}

function evalBinary(node, ctx, pathStack, here) {
  const op = node.op
  if (op === 'AND') {
    if (!truthy(evalAst(node.l, ctx, [...pathStack, '&&l']))) return false
    return truthy(evalAst(node.r, ctx, [...pathStack, '&&r']))
  }
  if (op === 'OR') {
    if (truthy(evalAst(node.l, ctx, [...pathStack, '||l']))) return true
    return truthy(evalAst(node.r, ctx, [...pathStack, '||r']))
  }
  const lRaw = evalAst(node.l, ctx, [...pathStack, 'l'])
  const rRaw = evalAst(node.r, ctx, [...pathStack, 'r'])
  if (op === 'EQEQ' || op === 'NEQ') {
    const eq = looseEquals(lRaw, rRaw)
    return op === 'EQEQ' ? eq : !eq
  }
  const l = unwrap(lRaw)
  const r = unwrap(rRaw)
  if (isMissing(lRaw) || lRaw === null || isMissing(rRaw) || rRaw === null) return MISSING
  switch (op) {
    case 'PLUS':
      if (typeof l === 'string' || typeof r === 'string') {
        return toStringValue(lRaw) + toStringValue(rRaw)
      }
      return parseNumberStrict(l) + parseNumberStrict(r)
    case 'MINUS': return parseNumberStrict(l) - parseNumberStrict(r)
    case 'STAR': return parseNumberStrict(l) * parseNumberStrict(r)
    case 'SLASH': {
      const b = parseNumberStrict(r)
      if (b === 0) fail('E_NUMBER', '除数为 0', here({ snippet: '/' }))
      return parseNumberStrict(l) / b
    }
    case 'PERCENT': {
      const b = parseNumberStrict(r)
      if (b === 0) fail('E_NUMBER', '模 0', here({ snippet: '%' }))
      return parseNumberStrict(l) % b
    }
    case 'LT': return compare(l, r, here) < 0
    case 'GT': return compare(l, r, here) > 0
    case 'LTE': return compare(l, r, here) <= 0
    case 'GTE': return compare(l, r, here) >= 0
    default: fail('E_AST', `未实现运算符 ${op}`, here())
  }
}

function evalCall(node, ctx, pathStack, here) {
  const name = node.callee.name
  const args = node.args.map((a, i) => evalAst(a, ctx, [...pathStack, `arg${i}`]))
  const plain = args.map(unwrap)
  const secretOf = args.find(isSecret)
  const wrap = (v) => (secretOf ? new SecretValue(v, secretOf.variableId) : v)
  const need = (i) => {
    if (isMissing(plain[i]) || plain[i] === null) return MISSING
    return plain[i]
  }

  switch (name) {
    case 'upper': return wrap(toStringValue(plain[0]).toUpperCase())
    case 'lower': return wrap(toStringValue(plain[0]).toLowerCase())
    case 'trim': return wrap(toStringValue(plain[0]).trim())
    case 'concat': return args.map(toStringValue).join('')
    case 'len': {
      const v = plain[0]
      if (isMissing(v) || v === null) return MISSING
      if (typeof v === 'string' || Array.isArray(v)) return v.length
      fail('E_TYPE', 'len 仅支持文本或数组', here({ snippet: 'len' }))
    }
    case 'number': return need(0) === MISSING ? MISSING : parseNumberStrict(plain[0])
    case 'date': {
      const [input, zone] = plain
      if (isMissing(input) || input === null) return MISSING
      return parseDateTime(input, typeof zone === 'string' ? zone : DEFAULT_ZONE)
    }
    case 'now': return nowDateTime(typeof plain[0] === 'string' ? plain[0] : DEFAULT_ZONE)
    case 'today': return todayDate(typeof plain[0] === 'string' ? plain[0] : DEFAULT_ZONE)
    case 'money': {
      if (isMissing(plain[0]) || plain[0] === null) return MISSING
      return formatMoney(plain[0], plain[1] || 'CNY')
    }
    case 'numberFormat':
      if (isMissing(plain[0]) || plain[0] === null) return MISSING
      return formatNumber(plain[0], plain[1] ?? 2)
    case 'ifNull':
    case 'default': {
      // default(v, fallback)：仅缺值/null 回退；空串保持空串
      const v = args[0]
      const fb = args.length > 1 ? args[1] : MISSING
      const fbValue = isMissing(fb) || fb === null || fb === undefined ? MISSING : unwrap(fb)
      let out = applyDefault(v, fbValue)
      if (isSecret(v)) out = new SecretValue(isMissing(out) ? '' : unwrap(out), v.variableId)
      return out
    }
    default:
      fail('E_SECURITY', `不允许的函数 "${name}"`, here({ snippet: name }))
  }
}

export { formatDateTime }
