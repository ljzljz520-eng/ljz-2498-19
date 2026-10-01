import { lex } from './lexer.js'
import { fail } from '../errors.js'

// Pratt 解析器：产生纯数据 AST（可序列化、可静态分析依赖）。
// 仅支持：字面量、变量引用、成员访问（点语法 + 索引）、白名单函数、
// 算术 / 比较 / 逻辑（短路）、三元。禁止：赋值、调用任意属性、new、模板字符串求值。

export function parseExpression(src, location = {}) {
  if (typeof src !== 'string' || src.trim() === '') {
    fail('E_EMPTY_EXPR', '表达式为空', location)
  }
  const tokens = lex(src, location)
  let p = 0
  const peek = () => tokens[p]
  const next = () => tokens[p++]
  const around = (pos) => src.slice(Math.max(0, pos - 8), pos + 8)
  const expect = (type, msg) => {
    if (tokens[p].type !== type) {
      fail('E_SYNTAX', msg || `期望 ${type}，实际 ${tokens[p].type}`, { ...location, pos: tokens[p].pos, snippet: around(tokens[p].pos) })
    }
    return tokens[p++]
  }

  function parseRoot() {
    const node = parseTernary(0)
    if (peek().type !== 'EOF') {
      fail('E_SYNTAX', `表达式尾部存在无法解析的内容 "${peek().value ?? peek().type}"`, {
        ...location, pos: peek().pos, snippet: around(peek().pos),
      })
    }
    return node
  }

  // 成员访问链：a.b[0].c
  function parsePostfix(cur) {
    for (;;) {
      if (peek().type === 'DOT') {
        next()
        if (peek().type !== 'IDENT') fail('E_SYNTAX', '点号后必须是标识符', { ...location, pos: peek().pos })
        const prop = next().value
        cur = { t: 'member', obj: cur, key: { t: 'literal', v: prop } }
      } else if (peek().type === 'LBRACKET') {
        next()
        const key = parseTernary(0)
        expect('RBRACKET', '缺少 ]')
        cur = { t: 'member', obj: cur, key }
      } else break
    }
    if (cur.t === 'call' && cur.callee.t !== 'func') {
      // 被调用者必须是白名单函数，绝不能调用数据上的方法
      fail('E_SECURITY', '仅允许调用白名单函数', location)
    }
    return cur
  }

  function parsePrimary() {
    const tok = peek()
    switch (tok.type) {
      case 'NUMBER': next(); return { t: 'literal', v: tok.value }
      case 'STRING': next(); return { t: 'literal', v: tok.value }
      case 'TRUE': next(); return { t: 'literal', v: true }
      case 'FALSE': next(); return { t: 'literal', v: false }
      case 'NULL': next(); return { t: 'literal', v: null }
      case 'FUNC': {
        next()
        expect('LPAREN', '函数名后应为 (')
        const args = []
        if (peek().type !== 'RPAREN') {
          args.push(parseTernary(0))
          while (peek().type === 'COMMA') { next(); args.push(parseTernary(0)) }
        }
        expect('RPAREN', '缺少 )')
        return parsePostfix({ t: 'call', callee: { t: 'func', name: tok.value }, args })
      }
      case 'IDENT':
        next()
        return parsePostfix({ t: 'var', name: tok.value, pos: tok.pos })
      case 'LPAREN': {
        next()
        const node = parseTernary(0)
        expect('RPAREN', '缺少 )')
        return parsePostfix(node)
      }
      case 'MINUS':
        next()
        return { t: 'unary', op: '-', arg: parsePrimary() }
      case 'BANG':
      case 'NOT':
        next()
        return { t: 'unary', op: '!', arg: parsePrimary() }
      default:
        fail('E_SYNTAX', `意外的符号 "${tok.value ?? tok.type}"`, {
          ...location, pos: tok.pos, snippet: around(tok.pos),
        })
    }
  }

  const BIN_PREC = {
    OR: 1, AND: 2,
    EQEQ: 3, NEQ: 3,
    LT: 4, GT: 4, LTE: 4, GTE: 4,
    PLUS: 5, MINUS: 5,
    STAR: 6, SLASH: 6, PERCENT: 6,
  }

  function parseBinary(minPrec) {
    let left = parsePrimary()
    for (;;) {
      const tt = peek().type
      const prec = BIN_PREC[tt]
      if (!prec || prec < minPrec) break
      next()
      const right = parseBinary(prec + 1)
      left = { t: 'bin', op: tt, l: left, r: right }
    }
    return left
  }

  function parseTernary(minPrec) {
    let node = parseBinary(minPrec ?? 1)
    if (peek().type === 'QMARK') {
      next()
      const yes = parseTernary(0)
      expect('COLON', '三元表达式缺少 :')
      const no = parseTernary(0)
      node = { t: 'tri', cond: node, yes, no }
    }
    return node
  }

  return parseRoot()
}

// 静态收集 AST 中引用的根变量名
export function collectReferences(ast) {
  const refs = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.t === 'var') refs.add(n.name)
    for (const k of Object.keys(n)) {
      if (k === 'pos') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object' && v.t) walk(v)
    }
  }
  walk(ast)
  return [...refs]
}
