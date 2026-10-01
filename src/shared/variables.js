// 变量定义模型 + 校验 + 依赖图（循环检测、规模限制）

import { parseExpression, collectReferences } from './expr/parser.js'
import { ExpressionError, fail } from './errors.js'
import { TYPES } from './types.js'

export const LIMITS = {
  MAX_VARIABLES: 200,
  MAX_EXPR_NODES: 400,        // 单个表达式 AST 节点上限
  MAX_VAR_NAME_LEN: 64,
  MAX_EVAL_NODE_VISITS: 20000, // 一次整稿求值总预算
  MAX_DEPTH: 32,               // 依赖链深度
  MAX_SNAPSHOT_BYTES: 512 * 1024,
}

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

// def: { id, key, label, type, expr, defaultValue, sensitive, sourceId?, tz? }
export function validateDefinition(def, allKeys) {
  const problems = []
  if (!def || typeof def !== 'object') problems.push('变量定义不是对象')
  const key = def?.key
  if (!key || !NAME_RE.test(key)) {
    problems.push(`变量名 "${key}" 非法：须为字母/_开头，长度 1..${LIMITS.MAX_VAR_NAME_LEN}`)
  }
  if (def?.type && !TYPES.includes(def.type)) problems.push(`不支持的类型 ${def.type}`)
  if (def?.expr && def.expr.length > 2000) problems.push('表达式过长（>2000 字符）')
  return problems
}

export function compileDefinitions(defs) {
  if (defs.length > LIMITS.MAX_VARIABLES) {
    fail('E_LIMIT', `变量数量超过上限 ${LIMITS.MAX_VARIABLES}`)
  }
  const byKey = new Map()
  const compiled = defs.map((def) => {
    const probs = validateDefinition(def)
    if (probs.length) fail('E_DEF', `变量 ${def?.key ?? '?'} 定义非法：${probs.join('；')}`, { variableId: def?.id })
    if (byKey.has(def.key)) fail('E_DEF', `变量名重复：${def.key}`, { variableId: def?.id })
    let ast = null
    let refs = []
    if (def.expr && def.expr.trim() !== '') {
      ast = parseExpression(def.expr, { variableId: def.id, phase: 'compile', snippet: def.expr })
      refs = collectReferences(ast)
      const count = countNodes(ast)
      if (count > LIMITS.MAX_EXPR_NODES) {
        fail('E_LIMIT', `变量 ${def.key} 表达式节点数 ${count} 超过上限 ${LIMITS.MAX_EXPR_NODES}`, { variableId: def.id })
      }
    }
    const c = { ...def, ast, refs }
    byKey.set(def.key, c)
    return c
  })
  return { compiled, byKey }
}

function countNodes(n) {
  if (!n || typeof n !== 'object') return 0
  let x = 1
  for (const k of Object.keys(n)) {
    if (k === 'pos') continue
    const v = n[k]
    if (Array.isArray(v)) x += v.reduce((s, i) => s + countNodes(i), 0)
    else if (v && typeof v === 'object' && v.t) x += countNodes(v)
  }
  return x
}

// 构建依赖图并检测循环。返回拓扑序（被依赖者在前）。
// snapshotKeys：快照根字段（数据源取数结果），它们是叶子，无出边。
export function buildGraph(compiled, snapshotKeys = new Set()) {
  const map = new Map(compiled.map((c) => [c.key, c]))
  const edges = new Map() // key -> 它引用的变量
  for (const c of compiled) {
    const deps = new Set()
    for (const r of c.refs) {
      if (map.has(r)) deps.add(r)
      else if (!snapshotKeys.has(r)) {
        // 引用了既不是变量也不是快照字段的名字
        throw new ExpressionError('E_UNDEFINED_VAR', `变量 ${c.key} 引用了未定义的名字 "${r}"`, {
          variableId: c.id, refVar: r, snippet: c.expr, phase: 'graph',
        })
      }
    }
    edges.set(c.key, [...deps])
  }

  // DFS 三色检测 + 记录环
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map(compiled.map((c) => [c.key, WHITE]))
  const order = []
  const cyclePath = []

  const visit = (key, stack) => {
    color.set(key, GRAY)
    stack.push(key)
    for (const dep of edges.get(key) || []) {
      if (color.get(dep) === GRAY) {
        const i = stack.indexOf(dep)
        const cyc = stack.slice(i).concat(dep)
        throw new ExpressionError('E_CYCLE', `检测到变量循环依赖：${cyc.join(' -> ')}`, {
          variableId: map.get(key).id, cycle: cyc, phase: 'graph',
        })
      }
      if (color.get(dep) === WHITE) visit(dep, stack)
    }
    stack.pop()
    color.set(key, BLACK)
    order.push(key)
  }
  for (const c of compiled) if (color.get(c.key) === WHITE) visit(c.key, cyclePath)

  // 深度校验（嵌套依赖）
  const depth = new Map()
  for (const key of order) {
    let d = 0
    for (const dep of edges.get(key) || []) d = Math.max(d, (depth.get(dep) || 0) + 1)
    depth.set(key, d)
    if (d > LIMITS.MAX_DEPTH) {
      throw new ExpressionError('E_LIMIT', `变量 ${key} 依赖深度 ${d} 超过上限 ${LIMITS.MAX_DEPTH}`, {
        variableId: map.get(key).id, phase: 'graph',
      })
    }
  }
  return { order: order.map((k) => map.get(k)), edges, depth }
}
