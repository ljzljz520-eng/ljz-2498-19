// 诊断对象：必须定位到“变量”与“引用节点（表达式位置 / 模板占位位置）”
let seq = 0
export function diag(level, code, message, location = {}) {
  return {
    id: `d${(seq += 1)}`,
    level, // error | warning
    code,
    message,
    variable: location.variable ?? null, // 变量键
    node: location.node ?? null, // 引用节点：{ kind:'expr'|'placeholder', pos, line, column, text }
  }
}

export class EvalError extends Error {
  constructor(code, message, location = {}) {
    super(message)
    this.code = code
    this.location = location
  }
}
