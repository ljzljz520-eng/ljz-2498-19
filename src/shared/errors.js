// 统一诊断模型：任何求值失败都能定位到「变量 + 引用节点」
export class ExpressionError extends Error {
  constructor(code, message, location = null) {
    super(message)
    this.name = 'ExpressionError'
    this.code = code // E_SYNTAX / E_UNDEFINED_VAR / E_TYPE ...
    // location: { variableId?, path?, pos?, snippet?, phase? }
    this.location = location || {}
  }
  withLocation(extra) {
    Object.assign(this.location, extra)
    return this
  }
}

export class AccessDeniedError extends Error {
  constructor(variableId, fieldPath, principal) {
    super(`principal "${principal}" 无权读取字段 ${fieldPath}`)
    this.name = 'AccessDeniedError'
    this.variableId = variableId
    this.fieldPath = fieldPath
    this.principal = principal
  }
}

export function fail(code, message, location) {
  throw new ExpressionError(code, message, location)
}
