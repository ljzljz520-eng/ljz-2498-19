import { fail } from '../errors.js'

// 受限表达式词法分析。模板永不当作脚本：这里只识别数据访问/字面量/受限运算符
const SINGLE = new Map([
  ['(', 'LPAREN'], [')', 'RPAREN'], ['.', 'DOT'], [',', 'COMMA'],
  ['?', 'QMARK'], [':', 'COLON'], ['[', 'LBRACKET'], [']', 'RBRACKET'],
  ['+', 'PLUS'], ['-', 'MINUS'], ['*', 'STAR'], ['/', 'SLASH'],
  ['%', 'PERCENT'], ['!', 'BANG'], ['<', 'LT'], ['>', 'GT'],
])

const KEYWORDS = new Set([
  'true', 'false', 'null', 'in', 'and', 'or', 'not',
])

const FUNCS = new Set([
  'date', 'number', 'upper', 'lower', 'trim', 'concat',
  'ifNull', 'default', 'money', 'len', 'now', 'today', 'numberFormat',
])

export function isIdentifierStart(ch) {
  return /[A-Za-z_$一-鿿]/.test(ch)
}
export function isIdentifierPart(ch) {
  return /[A-Za-z0-9_$一-鿿]/.test(ch)
}

export function lex(src, location = {}) {
  const tokens = []
  let i = 0
  const push = (type, value, pos) => tokens.push({ type, value, pos })
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }

    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      let val = ''
      i += 1
      let closed = false
      while (i < src.length) {
        const c = src[i]
        if (c === '\\') {
          const n = src[i + 1]
          val += n === 'n' ? '\n' : n === 't' ? '\t' : n === quote ? quote : n === '\\' ? '\\' : (n ?? '')
          i += 2
          continue
        }
        if (c === quote) { i += 1; closed = true; break }
        val += c
        i += 1
      }
      if (!closed) fail('E_SYNTAX', '字符串未闭合', { ...location, pos: start, snippet: src.slice(start, start + 20) })
      push('STRING', val, start)
      continue
    }

    if (/[0-9]/.test(ch)) {
      const start = i
      while (i < src.length && /[0-9]/.test(src[i])) i += 1
      if (src[i] === '.' && /[0-9]/.test(src[i + 1])) {
        i += 1
        while (i < src.length && /[0-9]/.test(src[i])) i += 1
      }
      push('NUMBER', Number(src.slice(start, i)), start)
      continue
    }

    if (isIdentifierStart(ch)) {
      const start = i
      while (i < src.length && isIdentifierPart(src[i])) i += 1
      const word = src.slice(start, i)
      if (KEYWORDS.has(word)) push(word.toUpperCase(), word, start)
      else if (FUNCS.has(word)) push('FUNC', word, start)
      else push('IDENT', word, start)
      continue
    }

    // 双字符运算符
    const two = src.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      push(two === '==' ? 'EQEQ' : two === '!=' ? 'NEQ' : two === '<=' ? 'LTE' : 'GTE', two, i)
      i += 2
      continue
    }
    if (two === '&&' || two === '||') {
      push(two === '&&' ? 'AND' : 'OR', two, i)
      i += 2
      continue
    }
    if (SINGLE.has(ch)) {
      push(SINGLE.get(ch), ch, i)
      i += 1
      continue
    }
    fail('E_SYNTAX', `非法字符 "${ch}"`, { ...location, pos: i, snippet: src.slice(Math.max(0, i - 8), i + 8) })
  }
  push('EOF', null, src.length)
  return tokens
}

export { FUNCS }
