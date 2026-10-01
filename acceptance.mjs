// 端到端验收：嵌套依赖 / 非法日期 / 模板版变更 / 字段无权 / 数据源更新恢复 / 单次取数 / 诊断定位
const BASE = 'http://localhost:4000'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m) } }
const req = async (p, method = 'GET', body) => {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json() }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitStatus = async (tid, until, ms = 6000) => {
  const start = Date.now()
  for (;;) {
    const { json: t } = await req('/api/render-tasks/' + tid)
    if (until(t) || Date.now() - start > ms) return t
    await sleep(150)
  }
}

const TPL = 'tpl_acc'
const defs = [
  { id: 'a', key: 'first', type: 'text', expr: 'order.customer.firstName' },
  { id: 'b', key: 'greet', type: 'text', expr: "concat('Hi ', first)" },
  { id: 'c', key: 'shout', type: 'text', expr: 'upper(greet)' },
  { id: 'd', key: 'amt', type: 'text', expr: "money(order.total, 'CNY')" },
  { id: 'e', key: 'idNo', type: 'text', expr: 'order.customer.idNo', sensitive: true },
  { id: 'f', key: 'badDate', type: 'datetime', expr: "date(order.badWhen)" },
  { id: 'g', key: 'emptyNote', type: 'text', expr: 'order.note', defaultValue: '默认备注' },
]
const SOURCE = '# {{shout}}\n金额 {{amt}}\n证件 {{idNo}}\n日期 {{badDate}}\n备注 [{{emptyNote}}]\n[link]({{orderLink|url}})'
const defsWithLink = [...defs, { id: 'h', key: 'orderLink', type: 'url', expr: 'order.link' }]

console.log('1) 保存模板+变量（嵌套依赖 a->b->c），正常渲染')
{
  const r = await req(`/api/templates/${TPL}`, 'PUT', { name: 'acc', source: SOURCE, variables: defsWithLink })
  ok(r.status === 200 && r.json.version === 1, 'save v1')
  const { json: created } = await req(`/api/templates/${TPL}/render-tasks`, 'POST', { principal: 'alice', deniedPaths: [] })
  const t = await waitStatus(created.taskId, (x) => ['succeeded', 'failed'].includes(x.status))
  ok(t.status === 'succeeded', 'task succeeded, status=' + t.status + ' err=' + JSON.stringify(t.error))
  ok(t.result.html.includes('HI ANA'), 'nested dep rendered: ' + t.result.html)
  ok(t.result.html.includes('CNY 1,234,567.50'), 'money rendered')
  // 敏感：正式产物里存的是未脱敏 html（服务端导出给有权限者），但片段映射标记 secret
  ok(t.result.fragments.some((f) => f.key === 'idNo' && f.secret), 'idNo fragment marked secret')
  // 非法日期诊断定位到变量与引用
  const dd = t.result.diagnostics.find((x) => x.code === 'E_DATE')
  ok(dd && dd.variableKey === 'badDate', 'illegal date located to var: ' + JSON.stringify(dd?.code))
  // 空串：order.note 缺省 -> 数据源里没有 note -> 缺值 -> 默认备注
  ok(t.result.expandedText.includes('[默认备注]'), 'missing -> default, got: ' + t.result.expandedText.match(/备注 \[(.*?)\]/)?.[1])
}

console.log('2) 循环依赖在保存时被拒绝，且诊断含环路径')
{
  const cyc = [
    { id: 'x', key: 'a', type: 'text', expr: 'b' },
    { id: 'y', key: 'b', type: 'text', expr: 'c' },
    { id: 'z', key: 'c', type: 'text', expr: 'a' },
  ]
  const r = await req(`/api/templates/${TPL}`, 'PUT', { name: 'acc', source: '{{a}}', variables: cyc })
  ok(r.status === 400 && r.json.error.code === 'E_CYCLE', 'cycle rejected: ' + r.json.error?.code)
  ok(/a -> b -> c -> a|c -> a/.test(r.json.error.message), 'cycle path in message: ' + r.json.error.message)
}

console.log('3) 字段无权读取：deniedPaths 生效，诊断定位变量+字段')
{
  // 恢复合法模板
  await req(`/api/templates/${TPL}`, 'PUT', { name: 'acc', source: SOURCE, variables: defsWithLink })
  const { json: created } = await req(`/api/templates/${TPL}/render-tasks`, 'POST', { principal: 'bob', deniedPaths: ['order.customer.idNo', 'order.customer.firstName'] })
  const t = await waitStatus(created.taskId, (x) => ['succeeded', 'failed'].includes(x.status))
  ok(t.status === 'succeeded', 'succeeded even with denied')
  const noAccess = t.result.diagnostics.filter((x) => x.code === 'E_NO_ACCESS')
  ok(noAccess.some((x) => x.fieldPath === 'order.customer.idNo'), 'idNo denied diagnosed')
  ok(noAccess.some((x) => x.variableKey === 'first' || x.fieldPath === 'order.customer.firstName'), 'firstName denied located')
  ok(!t.result.html.includes('110101199001011234'), 'denied secret not leaked')
}

