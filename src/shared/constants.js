// 全局固定规则与求值规模上限（常量，不允许模板覆盖）
export const RULES = Object.freeze({
  timezone: 'Asia/Shanghai', // 日期时区固定规则
  numberLocale: 'zh-CN',
  numberMaxFractionDigits: 2, // 数字格式：千分位 + 最多 2 位小数
  dateFormat: 'YYYY-MM-DD',
  dateTimeFormat: 'YYYY-MM-DD HH:mm:ss',
  maxVariables: 200,
  maxRefsPerVar: 20,
  maxExpressionNodes: 200, // 单条表达式 AST 节点上限
  maxEvalSteps: 10000, // 单次任务总求值步数
  maxDepth: 32, // 依赖图最大深度，防嵌套失控
  maxTemplateLength: 100_000,
})

// 受支持的变量类型（强类型，禁止隐式跨类型运算）
export const TYPES = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
  DATETIME: 'datetime',
  URL: 'url',
})

export const STATE_MISSING = 'missing' // 缺值：未取到 / 无权限 / 未输入
export const STATE_VALUE = 'value' // 有值（包含空串 ""）
export const STATE_ERROR = 'error'
