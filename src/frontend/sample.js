// 网页示例值：三态输入。
// 状态：
//   'value'   —— 有值（输入框文本，空串即"显式空字符串"）
//   'empty'   —— 显式空串 ''（输入框清空时仍明确表达空串）
//   'missing' —— 缺值（字段在快照数据中不存在）
// 变量自身可设示例值（仅对无表达式的直接映射变量生效，且会覆盖根数据）。
// 另有"数据源示例 JSON"用于 order/hr 等根字段。

export function setPath(obj, dotted, value) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : (cur[k] = {})
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}
export function hasPath(obj, dotted) {
  const parts = dotted.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return false
    cur = cur[p]
  }
  return true
}

// 由根数据 JSON + 每个直接映射变量的三态示例，构造快照 data
export function buildSampleData(rootJsonText, defs, varSamples) {
  let data = {}
  const jsonDiags = []
  if (rootJsonText && rootJsonText.trim()) {
    try {
      const parsed = JSON.parse(rootJsonText)
      if (isObject(parsed)) data = parsed
    } catch (e) {
      jsonDiags.push({ level: 'error', code: 'E_SAMPLE_JSON', message: '示例 JSON 解析失败：' + e.message })
    }
  }
  // 深拷贝，避免就地改
  data = JSON.parse(JSON.stringify(isObject(data) ? data : {}))

  for (const def of defs) {
    const s = varSamples[def.key]
    if (!s) continue
    if (s.state === 'missing') continue // 缺值：不写入
    let value
    if (s.state === 'empty') value = ''
    else value = coerceSample(s.text, def.type)
    const target = def.sourceId || def.key
    // 目标可能是 order.customer.firstName 这样的点路径
    if (target.includes('.') || defs.some((d) => d.key === target)) {
      // 若指向的是数据源路径，写入 data；若是另一变量（无表达式时无效），仍按点路径写 data
      setPath(data, target, value)
    } else {
      data[target] = value
    }
  }
  return { data, jsonDiags }
}

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v) }

function coerceSample(text, type) {
  if (type === 'number') {
    const n = Number(String(text).replace(/,/g, ''))
    return Number.isFinite(n) ? n : text
  }
  if (type === 'boolean') return text === 'true'
  return text
}

export const DEFAULT_SAMPLE_JSON = JSON.stringify({
  order: {
    orderNo: 'SO-2026-1001',
    total: 1234567.5,
    link: 'https://example.com/orders/SO-2026-1001',
    placedAt: '2026-09-30T20:30:00 UTC',
    customer: { firstName: 'Ana', lastName: 'Lee', idNo: '110101199001011234', phone: '13812345678', email: 'ana@example.com' },
    items: [{ sku: 'A-1', qty: 2 }],
  },
  hr: { salary: 88888, level: 'P6' },
}, null, 2)
