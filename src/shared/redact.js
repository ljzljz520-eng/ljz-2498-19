// 敏感值脱敏：日志与共享预览统一入口。
// 规则：整串 -> '***'；保留首尾各 1 位（长度>4）；手机号/邮箱按形态打码；绝不输出明文。

import { isSecret } from './types.js'

export function maskValue(plain) {
  const s = String(plain)
  if (s === '') return ''
  if (s.length <= 4) return '***'
  // 邮箱
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
    const [name, domain] = s.split('@')
    return `${name[0]}***@${domain}`
  }
  // 11 位手机号
  if (/^1\d{10}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(7)
  return s[0] + '***' + s[s.length - 1]
}

// 把求值结果对象（values Map 的快照）中的敏感变量值替换为掩码串
export function redactValues(values, secretOwners, defs) {
  const out = new Map()
  for (const [key, v] of values) {
    const def = defs.find((d) => d.key === key)
    if (isSecret(v) || secretOwners?.has?.(def?.id) || def?.sensitive) {
      const plain = isSecret(v) ? v.plain : v
      out.set(key, { __redacted: true, mask: maskValue(plain) })
    } else {
      out.set(key, safeSerializable(v))
    }
  }
  return out
}

export function safeSerializable(v) {
  if (v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? String(val) : val)))
}

// 结构化日志：渲染任务的日志行，敏感字段在写入前脱敏
export function buildLogLine(event, payload, { redact = true } = {}) {
  const clone = safeSerializable(payload)
  if (redact && clone && typeof clone === 'object') {
    for (const k of Object.keys(clone)) {
      if (/secret|password|idno|salary|token|phone|email/i.test(k)) {
        clone[k] = maskValue(clone[k])
      }
    }
  }
  return JSON.stringify({ ts: new Date().toISOString(), event, ...clone })
}
