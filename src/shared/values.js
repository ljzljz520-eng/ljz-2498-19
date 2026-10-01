import { RULES, TYPES, STATE_MISSING, STATE_VALUE } from './constants.js'
import { EvalError } from './diagnostics.js'

// MISSING 单例：区分“缺值”与“空串”。空串是正常 string 值。
export const MISSING = Symbol.for('typedvar.missing')

export function isMissing(v) {
  return v == null || v.__missing === true
}

// 运行时值：{ t: 类型, v: JS 值（MISSING 表示缺值）, sensitive?, denied? }
export function rv(t, v, extra = {}) {
  return { t, v, ...extra }
}
export function missingRv(extra = {}) {
  return { t: null, v: MISSING, __missing: true, ...extra }
}

// ---------- 数字格式固定规则 ----------
const nf = new Intl.NumberFormat(RULES.numberLocale, {
  maximumFractionDigits: RULES.numberMaxFractionDigits,
  useGrouping: true,
})
export function formatNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new EvalError('INVALID_NUMBER', `无法把 ${String(n)} 按数字规则渲染`)
  }
  return nf.format(n)
}

// ---------- 日期/时间固定规则 ----------
function pad(x, w = 2) {
  return String(x).padStart(w, '0')
}
function partsInZone(date) {
  // 使用固定时区，禁止依赖服务器本地时区
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: RULES.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]))
  return {
    Y: p.year,
    M: p.month,
    D: p.day,
    h: p.hour === '24' ? '00' : p.hour,
    m: p.minute,
    s: p.second,
  }
}
export function formatDate(d) {
  const p = partsInZone(d)
  return `${p.Y}-${p.M}-${p.D}`
}
export function formatDateTime(d) {
  const p = partsInZone(d)
  return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}`
}

// 严格日期解析：只接受 YYYY-MM-DD，且必须是真实日历日（拒绝 2024-02-30）
export function parseDate(raw) {
  if (raw instanceof Date) return new Date(dateUtc(raw))
  const s = String(raw).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw new EvalError('INVALID_DATE', `非法日期（要求 ${RULES.dateFormat}）: ${s}`)
  const [, y, mo, da] = m.map(Number)
  const d = new Date(Date.UTC(y, mo - 1, da))
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
    throw new EvalError('INVALID_DATE', `非法日历日期: ${s}`)
  }
  return d
}
function dateUtc(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
export function addDays(d, n) {
  const r = new Date(d.getTime() + Math.trunc(n) * 86400000)
  if (Math.abs(n) > 100000) throw new EvalError('DATE_OUT_OF_RANGE', '日期加减天数超出 ±100000')
  return r
}

// datetime：epoch 毫秒 / ISO 字符串；非法直接报错（验收“非法日期”）
export function parseDateTime(raw) {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new EvalError('INVALID_DATETIME', '非法时间戳')
    return new Date(raw.getTime())
  }
  const s = String(raw).trim()
  const n = Number(s)
  let d
  if (s !== '' && Number.isFinite(n) && /^-?\d+$/.test(s)) d = new Date(n)
  else {
    d = new Date(s)
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      throw new EvalError('INVALID_DATETIME', `非法日期时间（要求 ISO 或 epoch 毫秒）: ${s}`)
    }
  }
  if (Number.isNaN(d.getTime())) throw new EvalError('INVALID_DATETIME', `非法日期时间: ${s}`)
  return d
}

export function toNumber(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new EvalError('INVALID_NUMBER', '数字必须有限')
    return raw
  }
  const s = String(raw).trim().replace(/,/g, '')
  const n = Number(s)
  if (!Number.isFinite(n) || s === '') throw new EvalError('INVALID_NUMBER', `非法数字: ${raw}`)
  return n
}

// 原始输入/数据源值 -> 强类型运行时值（校验期即可发现非法日期/数字）
export function coerce(type, raw) {
  switch (type) {
    case TYPES.STRING:
      return rv(TYPES.STRING, String(raw))
    case TYPES.BOOLEAN: {
      if (typeof raw === 'boolean') return rv(TYPES.BOOLEAN, raw)
      if (raw === 'true') return rv(TYPES.BOOLEAN, true)
      if (raw === 'false') return rv(TYPES.BOOLEAN, false)
      throw new EvalError('INVALID_BOOLEAN', `非法布尔值: ${raw}`)
    }
    case TYPES.NUMBER:
      return rv(TYPES.NUMBER, toNumber(raw))
    case TYPES.DATE:
      return rv(TYPES.DATE, parseDate(raw))
    case TYPES.DATETIME:
      return rv(TYPES.DATETIME, parseDateTime(raw))
    case TYPES.URL: {
      const s = String(raw)
      validateUrl(s)
      return rv(TYPES.URL, s)
    }
    default:
      throw new EvalError('UNKNOWN_TYPE', `未知变量类型: ${type}`)
  }
}

// ---------- URL 安全规则（链接上下文） ----------
export function validateUrl(s) {
  if (typeof s !== 'string' || s.trim() === '') throw new EvalError('UNSAFE_URL', '空链接')
  if (/[\s"<>\\^`{|}]/.test(s)) throw new EvalError('UNSAFE_URL', `链接含非法字符: ${s}`)
  let u
  try {
    u = new URL(s)
  } catch {
    throw new EvalError('UNSAFE_URL', `非法 URL: ${s}`)
  }
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) {
    throw new EvalError('UNSAFE_URL', `仅允许 http/https/mailto，拒绝协议: ${u.protocol}`)
  }
  return u.href
}

// ---------- 渲染为可见字符串（固定规则；默认值规则在外层应用） ----------
export function toDisplay(value) {
  if (isMissing(value)) return STATE_MISSING
  switch (value.t) {
    case TYPES.STRING:
      return { state: STATE_VALUE, text: value.v } // 空串原样保留，不被当作缺值
    case TYPES.NUMBER:
      return { state: STATE_VALUE, text: formatNumber(value.v) }
    case TYPES.BOOLEAN:
      return { state: STATE_VALUE, text: value.v ? 'true' : 'false' }
    case TYPES.DATE:
      return { state: STATE_VALUE, text: formatDate(value.v) }
    case TYPES.DATETIME:
      return { state: STATE_VALUE, text: formatDateTime(value.v) }
    case TYPES.URL:
      return { state: STATE_VALUE, text: value.v }
    default:
      return { state: STATE_MISSING, text: STATE_MISSING }
  }
}

// ---------- 敏感值脱敏（日志与共享预览统一使用） ----------
export function maskText(s) {
  if (s === '') return '' // 空串不掩盖为缺值
  if (s.length <= 2) return '*'.repeat(s.length || 3)
  if (s.length <= 8) return s[0] + '***'
  return s.slice(0, 2) + '***' + s.slice(-1)
}
export function maskDisplay(value) {
  const d = toDisplay(value)
  if (d.state === STATE_MISSING) return d
  return { state: STATE_VALUE, text: maskText(d.text), masked: true }
}

// JSON 序列化时把 Date 转回规范字符串（快照落库）
export function serializeValue(value) {
  if (isMissing(value)) return { missing: true, denied: !!value.denied }
  const out = { type: value.t }
  if (value.t === TYPES.DATE) out.value = formatDate(value.v)
  else if (value.t === TYPES.DATETIME) out.value = value.v.getTime()
  else out.value = value.v
  if (value.sensitive) out.sensitive = true
  return out
}
export function deserializeValue(o) {
  if (!o || o.missing) return missingRv(o?.denied ? { denied: true } : {})
  return coerce(o.type, o.value)
}
