// 类型化变量的运行时值模型
//
// 关键区分（需求：区分缺值与空串）：
//   MISSING  —— 数据中根本没有该字段 / 变量未提供（语义为"缺值"）
//   ''       —— 显式空字符串（语义为"有值但为空"）
//   null     —— 显式 SQL NULL / JSON null
// 三者在默认值规则中表现不同，绝不能互相吞并。

export const TYPES = ['text', 'number', 'boolean', 'datetime', 'date', 'url']

export class Missing {
  constructor(reason = 'MISSING') {
    this.reason = reason // MISSING | NO_ACCESS | FAILED
  }
  toString() { return '' }
}
export const MISSING = new Missing()
export const isMissing = (v) => v instanceof Missing

// 带时区的日期时间（内部一律存 epoch 毫秒，显示固定按 IANA 时区格式化）
export class DateTimeValue {
  constructor(epochMs, zone = 'UTC', kind = 'datetime') {
    this.epochMs = epochMs
    this.zone = zone
    this.kind = kind // 'date' | 'datetime'
  }
}

// 敏感标记：求值结果包裹它，日志/共享预览据此脱敏
export class SecretValue {
  constructor(plain, variableId) {
    this.plain = plain
    this.variableId = variableId
  }
  toString() { return this.plain }
}
export const isSecret = (v) => v instanceof SecretValue

export function typeOfValue(v) {
  if (isMissing(v)) return 'missing'
  if (v === null) return 'null'
  if (v instanceof SecretValue) return typeOfValue(v.plain)
  if (typeof v === 'string') return 'text'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (v instanceof DateTimeValue) return v.kind
  return 'object'
}
