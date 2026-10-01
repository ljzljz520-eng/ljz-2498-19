// 固定规则：日期时区 / 数字格式 / 默认值。规则集中在此，前后端共用，禁止在各处自行约定。

import { DateTimeValue, MISSING, isMissing } from './types.js'
import { fail } from './errors.js'

export const DEFAULT_ZONE = 'Asia/Shanghai'
export const NORMALIZE_ZONES = {
  CST: 'Asia/Shanghai', CDT: 'America/Chicago', PDT: 'America/Los_Angeles',
  UTC: 'UTC', GMT: 'UTC', Z: 'UTC',
}
const VALID_ZONES = new Set([
  'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
])

export function assertValidZone(zone) {
  if (!VALID_ZONES.has(nowZone(zone))) {
    fail('E_TIMEZONE', `不支持的时区 "${zone}"，允许：${[...VALID_ZONES].join(', ')}`)
  }
}
function nowZone(zone) { return NORMALIZE_ZONES[zone] || zone }
export function normalizeZone(zone) {
  const z = NORMALIZE_ZONES[zone] || zone || DEFAULT_ZONE
  assertValidZone(z)
  return z
}

// ---- 日期解析（严格，非法日期直接报错而非回退成当前时间/Invalid 串）----
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\s*([A-Za-z/]+|Z))?$/

export function parseDateTime(input, zone = DEFAULT_ZONE) {
  if (input instanceof DateTimeValue) return input
  if (input == null || isMissing(input)) fail('E_DATE', '日期输入缺值，无法构造日期')
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) fail('E_DATE', `非法时间戳 ${input}`)
    return new DateTimeValue(input, normalizeZone(zone), 'datetime')
  }
  const raw = String(input).trim()
  const m = DATE_RE.exec(raw)
  if (!m) fail('E_DATE', `非法日期格式 "${raw}"，应为 YYYY-MM-DDTHH:mm:ss<时区>`)
  const [, y, mo, d, hh, mm, ss, zRaw] = m
  const z = normalizeZone(zRaw || zone)
  const parts = {
    year: +y, month: +mo, day: +d,
    hour: hh ? +hh : 0, minute: mm ? +mm : 0, second: ss ? +ss : 0,
  }
  // 用 Intl 得到该时区的偏移，避免自己实现 tz 数据库；先按"无时区时间"找到对应 UTC 瞬间
  // 最近的两个候选 UTC 瞬间取偏移（处理 DST 跳变附近）
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = zoneOffsetMs(z, guess)
  let epoch = guess - offset
  // 二次校正（DST）
  const offset2 = zoneOffsetMs(z, epoch)
  if (offset2 !== offset) epoch = guess - offset2
  const back = formatParts(epoch, z)
  if (
    back.year !== parts.year || back.month !== parts.month || back.day !== parts.day ||
    back.hour !== parts.hour || back.minute !== parts.minute || back.second !== parts.second
  ) {
    // 例如 2021-03-14 02:30 在美国 DST 跳变中不存在
    fail('E_DATE', `日期 "${raw}" 在时区 ${z} 不存在（可能落入夏令时跳变）`)
  }
  // 日历校验：2 月 30 日这类
  if (+mo < 1 || +mo > 12) fail('E_DATE', `非法月份 "${raw}"`)
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()
  if (parts.day < 1 || parts.day > daysInMonth) fail('E_DATE', `非法日期 "${raw}"：该月没有 ${parts.day} 日`)
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) fail('E_DATE', `非法时间分量 "${raw}"`)
  return new DateTimeValue(epoch, z, hh ? 'datetime' : 'date')
}

function zoneOffsetMs(zone, utcGuess) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]))
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour) % 24, +parts.minute, +parts.second)
  return asUTC - utcGuess
}

function formatParts(epoch, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(epoch)).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second }
}

const PAD2 = (n) => String(n).padStart(2, '0')

export function formatDateTime(value, zone = DEFAULT_ZONE) {
  const dt = parseDateTime(value, value instanceof DateTimeValue ? value.zone : zone)
  // datetime 一律在固定输出时区（默认 Asia/Shanghai）呈现；date 是无时点语义的日历日期，按其声明时区呈现
  const outZone = dt.kind === 'date' ? dt.zone : normalizeZone(zone)
  const p = formatParts(dt.epochMs, outZone)
  const base = `${p.year}-${PAD2(p.month)}-${PAD2(p.day)}`
  if (dt.kind === 'date') return base
  return `${base} ${PAD2(p.hour)}:${PAD2(p.minute)}:${PAD2(p.second)} ${outZone}`
}

// ---- 数字格式（固定：千分位 + 最多 N 位小数，四舍五入；货币按币种固定小数位）----
export const CURRENCY_DIGITS = { CNY: 2, USD: 2, EUR: 2, JPY: 0 }
export function formatNumber(value, digits = 2) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) fail('E_NUMBER', `无法格式化数字 ${String(value)}`)
  const d = Math.max(0, Math.min(6, Math.trunc(digits)))
  const neg = n < 0
  const [int, dec] = Math.abs(n).toFixed(d).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${dec ? '.' + dec : ''}`
}
export function formatMoney(value, currency = 'CNY') {
  const cur = String(currency).toUpperCase()
  const digits = CURRENCY_DIGITS[cur]
  if (digits === undefined) fail('E_NUMBER', `不支持的币种 ${currency}`)
  return `${cur} ${formatNumber(value, digits)}`
}
export function parseNumberStrict(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) fail('E_NUMBER', `非法数字 ${input}`)
    return input
  }
  if (input == null || isMissing(input)) fail('E_NUMBER', '数字输入缺值')
  const cleaned = String(input).trim().replace(/,/g, '')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) fail('E_NUMBER', `非法数字 "${input}"`)
  return Number(cleaned)
}

// ---- 默认值规则（缺值与空串严格区分）----
// MISSING / NO_ACCESS / FAILED -> 使用默认值
// 显式 null             -> 使用默认值（NULL 被视为"无值"）
// 显式空串 ''           -> 保留 ''（空串是有意义的值，不用默认值覆盖）
// false / 0             -> 保留（这些是有效值）
export function applyDefault(value, defaultValue) {
  if (isMissing(value) || value === null) {
    return defaultValue === undefined ? MISSING : defaultValue
  }
  return value
}

// 目标时区的当前时刻 / 当天零点（date 语义）
export function nowDateTime(zone = DEFAULT_ZONE) {
  const z = normalizeZone(zone)
  return new DateTimeValue(Date.now(), z, 'datetime')
}
export function todayDate(zone = DEFAULT_ZONE) {
  const z = normalizeZone(zone)
  // 取该时区下"现在"的日历日期，再构造其 00:00 的 UTC 瞬间
  const now = Date.now()
  const p = formatParts(now, z)
  const midnightAsUTC = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0)
  const offset = zoneOffsetMs(z, midnightAsUTC)
  return new DateTimeValue(midnightAsUTC - offset, z, 'date')
}
