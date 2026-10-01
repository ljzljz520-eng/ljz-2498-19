// 模拟外部数据源。真实环境里这是 RPC/SQL 取数层；这里用内存表模拟，
// 并提供「更新中(updating)」状态与版本号，用于渲染任务恢复验收。
//
// 关键承诺：一次正式渲染只在创建快照时取一次数；任务恢复/重试绝不二次取数，
// 而是复用已冻结的 snapshot.data。

const crypto = () => 's' + Math.random().toString(36).slice(2, 10)

const sources = {
  order: {
    status: 'ready', // ready | updating
    epoch: 1,
    data: {
      orderNo: 'SO-2026-1001',
      total: 1234567.5,
      link: 'https://example.com/orders/SO-2026-1001',
      placedAt: '2026-09-30T20:30:00 UTC',
      badWhen: '2021-02-30',
      customer: { firstName: 'Ana', lastName: 'Lee', idNo: '110101199001011234', phone: '13812345678', email: 'ana@example.com' },
      items: [{ sku: 'A-1', qty: 2 }, { sku: 'B-2', qty: 1 }],
    },
  },
  hr: {
    status: 'ready',
    epoch: 1,
    data: {
      salary: 88888,
      level: 'P6',
    },
  },
}

const waiting = new Map() // sourceKey -> { token, resolve } 模拟"更新完成"回调

export async function fetchSource(sourceKey) {
  const s = sources[sourceKey]
  if (!s) throw Object.assign(new Error(`未知数据源 ${sourceKey}`), { statusCode: 404, code: 'E_UNKNOWN_SOURCE' })
  if (s.status === 'updating') {
    // 数据源更新中：抛出可恢复错误，任务进入 waiting_data，更新完成后被唤醒
    const token = `${sourceKey}:${s.epoch}`
    const promise = new Promise((resolve) => waiting.set(token, resolve))
    const err = new Error(`数据源 ${sourceKey} 正在更新，任务等待恢复`)
    err.code = 'E_SOURCE_UPDATING'
    err.statusCode = 503
    err.waitToken = token
    err.wait = promise
    throw err
  }
  // 返回深拷贝，杜绝快照被外部就地修改
  return { epoch: s.epoch, data: JSON.parse(JSON.stringify(s.data)) }
}

// 测试/管理用：把数据源置为更新中
export function beginUpdate(sourceKey) {
  const s = sources[sourceKey]
  if (!s) return false
  s.status = 'updating'
  s.epoch += 1
  return true
}
// 完成更新并写入新数据，唤醒所有等待任务（它们仍复用旧快照；新版本需新建快照）
export function finishUpdate(sourceKey, nextData) {
  const s = sources[sourceKey]
  if (!s) return false
  s.status = 'ready'
  if (nextData) s.data = nextData
  for (const [token, resolve] of waiting) {
    if (token.startsWith(sourceKey + ':')) { waiting.delete(token); resolve({ epoch: s.epoch }) }
  }
  return true
}
export function sourceState() {
  return Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { status: v.status, epoch: v.epoch }]))
}