console.log('4) 共享预览脱敏')
{
  const { json: created } = await req(`/api/templates/${TPL}/render-tasks`, 'POST', { principal: 'alice', deniedPaths: [] })
  const t = await waitStatus(created.taskId, (x) => x.status === 'succeeded')
  const { json: shared } = await req('/api/shared/' + t.shareToken + '?viewer=carol')
  ok(shared.redacted, 'shared flagged redacted')
  ok(!shared.html.includes('13812345678'), 'phone masked in share')
  ok(shared.html.includes('已脱敏'), 'placeholder present')
}

console.log('5) 数据源更新中 -> 任务等待 -> 完成更新 -> 恢复成功（复用同一任务，快照仅取一次数）')
{
  await req('/api/sources/order/begin-update', 'POST', {})
  const { json: created, status } = await req(`/api/templates/${TPL}/render-tasks`, 'POST', { principal: 'alice', deniedPaths: [] })
  ok(status === 202, 'accepted while updating')
  let t = await waitStatus(created.taskId, (x) => x.status === 'waiting_data', 4000)
  ok(t.status === 'waiting_data', 'task waiting_data, got ' + t.status)
  ok(t.snapshotId == null, 'no snapshot while waiting')
  // 更新完成写入新数据（新订单号）
  await req('/api/sources/order/finish-update', 'POST', { data: {
    orderNo: 'SO-NEW-9999', total: 1, link: 'https://example.com/x', placedAt: '2026-09-30T20:30:00 UTC',
    customer: { firstName: 'New', lastName: 'Guy', idNo: '999', phone: '13900000000', email: 'n@x.com' },
  }})
  t = await waitStatus(created.taskId, (x) => ['succeeded', 'failed'].includes(x.status), 6000)
  ok(t.status === 'succeeded', 'recovered to succeeded, got ' + t.status)
  ok(t.result.html.includes('HI NEW'), 'recovered uses post-update data: ' + t.result.html)
  const { json: logs } = await req(`/api/render-tasks/${created.taskId}/logs`)
  const waitEv = logs.logs.some((l) => l.event === 'task.waiting_data')
  const resumeEv = logs.logs.some((l) => l.event === 'task.resumed')
  const snapCreated = logs.logs.filter((l) => l.event === 'task.snapshot_fetched').length
  ok(waitEv && resumeEv, 'wait+resume logged')
  ok(snapCreated === 1, 'exactly one snapshot fetch (' + snapCreated + ')')
}

console.log('6) 模板版变更：旧快照任务渲染时标记 template_stale，不混用旧文稿')
{
  // 先在数据 ready 时取一个快照并成功
  const { json: c1 } = await req(`/api/templates/${TPL}/render-tasks`, 'POST', { principal: 'alice', deniedPaths: [] })
  const t1 = await waitStatus(c1.taskId, (x) => x.status === 'succeeded')
  const snapId = t1.snapshotId
  // 直接修改模板文稿产生 v?（保存）；然后手工把任务指向旧快照并 resume：
  // 通过再保存一次模板升版本
  const cur = (await req(`/api/templates/${TPL}`)).json.version
  await req(`/api/templates/${TPL}`, 'PUT', { name: 'acc', source: SOURCE + '\n\n新增一段 v' + (cur + 1), variables: defsWithLink })
  // 用旧快照 id 构造不了任务（API 自动取新快照），所以这里验证：新任务基于新版本快照成功，
  // 而把"旧快照 + 新模板版本"通过 DB 约束路径的等价行为由 service 检查。
  const { json: c2 } = await req(`/api/templates/${TPL}/render-tasks`, 'POST', { principal: 'alice', deniedPaths: [] })
  const t2 = await waitStatus(c2.taskId, (x) => ['succeeded', 'failed', 'template_stale'].includes(x.status))
  ok(t2.status === 'succeeded' && t2.templateVersion === cur + 1, 'new task on new version, v=' + t2.templateVersion)
  ok(t2.snapshotId !== snapId, 'new snapshot for new version (no mixing)')

  // 关键：用「旧快照」对「新版本模板」建回放任务 -> 必须 template_stale，且不产出混用文稿
  const { json: rep, status: repStatus } = await req(`/api/templates/${TPL}/replay-snapshot`, 'POST', { snapshotId: snapId, principal: 'alice' })
  ok(repStatus === 202, 'replay accepted')
  const t3 = await waitStatus(rep.taskId, (x) => ['succeeded', 'failed', 'template_stale'].includes(x.status))
  ok(t3.status === 'template_stale', 'old snapshot + new template -> template_stale, got ' + t3.status)
  ok(t3.error?.code === 'E_TEMPLATE_STALE', 'stale error code')
  ok(t3.snapshotId === snapId, 'replay reused old snapshot (no re-fetch)')
  ok(!t3.result, 'stale task produced no mixed document')
  ok(t3.error?.snapshotVersion === cur && t3.error?.currentVersion === cur + 1,
    `versions diagnosed snap=${t3.error?.snapshotVersion} cur=${t3.error?.currentVersion}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
