// 模板扫描与替换。
// 语法：{{ var }} 与 {{ var | url }}（链接目标上下文）。
// 输出三件东西：纯展开文稿、片段映射（源变量 -> 可见片段区间）、替换诊断。
// 绝不把模板当脚本执行：这里只做标记切分 + 安全转义。

import { fail } from './errors.js'

export const VAR_OPEN = '{{'
export const VAR_CLOSE = '}}'

// 脱敏占位：不用裸 ***（独占一行会被 Markdown 当成分割线）
export const REDACTION_PLACEHOLDER = '〔已脱敏〕'

export function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// href / URL 上下文：先做安全协议白名单，再做 URL 编码转义
const SAFE_PROTO = /^https?:\/\//i
export function escapeUrl(s) {
  const raw = String(s)
  if (raw === '') return ''
  // 拒绝 javascript: / data: / 协议相对 URL 等
  if (/^\s*javascript:/i.test(raw) || /^\s*data:/i.test(raw) || /^\s*vbscript:/i.test(raw)) {
    fail('E_UNSAFE_URL', `不安全的链接协议：${raw.slice(0, 24)}…`)
  }
  if (!SAFE_PROTO.test(raw) && !raw.startsWith('/') && !raw.startsWith('#') && !raw.startsWith('mailto:')) {
    fail('E_UNSAFE_URL', `链接仅允许 http(s)/站内路径/mailto，收到：${raw.slice(0, 24)}…`)
  }
  // 先编码引号与空白，再交给属性层 HTML 转义
  return encodeURI(raw).replace(/'/g, '%27')
}

// 扫描模板，返回 token 序列：[{t:'text',value} | {t:'var', key, ctx, raw, pos}]
export function scanTemplate(source) {
  const tokens = []
  let i = 0
  let textStart = 0
  const pushText = (end) => {
    if (end > textStart) tokens.push({ t: 'text', value: source.slice(textStart, end) })
  }
  while (i < source.length) {
    const open = source.indexOf(VAR_OPEN, i)
    if (open === -1) break
    const close = source.indexOf(VAR_CLOSE, open + 2)
    if (close === -1) {
      fail('E_SYNTAX', '存在未闭合的 {{（缺少 }}）', { pos: open, snippet: source.slice(open, open + 20) })
    }
    const inner = source.slice(open + 2, close).trim()
    if (inner === '') fail('E_SYNTAX', '空变量标记 {{ }}', { pos: open })
    let key = inner
    let ctx = 'text'
    const bar = inner.indexOf('|')
    if (bar !== -1) {
      key = inner.slice(0, bar).trim()
      const mod = inner.slice(bar + 1).trim()
      if (mod !== 'url' && mod !== 'html') {
        fail('E_SYNTAX', `未知上下文修饰符 "${mod}"，仅支持 |url / |html`, { pos: open, snippet: inner })
      }
      ctx = mod === 'url' ? 'url' : 'html'
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      fail('E_SYNTAX', `变量标记中的名字非法："${inner}"`, { pos: open, snippet: inner })
    }
    pushText(open)
    tokens.push({ t: 'var', key, ctx, raw: inner, pos: open, end: close + 2 })
    i = close + 2
    textStart = i
  }
  pushText(source.length)
  return tokens
}

// 展开模板。
// resolve(key) -> { text, missing, secret, ... } （通常来自 valueToDisplay）
// options: { redactSecrets, onMissing }
// 返回 { text, fragments:[{key, start, end, raw, ctx, missing, secret, redacted}] , diagnostics:[] }
export function expandTemplate(source, resolve, options = {}) {
  const tokens = scanTemplate(source)
  const fragments = []
  const diagnostics = []
  let out = ''
  for (const tok of tokens) {
    if (tok.t === 'text') { out += tok.value; continue }
    let disp
    try {
      disp = resolve(tok.key)
    } catch (e) {
      diagnostics.push({ level: 'error', code: e.code || 'E_RESOLVE', variableKey: tok.key, pos: tok.pos, message: e.message })
      disp = { text: '', missing: true, error: true }
    }
    if (disp == null) disp = { text: '', missing: true }

    let rendered = disp.text ?? ''
    let redacted = false
    if (disp.missing) {
      diagnostics.push({ level: disp.error ? 'error' : 'warning', code: 'E_MISSING', variableKey: tok.key, pos: tok.pos, message: `变量 ${tok.key} 缺值${disp.reason ? `（${disp.reason}）` : ''}` })
      rendered = options.onMissing ? options.onMissing(tok.key, disp) : ''
    } else if (tok.ctx === 'url') {
      try {
        rendered = escapeUrl(rendered)
      } catch (e) {
        diagnostics.push({ level: 'error', code: e.code, variableKey: tok.key, pos: tok.pos, message: e.message })
        rendered = '#blocked-url'
      }
    } else if (tok.ctx === 'html') {
      // |html 是"受信富文本"显式出口；产品策略默认不提供，这里仍转义以防注入
      rendered = escapeHtmlText(rendered)
    }
    if (disp.secret) {
      if (options.redactSecrets) { rendered = REDACTION_PLACEHOLDER; redacted = true }
    }
    // 文本上下文：默认 HTML 转义（在 markdown 渲染前是纯文本，真正转义发生在渲染层；
    // 这里保留原始文本，转义由 renderExpanded 按上下文完成 —— 但片段 mapping 已确定）
    const start = out.length
    out += rendered
    fragments.push({ key: tok.key, start, end: out.length, raw: tok.raw, ctx: tok.ctx, missing: !!disp.missing, secret: !!disp.secret, redacted })
  }
  return { text: out, fragments, diagnostics }
}
